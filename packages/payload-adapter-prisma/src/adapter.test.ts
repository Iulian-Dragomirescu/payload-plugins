import type { BaseDatabaseAdapter, DatabaseAdapterObj, Payload } from "payload";
import { describe, expect, it, vi } from "vitest";

import { PrismaAdapterIdTypeError, prismaAdapter } from "./adapter.js";
import { parsePrismaSchema } from "./schema/parseSchema.js";

/**
 * Payload keeps ONE `db.defaultIDType` for the whole config, and this adapter
 * is what answers it. A relationship's id is validated as
 * `collections[slug].customIDType || db.defaultIDType`, so an internal adapter
 * with numeric ids has every id it stores validated as text.
 *
 * What that looks like is not an id error. `payload-preferences.user` fails
 * validation on every list view, so the admin panel's lists come back empty and
 * the message names a field called "User".
 */

const datamodel = parsePrismaSchema({
  source: "model BlogPost {\n  id String @id @default(cuid())\n  title String\n}",
});

/** A stand-in for whatever adapter is keeping Payload's own state. */
function internalAdapter(defaultIDType: "number" | "text"): DatabaseAdapterObj {
  return {
    defaultIDType,
    init: () => ({ name: "internal", packageName: "internal" }) as unknown as BaseDatabaseAdapter,
  } as DatabaseAdapterObj;
}

/** The parts of an initializing Payload the adapter reads. */
function payloadWith(props: { slugs: { slug: string; mapped?: boolean; customIDType?: string }[] }) {
  const collections = props.slugs.map((entry) => ({
    slug: entry.slug,
    fields: [{ name: "title", type: "text" }],
    flattenedFields: [{ name: "title", type: "text" }],
    ...(entry.mapped === true ? { custom: { prisma: { model: "BlogPost" } } } : {}),
  }));

  const registry: Record<string, { customIDType?: string }> = {};
  for (const entry of props.slugs) {
    registry[entry.slug] =
      entry.customIDType === undefined ? {} : { customIDType: entry.customIDType };
  }

  return {
    collections: registry,
    config: { collections, globals: [] },
    logger: { info: vi.fn(), warn: vi.fn() },
  } as unknown as Payload & { collections: Record<string, { customIDType?: string }> };
}

/** Initializes the adapter over a stub schema, returning the payload it saw. */
function init(props: {
  internalIDType: "number" | "text";
  idTypeMismatch?: "error" | "ignore" | "reconcile";
}) {
  const payload = payloadWith({
    slugs: [
      { mapped: true, slug: "posts" },
      { slug: "admins" },
      { slug: "payload-preferences" },
    ],
  });

  prismaAdapter({
    prisma: {},
    internal: internalAdapter(props.internalIDType),
    schema: { datamodel },
    ...(props.idTypeMismatch !== undefined ? { idTypeMismatch: props.idTypeMismatch } : {}),
  }).init({ payload });

  return payload;
}

describe("id types across the two databases", () => {
  it("reports text, because ids are strings above the adapter", () => {
    expect(
      prismaAdapter({ prisma: {}, internal: internalAdapter("text") }).defaultIDType,
    ).toBe("text");
  });

  it("sets `customIDType` on the collections the internal adapter stores", () => {
    const payload = init({ internalIDType: "number" });

    // Payload consults this AHEAD of `db.defaultIDType`, so it is what makes
    // `payload-preferences.user` validate a numeric admin id.
    expect(payload.collections.admins?.customIDType).toBe("number");
    expect(payload.collections["payload-preferences"]?.customIDType).toBe("number");
  });

  it("never gives a mapped collection the internal adapter's id type", () => {
    const payload = init({ internalIDType: "number" });
    expect(payload.collections.posts?.customIDType).toBe("text");
  });

  it("declares an `id` field on every mapped collection", () => {
    // The per-collection answer to "what shape is an id". Payload derives
    // `customIDType` from it, and `@payloadcms/db-mongodb` reads it to decide
    // whether to cast a relationship's value to an ObjectId. Without it a lock
    // on a saved document throws from inside BSON.
    const payload = init({ internalIDType: "text" });
    const posts = payload.config.collections.find((entry) => entry.slug === "posts");

    expect(posts?.fields).toContainEqual(
      expect.objectContaining({ name: "id", type: "text" }),
    );
    expect(payload.collections.posts?.customIDType).toBe("text");
  });

  it("hides the field it declares, since the database supplies the value", () => {
    const payload = init({ internalIDType: "text" });
    const id = payload.config.collections
      .find((entry) => entry.slug === "posts")
      ?.fields.find((field) => "name" in field && field.name === "id");

    expect((id as { admin?: { hidden?: boolean } }).admin?.hidden).toBe(true);
  });

  it("declares nothing on the collections the internal adapter stores", () => {
    // Their ids are the internal adapter's to shape, and saying "text" here
    // would be the original bug with the sides swapped.
    const payload = init({ internalIDType: "number" });
    const admins = payload.config.collections.find((entry) => entry.slug === "admins");

    expect(admins?.fields).not.toContainEqual(expect.objectContaining({ name: "id" }));
  });

  it("leaves a collection that declares its own `id` alone", () => {
    const payload = payloadWith({ slugs: [{ mapped: true, slug: "posts" }] });
    const posts = payload.config.collections[0] as unknown as { fields: unknown[] };
    posts.fields.push({ name: "id", type: "number" });

    prismaAdapter({
      prisma: {},
      internal: internalAdapter("text"),
      schema: { datamodel },
    }).init({ payload });

    // One `id`, still the config's own. Declaring it is the config's call and
    // it made it first.
    expect(posts.fields.filter((field) => (field as { name: string }).name === "id")).toEqual([
      { name: "id", type: "number" },
    ]);
  });

  it("says what it did and why", () => {
    const payload = init({ internalIDType: "number" });
    expect(payload.logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/customIDType: "number"[\s\S]*rejects every relationship/),
    );
  });

  it("does nothing when both databases agree", () => {
    const payload = init({ internalIDType: "text" });
    expect(payload.collections.admins?.customIDType).toBeUndefined();
    expect(payload.logger.info).not.toHaveBeenCalled();
  });

  it("does not overwrite a collection that declares its own id", () => {
    const payload = payloadWith({
      slugs: [
        { mapped: true, slug: "posts" },
        { customIDType: "text", slug: "admins" },
      ],
    });

    prismaAdapter({
      prisma: {},
      internal: internalAdapter("number"),
      schema: { datamodel },
    }).init({ payload });

    expect(payload.collections.admins?.customIDType).toBe("text");
  });

  it("refuses to start when asked to, naming both adapters and both types", () => {
    expect(() => init({ idTypeMismatch: "error", internalIDType: "number" })).toThrow(
      PrismaAdapterIdTypeError,
    );
    expect(() => init({ idTypeMismatch: "error", internalIDType: "number" })).toThrow(
      /defaultIDType: "text"[\s\S]*defaultIDType: "number"[\s\S]*idType: "uuid"/,
    );
  });

  it("leaves it alone when told to", () => {
    const payload = init({ idTypeMismatch: "ignore", internalIDType: "number" });
    expect(payload.collections.admins?.customIDType).toBeUndefined();
  });
});

describe("what the internal adapter is shown", () => {
  /** Records the config the internal adapter was initialized with, and keeps it. */
  function recordingInternal(): {
    adapter: DatabaseAdapterObj;
    instance: () => { payload?: Payload };
    seen: () => string[] | undefined;
  } {
    let slugs: string[] | undefined;
    let instance: { payload?: Payload } = {};
    return {
      instance: () => instance,
      seen: () => slugs,
      adapter: {
        defaultIDType: "text",
        init: ({ payload }: { payload: Payload }) => {
          slugs = payload.config.collections.map((collection) => collection.slug);
          // The real adapters build their storage later, in their own `init()`,
          // off whatever `this.payload` holds by then.
          instance = { name: "internal", packageName: "internal", payload } as unknown as {
            payload?: Payload;
          };
          return instance as unknown as BaseDatabaseAdapter;
        },
      } as DatabaseAdapterObj,
    };
  }

  const payloadFor = () =>
    payloadWith({ slugs: [{ mapped: true, slug: "posts" }, { slug: "admins" }] });

  it("hands it the whole config by default", () => {
    // Versions, drafts and document locks of a mapped collection are stored by
    // the internal adapter, and it can only do that if it knows the collection.
    const internal = recordingInternal();
    prismaAdapter({ prisma: {}, internal: internal.adapter, schema: { datamodel } }).init({
      payload: payloadFor(),
    });

    expect(internal.seen()).toEqual(["posts", "admins"]);
  });

  it("hides the mapped collections when asked, so nothing empty is created", () => {
    const internal = recordingInternal();
    prismaAdapter({
      prisma: {},
      internal: internal.adapter,
      internalCollections: "unmapped",
      schema: { datamodel },
    }).init({ payload: payloadFor() });

    expect(internal.seen()).toEqual(["admins"]);
  });

  it("keeps the filtered view after Payload assigns itself onto the adapter", () => {
    // `payload.db.payload = payload` runs right after `init`, and the internal
    // adapter builds its storage later, in its own `init()`. Letting that
    // assignment through would put the mapped collections back.
    const internal = recordingInternal();
    const payload = payloadFor();
    const db = prismaAdapter({
      prisma: {},
      internal: internal.adapter,
      internalCollections: "unmapped",
      schema: { datamodel },
    }).init({ payload });

    (db as unknown as { payload: Payload }).payload = payload;

    // What the adapter reports outwards is the real Payload...
    const reported = (db as unknown as { payload: Payload }).payload;
    expect(reported.config.collections.map((entry) => entry.slug)).toEqual(["posts", "admins"]);

    // ...while the internal adapter it wraps still holds the filtered view, so
    // its own `init()` builds storage for "admins" and nothing else.
    const kept = internal.instance().payload;
    expect(kept?.config.collections.map((entry) => entry.slug)).toEqual(["admins"]);
  });
});
