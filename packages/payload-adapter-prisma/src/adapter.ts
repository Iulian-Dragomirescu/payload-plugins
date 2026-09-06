import type { BaseDatabaseAdapter, DatabaseAdapterObj, Payload } from "payload";

import { buildMappings, readCollectionMapping, readGlobalMapping } from "./mapping/build.js";
import type { ModelMapping } from "./mapping/types.js";
import * as prismaOps from "./operations.js";
import type { PrismaClientLike, PrismaContext } from "./operations.js";
import type { SchemaSource } from "./schema/load.js";
import { loadDatamodel } from "./schema/load.js";

/** What {@link prismaAdapter} takes. */
export interface PrismaAdapterArgs {
  /**
   * The app's generated Prisma client.
   *
   * The adapter opens no connection of its own, so the app's pooling, logging,
   * extensions and middleware all still apply, and there is one pool against
   * your database rather than two.
   */
  prisma: PrismaClientLike;
  /**
   * The adapter that stores everything Payload needs and your schema does not.
   *
   * Any Payload database adapter. It receives every collection that is not
   * mapped onto a Prisma model, plus Payload's own machinery: versions and
   * drafts, unmapped globals, admin preferences, document locks, migrations,
   * job queues. It may create whatever tables it needs, because none of them
   * are in your database.
   */
  internal: DatabaseAdapterObj;
  /**
   * Where to read the Prisma datamodel from.
   *
   * @defaultValue `{ path: "./prisma/schema.prisma" }`
   */
  schema?: SchemaSource;
  /**
   * Whether to let the internal adapter open transactions.
   *
   * A transaction the internal adapter opens covers only the writes that go to
   * it. A request that saves a document and its version writes to both
   * databases, so rolling back the internal half would leave the Prisma half
   * committed while looking like a clean rollback.
   *
   * Turn it on only when your Prisma-backed collections have no versions and no
   * drafts, so no single request spans both stores.
   *
   * @defaultValue `false`
   */
  transactions?: boolean;
}

/**
 * Payload database methods routed on `args.collection`. Anything not listed
 * here or in {@link ROUTED_GLOBALS} goes to the internal adapter.
 *
 * `queryDrafts` is deliberately NOT here: a draft is a row in the versions
 * store, so querying drafts hits the internal database even for a collection
 * whose published documents live in Prisma.
 */
const ROUTED = [
  "count",
  "create",
  "deleteMany",
  "deleteOne",
  "find",
  "findDistinct",
  "findOne",
  "updateMany",
  "updateOne",
  "upsert",
] as const;

/**
 * Payload database methods routed on `args.slug` rather than `args.collection`,
 * which is the only reason they need a list of their own.
 *
 * The global version methods are absent for the same reason `queryDrafts` is.
 */
const ROUTED_GLOBALS = ["createGlobal", "findGlobal", "updateGlobal"] as const;

/**
 * Builds a Payload database adapter that reads and writes your Prisma schema.
 *
 * A collection or global carrying `custom.prisma` is a view onto a Prisma
 * model; every other config, including the ones Payload adds itself, goes to
 * the internal adapter along with all of Payload's own state.
 *
 * **The adapter issues no DDL against your database.** It creates no table,
 * adds no column, and writes no migration.
 *
 * @param args - The Prisma client, the internal adapter, and where the schema is.
 * @returns The adapter, for `buildConfig({ db })`.
 *
 * @example
 * ```ts
 * import { mongooseAdapter } from "@payloadcms/db-mongodb";
 * import { prismaAdapter } from "payload-adapter-prisma";
 * import { buildConfig } from "payload";
 * import { PrismaClient } from "./generated/prisma/client";
 *
 * export default buildConfig({
 *   collections: [Posts, Authors],
 *   db: prismaAdapter({
 *     prisma: new PrismaClient({ adapter }),
 *     internal: mongooseAdapter({ url: process.env.PAYLOAD_INTERNAL_URL! }),
 *   }),
 * });
 * ```
 */
export function prismaAdapter(args: PrismaAdapterArgs): DatabaseAdapterObj {
  return {
    // Ids are strings at the Payload boundary whatever the column's type, so one
    // rule covers `cuid()`, `uuid()`, `Int` and `BigInt`, and it matches what the
    // internal store does: a relationship value means the same thing on both
    // sides of the split. They are coerced back at the database boundary.
    defaultIDType: "text",
    name: "prisma",
    init: ({ payload }: { payload: Payload }): BaseDatabaseAdapter => {
      const internal = args.internal.init({ payload });

      const datamodel = loadDatamodel({ schema: args.schema });
      const { collections: mappings, globals } = buildMappings({
        collections: payload.config.collections,
        globals: payload.config.globals,
        datamodel,
      });

      // Collections only. A dotted query path travels a relation to another
      // collection, and nothing points at a global.
      const byModel = new Map<string, ModelMapping>();
      for (const mapping of mappings.values()) byModel.set(mapping.model, mapping);

      const context: PrismaContext = { prisma: args.prisma, mappings, globals, byModel };

      // The internal adapter is handed the whole config, so that versions and
      // drafts of a mapped collection have somewhere to go, and would otherwise
      // materialise empty storage for the mapped collections as well. Adapters
      // that do not understand this option ignore it.
      const schemaOptions = internal as {
        collectionsSchemaOptions?: Record<string, Record<string, unknown>>;
      };
      const options = schemaOptions.collectionsSchemaOptions ?? {};
      for (const slug of mappings.keys()) {
        options[slug] = { autoCreate: false, autoIndex: false, ...options[slug] };
      }
      schemaOptions.collectionsSchemaOptions = options;

      const isMapped = (slug: unknown): boolean =>
        typeof slug === "string" && mappings.has(slug);

      const isMappedGlobal = (slug: unknown): boolean =>
        typeof slug === "string" && globals.has(slug);

      const overrides: Record<string, unknown> = {
        defaultIDType: "text",
        name: "prisma",
        packageName: "payload-adapter-prisma",
        payload,
        // Returning null is how a Payload adapter says it has no transactions.
        // See `transactions` above for why that is the default.
        ...(args.transactions === true
          ? {}
          : { beginTransaction: () => Promise.resolve(null) }),
      };

      for (const method of ROUTED) {
        overrides[method] = (callArgs: { collection?: string }) =>
          isMapped(callArgs.collection)
            ? (prismaOps[method] as (c: PrismaContext, a: unknown) => unknown)(context, callArgs)
            : (internal[method] as (a: unknown) => unknown)(callArgs);
      }

      for (const method of ROUTED_GLOBALS) {
        overrides[method] = (callArgs: { slug?: string }) =>
          isMappedGlobal(callArgs.slug)
            ? (prismaOps[method] as (c: PrismaContext, a: unknown) => unknown)(context, callArgs)
            : (internal[method] as (a: unknown) => unknown)(callArgs);
      }

      // A Proxy rather than a spread: the internal adapter assigns its own state
      // lazily, `connection` during `connect()` and `sessions` during a
      // transaction. A copy taken here would freeze the object before any of
      // that exists, and every delegated call would run against an adapter that
      // had never connected.
      return new Proxy(internal, {
        get(target, property, receiver) {
          if (property in overrides) return overrides[property as string];
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? (value as CallableFunction).bind(target) : value;
        },
        has(target, property) {
          return property in overrides || Reflect.has(target, property);
        },
        set(target, property, value) {
          return Reflect.set(target, property, value);
        },
      }) as BaseDatabaseAdapter;
    },
  };
}

/**
 * Lists which database each collection and global will be stored in.
 *
 * A typo in `custom` moves a config to the other database with no error at all,
 * so printing this at startup, or asserting it in a test, is what makes the
 * split visible.
 *
 * @param props - Input props.
 * @param props.payload - The initialized Payload instance.
 * @returns Slugs grouped by where they live. Globals are prefixed `global:`,
 *   because a collection and a global may share a slug.
 *
 * @example
 * ```ts
 * console.table(describeStorage({ payload }));
 * // → { prisma: ["posts", "authors", "global:siteSettings"],
 * //     internal: ["admins", "payload-preferences", …] }
 * ```
 */
export function describeStorage(props: { payload: Payload }): {
  internal: string[];
  prisma: string[];
} {
  const prisma: string[] = [];
  const internal: string[] = [];

  /** Whether a config is Prisma-backed, treating a malformed mapping as not. */
  const isMapped = (read: () => unknown): boolean => {
    try {
      return read() !== undefined;
    } catch {
      return false;
    }
  };

  for (const collection of props.payload.config.collections) {
    const mapped = isMapped(() => readCollectionMapping({ collection }));
    (mapped ? prisma : internal).push(collection.slug);
  }
  for (const global of props.payload.config.globals) {
    const mapped = isMapped(() => readGlobalMapping({ global }));
    (mapped ? prisma : internal).push(`global:${global.slug}`);
  }

  return { internal, prisma };
}
