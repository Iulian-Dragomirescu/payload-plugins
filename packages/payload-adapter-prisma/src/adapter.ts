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
  /**
   * What to do when the internal adapter's ids are not text.
   *
   * Payload keeps one `db.defaultIDType` for the whole config, and this adapter
   * reports `"text"`. An internal adapter with numeric ids, which is
   * `postgresAdapter` without `idType`, then has every id it stores validated
   * as text and rejected.
   *
   * - `"reconcile"` sets `customIDType` on the collections routed to the
   *   internal adapter, which Payload consults ahead of `db.defaultIDType`.
   * - `"error"` refuses to start and names both adapters and both types.
   * - `"ignore"` leaves it alone.
   *
   * @defaultValue `"reconcile"`
   */
  idTypeMismatch?: "error" | "ignore" | "reconcile";
  /**
   * Which collections the internal adapter is shown.
   *
   * `"all"` hands it the whole config, so an adapter in push mode materialises
   * empty storage for the Prisma-backed collections too. They are never read,
   * but they are there, which reads as a broken promise.
   *
   * `"unmapped"` hides the mapped collections from it. That also takes away the
   * places their versions, drafts, document locks and admin preferences would
   * be stored, so it only fits a config where the mapped collections have none
   * of those.
   *
   * @defaultValue `"all"`
   */
  internalCollections?: "all" | "unmapped";
}

/**
 * The id type this adapter reports for the whole config.
 *
 * Ids are strings above the adapter whatever the column's type, so one rule
 * covers `cuid()`, `uuid()`, `Int` and `BigInt`, and a relationship value means
 * the same thing on both sides of the split. They are coerced back at the
 * database boundary.
 */
const ADAPTER_ID_TYPE = "text";

/** Raised at startup when the two databases disagree about ids. */
export class PrismaAdapterIdTypeError extends Error {
  constructor(message: string) {
    super(`[prisma-adapter] ${message}`);
    this.name = "PrismaAdapterIdTypeError";
  }
}

/**
 * Settles the id types of the two databases before anything reads them.
 *
 * Payload resolves a relationship's id type as
 * `collections[slug].customIDType || db.defaultIDType`, and `db` is this
 * adapter, so without this every collection the internal adapter stores is
 * validated as text. With numeric ids that fails on `payload-preferences.user`,
 * which is written on every list view, and the admin panel's lists come back
 * empty with a validation error that mentions neither ids nor adapters.
 *
 * @param props - Input props.
 * @param props.payload - The initializing Payload instance.
 * @param props.mappings - The Prisma-backed collections, which keep text ids.
 * @param props.internalIDType - What the internal adapter reports.
 * @param props.mode - What to do about a mismatch.
 * @throws {PrismaAdapterIdTypeError} When `mode` is `"error"` and they disagree.
 */
function reconcileIdTypes(props: {
  payload: Payload;
  mappings: Map<string, ModelMapping>;
  internalIDType: "number" | "text";
  mode: "error" | "ignore" | "reconcile";
}): void {
  const { payload, mappings, internalIDType, mode } = props;
  if (internalIDType === ADAPTER_ID_TYPE || mode === "ignore") return;

  // A collection declaring its own `id` field already has the right answer, and
  // it is the config's to make.
  const affected = payload.config.collections
    .map((collection) => collection.slug)
    .filter(
      (slug) => !mappings.has(slug) && payload.collections[slug]?.customIDType === undefined,
    );
  if (affected.length === 0) return;

  if (mode === "error") {
    throw new PrismaAdapterIdTypeError(
      `The two databases disagree about id types.\n\n` +
        `  this adapter        defaultIDType: "${ADAPTER_ID_TYPE}"\n` +
        `  the internal one    defaultIDType: "${internalIDType}"\n\n` +
        `Payload keeps one \`db.defaultIDType\` for the whole config, and it is this ` +
        `adapter's, so every id the internal adapter stores is validated as ` +
        `"${ADAPTER_ID_TYPE}" and rejected. It shows up as an empty admin list view: ` +
        `\`payload-preferences.user\` fails validation on every write, so the list cannot ` +
        `save its column state.\n\n` +
        `Give the internal adapter text ids:\n\n` +
        `  internal: postgresAdapter({ idType: "uuid", pool: { … } })\n\n` +
        `or let this adapter set \`customIDType: "${internalIDType}"\` on the ` +
        `${affected.length} collections it stores:\n\n` +
        `  prismaAdapter({ …, idTypeMismatch: "reconcile" })`,
    );
  }

  for (const slug of affected) {
    const entry = payload.collections[slug];
    if (entry !== undefined) entry.customIDType = internalIDType;
  }

  payload.logger.info(
    `[prisma-adapter] The internal adapter stores ${internalIDType} ids and this adapter ` +
      `reports ${ADAPTER_ID_TYPE}, so \`customIDType: "${internalIDType}"\` was set on the ` +
      `${affected.length} collections it stores. Without it Payload validates their ids as ` +
      `${ADAPTER_ID_TYPE} and rejects every relationship pointing at one. ` +
      `Pass \`idTypeMismatch: "error"\` to refuse to start instead.`,
  );
}

/**
 * Hides the Prisma-backed collections from the internal adapter.
 *
 * A Proxy over `payload` rather than a copy: the internal adapter keeps the one
 * it is handed and reads live state off it for the whole process.
 *
 * @param props - Input props.
 * @param props.payload - The real Payload instance.
 * @param props.mappings - The collections to hide.
 * @returns A view of `payload` whose `config.collections` holds only the rest.
 */
function withoutMappedCollections(props: {
  payload: Payload;
  mappings: Map<string, ModelMapping>;
}): Payload {
  const { payload, mappings } = props;
  const config = {
    ...payload.config,
    collections: payload.config.collections.filter(
      (collection) => !mappings.has(collection.slug),
    ),
  };

  return new Proxy(payload, {
    get(target, property, receiver) {
      if (property === "config") return config;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as CallableFunction).bind(target) : value;
    },
  });
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
    defaultIDType: ADAPTER_ID_TYPE,
    name: "prisma",
    init: ({ payload }: { payload: Payload }): BaseDatabaseAdapter => {
      const datamodel = loadDatamodel({ schema: args.schema });
      const { collections: mappings, globals } = buildMappings({
        collections: payload.config.collections,
        globals: payload.config.globals,
        datamodel,
      });

      reconcileIdTypes({
        payload,
        mappings,
        internalIDType: args.internal.defaultIDType,
        mode: args.idTypeMismatch ?? "reconcile",
      });

      for (const mapping of [...mappings.values(), ...globals.values()]) {
        if (mapping.uncreatable.length === 0) continue;
        payload.logger.warn(
          `[prisma-adapter] ${mapping.kind === "global" ? "Global" : "Collection"} ` +
            `"${mapping.slug}" can be read but not created: ` +
            `${mapping.uncreatable.map((column) => `"${mapping.model}.${column}"`).join(", ")} ` +
            `${mapping.uncreatable.length === 1 ? "is" : "are"} non-null with no default, and ` +
            `no field writes ${mapping.uncreatable.length === 1 ? "it" : "them"}.`,
        );
      }

      const internalPayload =
        args.internalCollections === "unmapped"
          ? withoutMappedCollections({ payload, mappings })
          : payload;

      const internal = args.internal.init({ payload: internalPayload });

      // Collections only. A dotted query path travels a relation to another
      // collection, and nothing points at a global.
      const byModel = new Map<string, ModelMapping>();
      for (const mapping of mappings.values()) byModel.set(mapping.model, mapping);

      const context: PrismaContext = { prisma: args.prisma, mappings, globals, byModel };

      // Mongoose's own way of being told not to materialise a collection. It
      // stays useful even under `internalCollections: "unmapped"`, which some
      // adapters ignore. Adapters that do not understand this option ignore it.
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
        defaultIDType: ADAPTER_ID_TYPE,
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
          // Payload assigns itself onto the adapter right after `init`, and the
          // internal adapter builds its storage later, in its own `init()`. It
          // has to still be looking at the filtered config by then, or it would
          // materialise the mapped collections after all.
          if (property === "payload" && internalPayload !== payload) {
            return Reflect.set(target, property, internalPayload);
          }
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
