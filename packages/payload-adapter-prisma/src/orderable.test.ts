import { sanitizeConfig } from "payload";
import type { CollectionConfig } from "payload";
import { describe, expect, it } from "vitest";

import { buildMappings } from "./mapping/build.js";
import type { ModelMapping } from "./mapping/types.js";
import { find, updateOne } from "./operations.js";
import type { PrismaContext } from "./operations.js";
import { parsePrismaSchema } from "./schema/parseSchema.js";

/**
 * `orderable: true`, and an orderable `join`.
 *
 * Payload adds the order field during sanitization, after the config is
 * written, and names it `_order`, which no Prisma field can be called. So the
 * column is named on the collection, and the fields come from Payload's own
 * `sanitizeConfig` rather than a hand-built copy that could drift from it.
 */

const datamodel = parsePrismaSchema({
  source: `
model QuizCategory {
  id        String         @id @default(cuid())
  title     String
  order     String?
  questions QuizQuestion[]
}

model QuizQuestion {
  id         String       @id @default(cuid())
  prompt     String
  position   String?
  category   QuizCategory @relation(fields: [categoryId], references: [id])
  categoryId String
}
`,
});

/** The two collections, with the given `custom.prisma` on each. */
async function sanitized(prisma: { categories: object; questions: object }) {
  const collections: CollectionConfig[] = [
    {
      slug: "categories",
      orderable: true,
      custom: { prisma: { model: "QuizCategory", ...prisma.categories } },
      timestamps: false,
      fields: [
        { name: "title", type: "text" },
        { name: "questions", type: "join", collection: "questions", on: "category", orderable: true },
      ],
    },
    {
      slug: "questions",
      custom: { prisma: { model: "QuizQuestion", ...prisma.questions } },
      timestamps: false,
      fields: [
        { name: "prompt", type: "text" },
        { name: "category", type: "relationship", relationTo: "categories" },
      ],
    },
  ];
  const config = await sanitizeConfig({ secret: "x", collections } as never);
  return config.collections.filter((entry) => entry.custom?.prisma !== undefined);
}

/** Payload's name for the join's order field, on the child. */
const JOIN_ORDER = "_questions_questions_order";

describe("orderable", () => {
  it("names the column Payload's injected field reads and writes", async () => {
    const { collections } = buildMappings({
      datamodel,
      globals: [],
      collections: await sanitized({
        categories: { fields: { _order: "order" } },
        questions: { fields: { [JOIN_ORDER]: "position" } },
      }),
    });

    expect(collections.get("categories")?.fields.get("_order")?.prismaField).toBe("order");
    expect(collections.get("questions")?.fields.get(JOIN_ORDER)?.prismaField).toBe("position");
  });

  it("points at the collection-level key when `_order` has no column", async () => {
    const collections = await sanitized({ categories: {}, questions: {} });
    expect(() => buildMappings({ datamodel, globals: [], collections })).toThrow(
      /fields: \{ _order: "…" \}/,
    );
  });

  it("refuses a key that is not a top-level field", async () => {
    const collections = await sanitized({
      categories: { fields: { _order: "order", sortOrder: "order" } },
      questions: { fields: { [JOIN_ORDER]: "position" } },
    });
    expect(() => buildMappings({ datamodel, globals: [], collections })).toThrow(
      /`custom\.prisma\.fields\.sortOrder`, but "sortOrder" is not a top-level field/,
    );
  });

  it("refuses a `fields` that is not path to column", async () => {
    const collections = await sanitized({
      categories: { fields: { _order: 1 } },
      questions: {},
    });
    expect(() => buildMappings({ datamodel, globals: [], collections })).toThrow(
      /`custom\.prisma\.fields` that is not an object of field path to column name/,
    );
  });

  it("still lets a field's own `custom.prisma.field` win", async () => {
    const collections = await sanitized({
      categories: { fields: { _order: "order", title: "nope" } },
      questions: { fields: { [JOIN_ORDER]: "position" } },
    });
    const title = collections[0]?.flattenedFields.find((field) => field.name === "title");
    (title as { custom?: object }).custom = { prisma: { field: "title" } };

    const mappings = buildMappings({ datamodel, globals: [], collections });
    expect(mappings.collections.get("categories")?.fields.get("title")?.prismaField).toBe("title");
  });

  it("serves the queries Payload's orderable hook and reorder endpoint send", async () => {
    const { collections } = buildMappings({
      datamodel,
      globals: [],
      collections: await sanitized({
        categories: { fields: { _order: "order" } },
        questions: { fields: { [JOIN_ORDER]: "position" } },
      }),
    });
    const byModel = new Map<string, ModelMapping>();
    for (const mapping of collections.values()) byModel.set(mapping.model, mapping);

    const calls: Record<string, unknown>[] = [];
    const row = { id: "c1", title: "Maths", order: null };
    const record = (args: Record<string, unknown>) => {
      calls.push(args);
      return Promise.resolve(row);
    };
    const context: PrismaContext = {
      prisma: {
        quizCategory: {
          findMany: (args: Record<string, unknown>) => record(args).then((entry) => [entry]),
          update: record,
        },
      },
      mappings: collections,
      globals: new Map(),
      byModel,
    };

    // The beforeChange hook, finding the last key.
    const last = await find(context, {
      collection: "categories",
      limit: 1,
      pagination: false,
      select: { _order: true },
      sort: "-_order",
      where: { _order: { exists: true } },
    } as never);
    expect(calls[0]).toMatchObject({
      orderBy: [{ order: "desc" }, { id: "asc" }],
      where: { order: { not: null } },
      take: 1,
    });
    // A NULL key reads back as null, which the hook turns into "first".
    expect(last.docs[0]).toMatchObject({ _order: null });

    // The reorder endpoint, finding the neighbour and writing the new key.
    await find(context, {
      collection: "categories",
      limit: 1,
      pagination: false,
      sort: "_order",
      where: { _order: { greater_than: "a0" } },
    } as never);
    expect(calls[1]).toMatchObject({ orderBy: [{ order: "asc" }, { id: "asc" }] });
    expect(JSON.stringify(calls[1]?.where)).toContain('"order":{"gt":"a0"}');

    await updateOne(context, { collection: "categories", id: "c1", data: { _order: "a1" } } as never);
    expect(calls[2]).toMatchObject({ where: { id: "c1" }, data: { order: "a1" } });
  });
});
