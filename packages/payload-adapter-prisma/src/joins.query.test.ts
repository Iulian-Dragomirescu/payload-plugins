import type { SanitizedCollectionConfig } from "payload";
import { describe, expect, it } from "vitest";

import { buildMappings } from "./mapping/build.js";
import type { ModelMapping } from "./mapping/types.js";
import { find, findOne } from "./operations.js";
import type { PrismaContext } from "./operations.js";
import { parsePrismaSchema } from "./schema/parseSchema.js";

/**
 * A join reads the children on the parent's own query, as a nested `include`.
 * That is what keeps a page of quizzes to one round trip instead of one per
 * row, and it is also the only way each parent gets its OWN page of children:
 * a single flat query over every parent can only paginate the pile.
 *
 * These run against a recording stub, because what matters is the query. A real
 * database would answer a wrong `take` correctly for a small enough table.
 */

const datamodel = parsePrismaSchema({
  source: `
model Quiz {
  id        String         @id @default(cuid())
  title     String
  questions QuizQuestion[]
}

model QuizQuestion {
  id       String @id @default(cuid())
  prompt   String
  position Int    @default(0)
  hidden   Boolean @default(false)
  quiz     Quiz   @relation(fields: [quizId], references: [id], onDelete: Cascade)
  quizId   String
}
`,
});

/** Builds the minimum of a sanitized collection the mapper reads. */
function collection(props: {
  slug: string;
  custom?: unknown;
  fields: unknown[];
}): SanitizedCollectionConfig {
  return {
    slug: props.slug,
    custom: props.custom,
    flattenedFields: props.fields,
  } as unknown as SanitizedCollectionConfig;
}

/**
 * Mappings for a quiz whose join field carries the given defaults.
 */
function mappingsFor(join: Record<string, unknown> = {}): Map<string, ModelMapping> {
  return buildMappings({
    datamodel,
    globals: [],
    collections: [
      collection({
        slug: "quizzes",
        custom: { prisma: { model: "Quiz" } },
        fields: [
          { name: "title", type: "text" },
          { name: "questions", type: "join", collection: "quiz-questions", on: "quiz", ...join },
        ],
      }),
      collection({
        slug: "quiz-questions",
        custom: { prisma: { model: "QuizQuestion" } },
        fields: [
          { name: "prompt", type: "text" },
          { name: "position", type: "number" },
          { name: "hidden", type: "checkbox" },
          { name: "quiz", type: "relationship", relationTo: "quizzes" },
        ],
      }),
    ],
  }).collections;
}

/** A Prisma client that records what it was asked and answers from a script. */
function stub(props: { mappings: Map<string, ModelMapping>; rows: Record<string, unknown>[] }) {
  const calls: Record<string, unknown>[] = [];
  const answer = (args: Record<string, unknown>): unknown => {
    calls.push(args);
    return props.rows;
  };

  const byModel = new Map<string, ModelMapping>();
  for (const mapping of props.mappings.values()) byModel.set(mapping.model, mapping);

  const delegate = {
    count: () => Promise.resolve(props.rows.length),
    create: () => Promise.resolve(props.rows[0] ?? {}),
    delete: () => Promise.resolve(props.rows[0] ?? {}),
    deleteMany: () => Promise.resolve({ count: 0 }),
    findFirst: (args: Record<string, unknown>) =>
      Promise.resolve((answer(args) as Record<string, unknown>[])[0] ?? null),
    findMany: (args: Record<string, unknown>) => Promise.resolve(answer(args)),
    update: (args: Record<string, unknown>) => Promise.resolve(answer(args)),
  };

  const context: PrismaContext = {
    prisma: { quiz: delegate, quizQuestion: delegate },
    mappings: props.mappings,
    globals: new Map(),
    byModel,
  };

  return { calls, context };
}

/** A quiz row carrying `take + 1` questions, the way Prisma would answer. */
function quizRow(props: { id: string; questions: number; count?: number }) {
  return {
    id: props.id,
    title: "Quiz",
    questions: Array.from({ length: props.questions }, (_, index) => ({ id: `q${index}` })),
    ...(props.count !== undefined ? { _count: { questions: props.count } } : {}),
  };
}

describe("the query a join builds", () => {
  it("reads the children as a nested include on the parent", async () => {
    const { calls, context } = stub({
      mappings: mappingsFor(),
      rows: [quizRow({ id: "quiz-1", questions: 1 })],
    });

    await find(context, { collection: "quizzes", joins: { questions: {} } } as never);

    const include = calls[0]?.include as Record<string, Record<string, unknown>>;
    expect(include.questions).toMatchObject({
      select: { id: true },
      skip: 0,
      // One more than the page, so `hasNextPage` costs no second query.
      take: 11,
    });
  });

  it("filters the children by the relationship `on` names", async () => {
    // The parent's own read already restricts them, which is the whole reason
    // this is an include rather than a second query keyed on parent ids.
    const { calls, context } = stub({
      mappings: mappingsFor(),
      rows: [quizRow({ id: "quiz-1", questions: 0 })],
    });

    await find(context, {
      collection: "quizzes",
      joins: { questions: { where: { hidden: { equals: false } } } },
    } as never);

    const include = calls[0]?.include as Record<string, Record<string, unknown>>;
    expect(include.questions?.where).toEqual({ hidden: { equals: false } });
  });

  it("ANDs the field's own `where` with the request's", async () => {
    const { calls, context } = stub({
      mappings: mappingsFor({ where: { hidden: { equals: false } } }),
      rows: [quizRow({ id: "quiz-1", questions: 0 })],
    });

    await find(context, {
      collection: "quizzes",
      joins: { questions: { where: { position: { greater_than: 0 } } } },
    } as never);

    const include = calls[0]?.include as Record<string, Record<string, unknown>>;
    expect(include.questions?.where).toEqual({
      AND: [{ hidden: { equals: false } }, { position: { gt: 0 } }],
    });
  });

  it("sorts by the field's `defaultSort`, ending on the primary key", async () => {
    const { calls, context } = stub({
      mappings: mappingsFor({ defaultSort: "position" }),
      rows: [quizRow({ id: "quiz-1", questions: 0 })],
    });

    await find(context, { collection: "quizzes", joins: { questions: {} } } as never);

    const include = calls[0]?.include as Record<string, Record<string, unknown>>;
    // Without a unique tiebreaker, page two repeats or skips whatever fell on
    // the boundary between two questions sharing a position.
    expect(include.questions?.orderBy).toEqual([{ position: "asc" }, { id: "asc" }]);
  });

  it("lets the request's sort win over the field's", async () => {
    const { calls, context } = stub({
      mappings: mappingsFor({ defaultSort: "position" }),
      rows: [quizRow({ id: "quiz-1", questions: 0 })],
    });

    await find(context, {
      collection: "quizzes",
      joins: { questions: { sort: "-prompt" } },
    } as never);

    const include = calls[0]?.include as Record<string, Record<string, unknown>>;
    expect(include.questions?.orderBy).toEqual([{ prompt: "desc" }, { id: "asc" }]);
  });

  it("pages with the field's `defaultLimit`", async () => {
    const { calls, context } = stub({
      mappings: mappingsFor({ defaultLimit: 3 }),
      rows: [quizRow({ id: "quiz-1", questions: 0 })],
    });

    await find(context, { collection: "quizzes", joins: { questions: { page: 2 } } } as never);

    const include = calls[0]?.include as Record<string, Record<string, unknown>>;
    expect(include.questions).toMatchObject({ skip: 3, take: 4 });
  });

  it("takes everything when the limit is 0", async () => {
    const { calls, context } = stub({
      mappings: mappingsFor(),
      rows: [quizRow({ id: "quiz-1", questions: 0 })],
    });

    await find(context, { collection: "quizzes", joins: { questions: { limit: 0 } } } as never);

    const include = calls[0]?.include as Record<string, Record<string, unknown>>;
    expect(include.questions?.take).toBeUndefined();
    expect(include.questions?.skip).toBeUndefined();
  });

  it("counts only when the request asked for a total", async () => {
    const plain = stub({ mappings: mappingsFor(), rows: [quizRow({ id: "q", questions: 0 })] });
    await find(plain.context, { collection: "quizzes", joins: { questions: {} } } as never);
    expect((plain.calls[0]?.include as Record<string, unknown>)._count).toBeUndefined();

    const counted = stub({ mappings: mappingsFor(), rows: [quizRow({ id: "q", questions: 0 })] });
    await find(counted.context, {
      collection: "quizzes",
      joins: { questions: { count: true, where: { hidden: { equals: false } } } },
    } as never);

    // Filtered, or the total would not match the rows the page came from.
    expect((counted.calls[0]?.include as Record<string, unknown>)._count).toEqual({
      select: { questions: { where: { hidden: { equals: false } } } },
    });
  });

  it("asks for nothing when the caller asked for no joins", async () => {
    const { calls, context } = stub({
      mappings: mappingsFor(),
      rows: [quizRow({ id: "quiz-1", questions: 0 })],
    });

    await find(context, { collection: "quizzes" } as never);
    expect(calls[0]?.include).toBeUndefined();

    // `false` is what a GraphQL request sends, and what access control sends
    // for a join this user may not read.
    await find(context, { collection: "quizzes", joins: false } as never);
    expect(calls[1]?.include).toBeUndefined();

    await find(context, { collection: "quizzes", joins: { questions: false } } as never);
    expect(calls[2]?.include).toBeUndefined();
  });
});

describe("the document a join produces", () => {
  it("returns ids in Payload's join envelope", async () => {
    const { context } = stub({
      mappings: mappingsFor(),
      rows: [quizRow({ id: "quiz-1", questions: 2 })],
    });

    const result = await find(context, {
      collection: "quizzes",
      joins: { questions: {} },
    } as never);

    // Ids, not documents: Payload populates them in `afterRead`, the same as a
    // relationship field.
    expect(result.docs[0]).toMatchObject({
      id: "quiz-1",
      questions: { docs: ["q0", "q1"], hasNextPage: false },
    });
  });

  it("drops the extra row and reports another page", async () => {
    const { context } = stub({
      mappings: mappingsFor({ defaultLimit: 2 }),
      rows: [quizRow({ id: "quiz-1", questions: 3 })],
    });

    const result = await find(context, {
      collection: "quizzes",
      joins: { questions: {} },
    } as never);

    expect(result.docs[0]?.questions).toEqual({ docs: ["q0", "q1"], hasNextPage: true });
  });

  it("carries `totalDocs` only when it was counted", async () => {
    const { context } = stub({
      mappings: mappingsFor(),
      rows: [quizRow({ count: 42, id: "quiz-1", questions: 2 })],
    });

    const counted = await find(context, {
      collection: "quizzes",
      joins: { questions: { count: true } },
    } as never);
    expect(counted.docs[0]?.questions).toMatchObject({ totalDocs: 42 });

    const plain = await find(context, {
      collection: "quizzes",
      joins: { questions: {} },
    } as never);
    expect(plain.docs[0]?.questions.totalDocs).toBeUndefined();
  });

  it("gives an empty envelope rather than nothing when there are no children", async () => {
    // A missing key renders as a broken field. An empty one renders as an empty
    // list, which is what a quiz with no questions is.
    const { context } = stub({
      mappings: mappingsFor(),
      rows: [quizRow({ id: "quiz-1", questions: 0 })],
    });

    const doc = await findOne(context, {
      collection: "quizzes",
      joins: { questions: {} },
    } as never);

    expect(doc?.questions).toEqual({ docs: [], hasNextPage: false });
  });

  it("pages each parent separately on a list view", async () => {
    const { context } = stub({
      mappings: mappingsFor({ defaultLimit: 2 }),
      rows: [
        quizRow({ id: "quiz-1", questions: 3 }),
        { id: "quiz-2", questions: [{ id: "q9" }], title: "Quiz" },
      ],
    });

    const result = await find(context, {
      collection: "quizzes",
      joins: { questions: {} },
    } as never);

    expect(result.docs[0]?.questions).toEqual({ docs: ["q0", "q1"], hasNextPage: true });
    expect(result.docs[1]?.questions).toEqual({ docs: ["q9"], hasNextPage: false });
  });
});
