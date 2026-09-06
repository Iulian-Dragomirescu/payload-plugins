import type { SanitizedGlobalConfig } from "payload";
import { describe, expect, it } from "vitest";

import { buildGlobalMapping } from "./mapping/build.js";
import type { ModelMapping } from "./mapping/types.js";
import { createGlobal, findGlobal, updateGlobal } from "./operations.js";
import type { PrismaContext } from "./operations.js";
import { parsePrismaSchema } from "./schema/parseSchema.js";

/**
 * A global is a singleton and a table is not, so something has to say which row
 * the global IS. These tests pin that rule down: **the first row, by primary
 * key**, narrowed by `where` when one table holds several singletons.
 *
 * They run against a recording stub, because what is checked is the query: that
 * the read is ordered, and that the discriminator is written on create as well
 * as matched on read. A real database with one row in the table would answer
 * correctly for the wrong query too.
 */

const datamodel = parsePrismaSchema({
  source: `
model SiteSetting {
  id    String @id @default(cuid())
  title String
}
model Setting {
  id    String @id @default(cuid())
  key   String @unique
  title String
}
`,
});

/** Builds the minimum of a sanitized global the mapper reads. */
function mappingFor(props: { model: string; where?: Record<string, unknown> }): ModelMapping {
  return buildGlobalMapping({
    datamodel,
    global: {
      slug: "siteSettings",
      custom: { prisma: { model: props.model, ...(props.where ? { where: props.where } : {}) } },
      flattenedFields: [
        { name: "title", type: "text" },
        // Payload adds both to every global; neither table has them.
        { name: "updatedAt", type: "date" },
        { name: "createdAt", type: "date" },
      ],
    } as unknown as SanitizedGlobalConfig,
  });
}

/** A Prisma client that records what it was asked and answers from a script. */
function stub(props: { mapping: ModelMapping; rows: Record<string, unknown>[] }) {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const rows = [...props.rows];

  const delegate = {
    findFirst: (args: Record<string, unknown>) => {
      calls.push({ method: "findFirst", args });
      return Promise.resolve(rows[0] ?? null);
    },
    create: (args: Record<string, unknown>) => {
      calls.push({ method: "create", args });
      const row = { id: "created", ...(args.data as Record<string, unknown>) };
      rows.push(row);
      return Promise.resolve(row);
    },
    update: (args: Record<string, unknown>) => {
      calls.push({ method: "update", args });
      const row = { ...rows[0], ...(args.data as Record<string, unknown>) };
      rows[0] = row;
      return Promise.resolve(row);
    },
    count: () => Promise.resolve(rows.length),
    delete: () => Promise.resolve(rows[0] as Record<string, unknown>),
    deleteMany: () => Promise.resolve({ count: 0 }),
    findMany: () => Promise.resolve(rows),
  };

  const context: PrismaContext = {
    prisma: { [props.mapping.delegate]: delegate },
    mappings: new Map(),
    globals: new Map([[props.mapping.slug, props.mapping]]),
    byModel: new Map(),
  };

  return { calls, context, rows };
}

describe("findGlobal", () => {
  it("reads the FIRST row, ordered by primary key", async () => {
    const mapping = mappingFor({ model: "SiteSetting" });
    const { calls, context } = stub({ mapping, rows: [{ id: "a", title: "Stored" }] });

    const doc = await findGlobal(context, { slug: "siteSettings" });

    expect(doc).toMatchObject({ globalType: "siteSettings", id: "a", title: "Stored" });
    // Unordered, "the first row" is whatever the planner returns, which can
    // differ between two identical requests.
    expect(calls[0]?.args.orderBy).toEqual([{ id: "asc" }]);
  });

  it("returns null for an empty table rather than failing", async () => {
    // Payload reads this as "not saved yet", shows the config defaults, and
    // creates the row on the first save. That is what makes the table
    // self-initialising.
    const mapping = mappingFor({ model: "SiteSetting" });
    const { context } = stub({ mapping, rows: [] });

    expect(await findGlobal(context, { slug: "siteSettings" })).toBeNull();
  });

  it("narrows to the global's own row when the table holds several", async () => {
    const mapping = mappingFor({ model: "Setting", where: { key: "site" } });
    const { calls, context } = stub({ mapping, rows: [{ id: "a", title: "Site" }] });

    await findGlobal(context, { slug: "siteSettings" });
    expect(calls[0]?.args.where).toEqual({ key: "site" });
  });

  it("ANDs Payload's access filter with the singleton's own", async () => {
    const mapping = mappingFor({ model: "Setting", where: { key: "site" } });
    const { calls, context } = stub({ mapping, rows: [{ id: "a", title: "Site" }] });

    await findGlobal(context, {
      slug: "siteSettings",
      where: { title: { equals: "Site" } },
    });

    // An access rule that silently did not apply would be worse than one that
    // was never written.
    expect(calls[0]?.args.where).toEqual({
      AND: [{ key: "site" }, { title: { equals: "Site" } }],
    });
  });
});

describe("createGlobal", () => {
  it("writes the discriminator, so the next read finds the row it made", async () => {
    const mapping = mappingFor({ model: "Setting", where: { key: "site" } });
    const { calls, context } = stub({ mapping, rows: [] });

    await createGlobal(context, { slug: "siteSettings", data: { title: "First" } });

    expect(calls[0]?.args.data).toEqual({ key: "site", title: "First" });
  });

  it("drops the timestamps Payload adds but the table does not have", async () => {
    const mapping = mappingFor({ model: "SiteSetting" });
    const { calls, context } = stub({ mapping, rows: [] });

    await createGlobal(context, {
      slug: "siteSettings",
      data: { createdAt: "2024-01-01", title: "First", updatedAt: "2024-01-01" },
    });

    expect(calls[0]?.args.data).toEqual({ title: "First" });
  });
});

describe("updateGlobal", () => {
  it("updates the existing row by its id", async () => {
    const mapping = mappingFor({ model: "SiteSetting" });
    const { calls, context } = stub({ mapping, rows: [{ id: "a", title: "Old" }] });

    const doc = await updateGlobal(context, { slug: "siteSettings", data: { title: "New" } });

    expect(calls.map((call) => call.method)).toEqual(["findFirst", "update"]);
    expect(calls[1]?.args.where).toEqual({ id: "a" });
    expect(doc).toMatchObject({ title: "New" });
  });

  it("creates the row when the table is still empty", async () => {
    // Payload decides between create and update from a read earlier in the
    // request. Between that read and this write the row can be gone, and a
    // global that quietly fails to save is worse than one that re-creates it.
    const mapping = mappingFor({ model: "SiteSetting" });
    const { calls, context } = stub({ mapping, rows: [] });

    const doc = await updateGlobal(context, { slug: "siteSettings", data: { title: "New" } });

    expect(calls.map((call) => call.method)).toEqual(["findFirst", "create"]);
    expect(doc).toMatchObject({ title: "New" });
  });

  it("never inserts a second row", async () => {
    const mapping = mappingFor({ model: "SiteSetting" });
    const { context, rows } = stub({ mapping, rows: [] });

    await updateGlobal(context, { slug: "siteSettings", data: { title: "One" } });
    await updateGlobal(context, { slug: "siteSettings", data: { title: "Two" } });
    await updateGlobal(context, { slug: "siteSettings", data: { title: "Three" } });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Three" });
  });
});
