import type { SanitizedCollectionConfig } from "payload";
import { describe, expect, it } from "vitest";

import { buildMappings } from "./mapping/build.js";
import type { ModelMapping } from "./mapping/types.js";
import { create, deleteOne, updateOne } from "./operations.js";
import type { PrismaContext } from "./operations.js";
import { parsePrismaSchema } from "./schema/parseSchema.js";

/**
 * An array's write depends on which rows the parent already has, so an update
 * reads them first. These assert the queries, not the result: a database with
 * two rows in it answers a wrong `deleteMany` in a way that looks fine.
 */

const datamodel = parsePrismaSchema({
  source: `
model Quiz {
  id      String       @id @default(cuid())
  title   String
  options QuizOption[]
}

model QuizOption {
  id       String @id @default(cuid())
  label    String
  position Int    @default(0)
  quiz     Quiz   @relation(fields: [quizId], references: [id], onDelete: Cascade)
  quizId   String
}
`,
});

const mappings = buildMappings({
  datamodel,
  globals: [],
  collections: [
    {
      slug: "quizzes",
      custom: { prisma: { model: "Quiz" } },
      flattenedFields: [
        { name: "title", type: "text" },
        {
          name: "options",
          type: "array",
          custom: { prisma: { order: "position" } },
          flattenedFields: [{ name: "label", type: "text" }, { name: "id", type: "text" }],
        },
      ],
    } as unknown as SanitizedCollectionConfig,
  ],
}).collections;

/** A Prisma client that records every call and answers from a script. */
function stub(row: Record<string, unknown>) {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const record = (method: string) => (args: Record<string, unknown>) => {
    calls.push({ method, args });
    return Promise.resolve(row);
  };

  const byModel = new Map<string, ModelMapping>();
  for (const mapping of mappings.values()) byModel.set(mapping.model, mapping);

  const context: PrismaContext = {
    prisma: {
      quiz: {
        count: () => Promise.resolve(1),
        create: record("create"),
        delete: record("delete"),
        deleteMany: () => Promise.resolve({ count: 0 }),
        findFirst: record("findFirst"),
        findMany: (args: Record<string, unknown>) => {
          calls.push({ method: "findMany", args });
          return Promise.resolve([row]);
        },
        update: record("update"),
      },
    },
    mappings,
    globals: new Map(),
    byModel,
  };

  return { calls, context };
}

/** A quiz as Prisma would answer it, rows included. */
const quiz = {
  id: "quiz-1",
  title: "Colours",
  options: [
    { id: "o1", label: "Red" },
    { id: "o2", label: "Blue" },
  ],
};

describe("updating a document with an array", () => {
  it("reads the rows the parent has before writing", async () => {
    const { calls, context } = stub(quiz);

    await updateOne(context, {
      collection: "quizzes",
      id: "quiz-1",
      data: { title: "Colours", options: [{ id: "o1", label: "Crimson" }] },
    } as never);

    // Ids only, in one query for every array on the document.
    expect(calls[0]).toEqual({
      method: "findFirst",
      args: { where: { id: "quiz-1" }, select: { options: { select: { id: true } } } },
    });
  });

  it("edits the row it found and deletes the one it did not get back", async () => {
    const { calls, context } = stub(quiz);

    await updateOne(context, {
      collection: "quizzes",
      id: "quiz-1",
      data: { options: [{ id: "o1", label: "Crimson" }, { id: "68f0abc", label: "Green" }] },
    } as never);

    expect(calls[1]?.args.data).toEqual({
      options: {
        deleteMany: { id: { notIn: ["o1"] } },
        update: [{ where: { id: "o1" }, data: { label: "Crimson", position: 0 } }],
        // `68f0abc` is the placeholder the admin panel invents for a new row,
        // and the pre-read is what proves it is not a real id.
        create: [{ label: "Green", position: 1 }],
      },
    });
  });

  it("skips the pre-read when the update does not touch the array", async () => {
    const { calls, context } = stub(quiz);

    await updateOne(context, {
      collection: "quizzes",
      id: "quiz-1",
      data: { title: "Colours" },
    } as never);

    expect(calls.map((call) => call.method)).toEqual(["update"]);
  });

  it("reads the rows back with the updated document", async () => {
    const { calls, context } = stub(quiz);

    const doc = await updateOne(context, {
      collection: "quizzes",
      id: "quiz-1",
      data: { title: "Colours" },
    } as never);

    expect(calls[0]?.args.include).toMatchObject({
      options: { orderBy: [{ position: "asc" }, { id: "asc" }] },
    });
    expect(doc.options).toEqual([
      { id: "o1", label: "Red" },
      { id: "o2", label: "Blue" },
    ]);
  });
});

describe("creating a document with an array", () => {
  it("creates the rows with the parent and reads nothing first", async () => {
    // There is nothing to read: a row that does not exist has no children.
    const { calls, context } = stub(quiz);

    await create(context, {
      collection: "quizzes",
      data: { title: "Colours", options: [{ id: "68f0abc", label: "Red" }] },
    } as never);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.data).toEqual({
      title: "Colours",
      options: { create: [{ label: "Red", position: 0 }] },
    });
  });
});

describe("deleting a document with an array", () => {
  it("returns the rows it deleted", async () => {
    // Payload's delete returns the document, and once the parent is gone its
    // rows cannot be read back.
    const { context } = stub(quiz);

    const doc = await deleteOne(context, { collection: "quizzes", where: { id: { equals: "quiz-1" } } } as never);

    expect(doc.options).toHaveLength(2);
  });
});
