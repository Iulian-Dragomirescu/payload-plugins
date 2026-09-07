import type { SanitizedCollectionConfig, SanitizedGlobalConfig } from "payload";
import { describe, expect, it } from "vitest";

import { parsePrismaSchema } from "../schema/parseSchema.js";
import { buildMappings, PrismaAdapterMappingError } from "./build.js";

/**
 * A `join` is the parent's view of the child's foreign key. Nothing about it is
 * stored on the parent, so every part of it is resolved from the CHILD's
 * mapping: the delegate to read, the column to match on, the renames the child
 * declared.
 *
 * The failure these tests exist for is the quiet one. A join that resolves to
 * nothing renders as an empty list, which looks exactly like a quiz with no
 * questions.
 */

const SCHEMA = `
model Quiz {
  id        String         @id @default(cuid())
  title     String
  questions QuizQuestion[]
  editor    Editor?        @relation(fields: [editorId], references: [id])
  editorId  String?
}

model QuizQuestion {
  id       String       @id @default(cuid())
  prompt   String
  position Int          @default(0)
  quiz     Quiz         @relation(fields: [quizId], references: [id], onDelete: Cascade)
  quizId   String
  options  QuizOption[]
}

model QuizOption {
  id         String       @id @default(cuid())
  label      String
  question   QuizQuestion @relation(fields: [questionId], references: [id])
  questionId String
}

model Editor {
  id      String   @id @default(cuid())
  name    String
  quizzes Quiz[]
  profile Profile?
}

model Profile {
  id      String @id @default(cuid())
  handle  String
  editor  Editor @relation(fields: [editorId], references: [id])
  editorId String @unique
}

model Folder {
  id       String   @id @default(cuid())
  name     String
  parent   Folder?  @relation("FolderTree", fields: [parentId], references: [id])
  parentId String?
  children Folder[] @relation("FolderTree")
}
`;

const datamodel = parsePrismaSchema({ source: SCHEMA });

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

/** The child collection every case below joins onto. */
const questions = collection({
  slug: "quiz-questions",
  custom: { prisma: { model: "QuizQuestion" } },
  fields: [
    { name: "prompt", type: "text" },
    { name: "position", type: "number" },
    // Renamed on purpose: a join must resolve `on` through the child's own
    // mapping, not by guessing the Prisma field from the Payload name.
    { name: "quiz", type: "relationship", relationTo: "quizzes" },
  ],
});

/** Resolves a set of configs, so the join pass runs the way the adapter runs it. */
function mappingsFor(props: {
  collections: SanitizedCollectionConfig[];
  globals?: SanitizedGlobalConfig[];
}): ReturnType<typeof buildMappings> {
  return buildMappings({
    collections: props.collections,
    globals: props.globals ?? [],
    datamodel,
  });
}

describe("a join that resolves", () => {
  const { collections } = mappingsFor({
    collections: [
      collection({
        slug: "quizzes",
        custom: { prisma: { model: "Quiz" } },
        fields: [
          { name: "title", type: "text" },
          {
            name: "questions",
            type: "join",
            collection: "quiz-questions",
            on: "quiz",
            defaultLimit: 25,
            defaultSort: "position",
            where: { position: { greater_than: 0 } },
          },
        ],
      }),
      questions,
    ],
  });

  const join = collections.get("quizzes")?.joins.get("questions");

  it("resolves the child collection and the relationship it reverses", () => {
    expect(join?.target.slug).toBe("quiz-questions");
    expect(join?.targetRelation.path).toBe("quiz");
    expect(join?.target.model).toBe("QuizQuestion");
    expect(join?.targetRelation.foreignKey).toBe("quizId");
  });

  it("names this side of the relation, so the children ride on the parent's read", () => {
    // One query per page rather than one per parent row. Prisma's nested read
    // takes `where`, `orderBy`, `skip` and `take`, so each parent still gets
    // its own correctly paginated page.
    expect(join?.prismaField).toBe("questions");
  });

  it("carries the field's own limit, sort and filter", () => {
    expect(join?.defaultLimit).toBe(25);
    expect(join?.defaultSort).toBe("position");
    expect(join?.where).toEqual({ position: { greater_than: 0 } });
  });

  it("defaults the limit to Payload's own 10", () => {
    const { collections: built } = mappingsFor({
      collections: [
        collection({
          slug: "quizzes",
          custom: { prisma: { model: "Quiz" } },
          fields: [{ name: "questions", type: "join", collection: "quiz-questions", on: "quiz" }],
        }),
        questions,
      ],
    });
    expect(built.get("quizzes")?.joins.get("questions")?.defaultLimit).toBe(10);
  });

  it("keeps the join out of `fields`, so nothing tries to write it", () => {
    // A join is a query, not a column. In `fields` it would be reachable by
    // `buildData`, `buildWhere` and `buildOrderBy`, none of which have a column
    // to work with.
    expect(collections.get("quizzes")?.fields.has("questions")).toBe(false);
  });

  it("resolves in either config order", () => {
    // The child may be mapped after the parent, so joins are a second pass.
    const { collections: reversed } = mappingsFor({
      collections: [
        questions,
        collection({
          slug: "quizzes",
          custom: { prisma: { model: "Quiz" } },
          fields: [{ name: "questions", type: "join", collection: "quiz-questions", on: "quiz" }],
        }),
      ],
    });
    expect(reversed.get("quizzes")?.joins.get("questions")?.prismaField).toBe("questions");
  });
});

describe("a join onto the same collection", () => {
  it("takes the other side of a self-relation, not the field itself", () => {
    // Both sides of `FolderTree` are on `Folder` and share a relation name, so
    // matching by name alone would pick whichever was declared first. Picking
    // the join's own field would read every folder as its own child.
    const { collections } = mappingsFor({
      collections: [
        collection({
          slug: "folders",
          custom: { prisma: { model: "Folder" } },
          fields: [
            { name: "name", type: "text" },
            { name: "parent", type: "relationship", relationTo: "folders" },
            { name: "children", type: "join", collection: "folders", on: "parent" },
          ],
        }),
      ],
    });

    const join = collections.get("folders")?.joins.get("children");
    expect(join?.prismaField).toBe("children");
    expect(join?.targetRelation.foreignKey).toBe("parentId");
  });
});

describe("a join that resolves through the child's renames", () => {
  it("follows `custom.prisma.field` on the child's relationship", () => {
    const renamed = collection({
      slug: "quiz-questions",
      custom: { prisma: { model: "QuizQuestion" } },
      fields: [
        { name: "prompt", type: "text" },
        // The Payload field is `parent`, the Prisma relation is `quiz`.
        {
          name: "parent",
          type: "relationship",
          relationTo: "quizzes",
          custom: { prisma: { field: "quiz" } },
        },
      ],
    });

    const { collections } = mappingsFor({
      collections: [
        collection({
          slug: "quizzes",
          custom: { prisma: { model: "Quiz" } },
          fields: [
            { name: "questions", type: "join", collection: "quiz-questions", on: "parent" },
          ],
        }),
        renamed,
      ],
    });

    const join = collections.get("quizzes")?.joins.get("questions");
    expect(join?.targetRelation.prismaField).toBe("quiz");
    expect(join?.prismaField).toBe("questions");
  });
});

describe("a join that does not resolve", () => {
  /** Wraps a parent config carrying one join field. */
  const parentWith = (field: Record<string, unknown>): SanitizedCollectionConfig =>
    collection({
      slug: "quizzes",
      custom: { prisma: { model: "Quiz" } },
      fields: [{ name: "title", type: "text" }, field],
    });

  it("names the Prisma-backed collections when the target is not one", () => {
    expect(() =>
      mappingsFor({
        collections: [
          parentWith({ name: "questions", type: "join", collection: "comments", on: "quiz" }),
          questions,
        ],
      }),
    ).toThrow(/not Prisma-backed[\s\S]*quizzes, quiz-questions/);
  });

  it("names the child's relationships when `on` is not one of them", () => {
    expect(() =>
      mappingsFor({
        collections: [
          parentWith({ name: "questions", type: "join", collection: "quiz-questions", on: "owner" }),
          questions,
        ],
      }),
    ).toThrow(/not a field on that collection[\s\S]*Relationships on "quiz-questions": quiz/);
  });

  it("refuses `on` pointing at a scalar", () => {
    expect(() =>
      mappingsFor({
        collections: [
          parentWith({
            name: "questions",
            type: "join",
            collection: "quiz-questions",
            on: "prompt",
          }),
          questions,
        ],
      }),
    ).toThrow(/a scalar field/);
  });

  it("refuses a relationship that points somewhere else", () => {
    // `QuizOption.question` points at QuizQuestion, so joining it from the quiz
    // would read every option in the database rather than this quiz's.
    const options = collection({
      slug: "quiz-options",
      custom: { prisma: { model: "QuizOption" } },
      fields: [
        { name: "label", type: "text" },
        { name: "question", type: "relationship", relationTo: "quiz-questions" },
      ],
    });

    expect(() =>
      mappingsFor({
        collections: [
          parentWith({
            name: "options",
            type: "join",
            collection: "quiz-options",
            on: "question",
          }),
          questions,
          options,
        ],
      }),
    ).toThrow(/points at Prisma model "QuizQuestion", not at "Quiz"/);
  });

  it("refuses a polymorphic join, which has no one query", () => {
    expect(() =>
      mappingsFor({
        collections: [
          parentWith({
            name: "children",
            type: "join",
            collection: ["quiz-questions", "quiz-options"],
            on: "quiz",
          }),
          questions,
        ],
      }),
    ).toThrow(/polymorphic join/);
  });

  it("refuses a nested `on`, which has no column under it", () => {
    expect(() =>
      mappingsFor({
        collections: [
          parentWith({
            name: "questions",
            type: "join",
            collection: "quiz-questions",
            on: "meta.quiz",
          }),
          questions,
        ],
      }),
    ).toThrow(/nested path[\s\S]*Json/);
  });

  it("refuses a one-to-one, which has nothing to paginate", () => {
    const profiles = collection({
      slug: "profiles",
      custom: { prisma: { model: "Profile" } },
      fields: [
        { name: "handle", type: "text" },
        { name: "editor", type: "relationship", relationTo: "editors" },
      ],
    });

    expect(() =>
      mappingsFor({
        collections: [
          collection({
            slug: "editors",
            custom: { prisma: { model: "Editor" } },
            fields: [
              { name: "name", type: "text" },
              { name: "profile", type: "join", collection: "profiles", on: "editor" },
            ],
          }),
          profiles,
        ],
      }),
    ).toThrow(/one-to-one[\s\S]*type: "relationship"/);
  });

  it("refuses a join over a relation a relationship field already maps", () => {
    // Prisma reads one relation once per query. Two fields over it would need
    // two different `take`s on the same include.
    expect(() =>
      mappingsFor({
        collections: [
          collection({
            slug: "quizzes",
            custom: { prisma: { model: "Quiz" } },
            fields: [
              { name: "questions", type: "relationship", relationTo: "quiz-questions", hasMany: true, custom: { prisma: { readOnly: true } } },
              { name: "questionList", type: "join", collection: "quiz-questions", on: "quiz" },
            ],
          }),
          questions,
        ],
      }),
    ).toThrow(/already maps as a relationship/);
  });

  it("refuses a join on a global, which Payload never populates", () => {
    const global_ = {
      slug: "editorial",
      custom: { prisma: { model: "Quiz" } },
      flattenedFields: [
        { name: "title", type: "text" },
        { name: "questions", type: "join", collection: "quiz-questions", on: "quiz" },
      ],
    } as unknown as SanitizedGlobalConfig;

    expect(() => mappingsFor({ collections: [questions], globals: [global_] })).toThrow(
      /Payload only populates on collections/,
    );
  });

  it("raises a mapping error rather than any other kind", () => {
    expect(() =>
      mappingsFor({
        collections: [
          parentWith({ name: "questions", type: "join", collection: "quiz-questions" }),
          questions,
        ],
      }),
    ).toThrow(PrismaAdapterMappingError);
  });
});
