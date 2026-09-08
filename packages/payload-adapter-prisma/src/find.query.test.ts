import type { SanitizedCollectionConfig } from "payload";
import { describe, expect, it } from "vitest";

import { buildMappings } from "./mapping/build.js";
import type { ModelMapping } from "./mapping/types.js";
import { find } from "./operations.js";
import type { PrismaContext } from "./operations.js";
import { parsePrismaSchema } from "./schema/parseSchema.js";

/**
 * What `find` does with `limit`, `page` and `pagination`.
 *
 * Payload's own bulk delete calls `find` with none of the three and deletes
 * whatever comes back, so a default page size here is a "delete all" that
 * deletes a page. `@payloadcms/db-mongodb` defaults the limit to 0, and
 * Payload's `find` operation has already applied its own default of 10 by the
 * time an adapter is called, so a default here is never the one anybody asked
 * for.
 */

const datamodel = parsePrismaSchema({
  source: `
model Post {
  id    String @id @default(cuid())
  title String
}
`,
});

const mappings = buildMappings({
  datamodel,
  globals: [],
  collections: [
    {
      slug: "posts",
      custom: { prisma: { model: "Post" } },
      flattenedFields: [{ name: "title", type: "text" }],
    } as unknown as SanitizedCollectionConfig,
  ],
}).collections;

/** A Prisma client that records what it was asked and answers with 25 rows. */
function stub() {
  const calls: Record<string, unknown>[] = [];
  const rows = Array.from({ length: 25 }, (_, index) => ({ id: `p${index}`, title: "Post" }));

  const byModel = new Map<string, ModelMapping>();
  for (const mapping of mappings.values()) byModel.set(mapping.model, mapping);

  const delegate = {
    count: () => Promise.resolve(rows.length),
    create: () => Promise.resolve(rows[0] as Record<string, unknown>),
    delete: () => Promise.resolve(rows[0] as Record<string, unknown>),
    deleteMany: () => Promise.resolve({ count: 0 }),
    findFirst: () => Promise.resolve(rows[0] ?? null),
    findMany: (args: Record<string, unknown>) => {
      calls.push(args);
      return Promise.resolve(rows);
    },
    update: () => Promise.resolve(rows[0] as Record<string, unknown>),
  };

  const context: PrismaContext = {
    prisma: { post: delegate },
    mappings,
    globals: new Map(),
    byModel,
  };

  return { calls, context };
}

describe("the page a find asks for", () => {
  it("takes everything when no limit is given", async () => {
    // Payload's bulk delete reads this way. A `take` here caps the delete.
    const { calls, context } = stub();

    const result = await find(context, { collection: "posts" } as never);

    expect(calls[0]?.take).toBeUndefined();
    expect(calls[0]?.skip).toBeUndefined();
    expect(result.docs).toHaveLength(25);
    expect(result.totalDocs).toBe(25);
  });

  it("takes everything when the limit is 0", async () => {
    const { calls, context } = stub();

    await find(context, { collection: "posts", limit: 0 } as never);

    expect(calls[0]?.take).toBeUndefined();
    expect(calls[0]?.skip).toBeUndefined();
  });

  it("still caps the rows when pagination is off but a limit is given", async () => {
    // Payload's bulk update passes `pagination: false` with the caller's limit,
    // which is a ceiling on how many documents it will write, not an envelope.
    const { calls, context } = stub();

    await find(context, { collection: "posts", limit: 5, pagination: false } as never);

    expect(calls[0]?.take).toBe(5);
    expect(calls[0]?.skip).toBeUndefined();
  });

  it("pages when a limit is given", async () => {
    const { calls, context } = stub();

    const result = await find(context, { collection: "posts", limit: 10, page: 2 } as never);

    expect(calls[0]).toMatchObject({ skip: 10, take: 10 });
    expect(result).toMatchObject({ page: 2, limit: 10, totalPages: 3, hasNextPage: true });
  });
});
