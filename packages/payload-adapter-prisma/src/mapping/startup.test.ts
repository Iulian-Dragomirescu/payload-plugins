import type { SanitizedCollectionConfig, SanitizedGlobalConfig } from "payload";
import { describe, expect, it } from "vitest";

import { create } from "../operations.js";
import type { PrismaContext } from "../operations.js";
import { parsePrismaSchema } from "../schema/parseSchema.js";
import { buildCollectionMapping, buildGlobalMapping } from "./build.js";

/**
 * Checks that turn a runtime failure into a startup one.
 *
 * Both of the cases here were already decidable from `schema.prisma` at boot,
 * and both used to surface much later: one on the first removal from a list,
 * one on the first save. That distance is the bug, more than the individual
 * cases.
 */

const SCHEMA = `
model Quiz {
  id        String         @id @default(cuid())
  title     String
  questions QuizQuestion[]
  tags      Tag[]          @relation("QuizToTag")
  drafts    DraftNote[]
}

model QuizQuestion {
  id       String @id @default(cuid())
  prompt   String
  position Int    @default(0)
  quiz     Quiz   @relation(fields: [quizId], references: [id], onDelete: Cascade)
  quizId   String
}

model DraftNote {
  id     String  @id @default(cuid())
  body   String
  quiz   Quiz?   @relation(fields: [quizId], references: [id])
  quizId String?
}

model Tag {
  id      String @id @default(cuid())
  label   String
  quizzes Quiz[] @relation("QuizToTag")
}

model Drawing {
  id    String @id @default(cuid())
  value Bytes
  note  String @default("")
}

model Setting {
  id    String @id @default(cuid())
  key   String @unique
  title String
}
`;

const datamodel = parsePrismaSchema({ source: SCHEMA });

/** Builds the minimum of a sanitized collection the mapper reads. */
function mappingFor(props: { slug?: string; model: string; fields: unknown[] }) {
  return buildCollectionMapping({
    datamodel,
    collection: {
      slug: props.slug ?? "quizzes",
      custom: { prisma: { model: props.model } },
      flattenedFields: props.fields,
    } as unknown as SanitizedCollectionConfig,
  });
}

describe("a to-many whose children cannot be detached", () => {
  it("refuses one whose foreign key is non-null", () => {
    // `set` replaces the whole set, so a removal writes NULL into
    // `QuizQuestion.quizId`. Adding works; the first removal does not.
    expect(() =>
      mappingFor({
        model: "Quiz",
        fields: [
          { name: "questions", type: "relationship", relationTo: "quiz-questions", hasMany: true },
        ],
      }),
    ).toThrow(/"QuizQuestion.quizId", which is non-null/);
  });

  it("names all three ways out", () => {
    const attempt = (): unknown =>
      mappingFor({
        model: "Quiz",
        fields: [
          { name: "questions", type: "relationship", relationTo: "quiz-questions", hasMany: true },
        ],
      });

    expect(attempt).toThrow(/type: "join"/);
    expect(attempt).toThrow(/readOnly: true/);
    expect(attempt).toThrow(/make "QuizQuestion.quizId" optional/);
  });

  it("allows it when the field is read-only, since the set is never written", () => {
    const mapping = mappingFor({
      model: "Quiz",
      fields: [
        {
          name: "questions",
          type: "relationship",
          relationTo: "quiz-questions",
          hasMany: true,
          custom: { prisma: { readOnly: true } },
        },
      ],
    });
    expect(mapping.fields.get("questions")?.readOnly).toBe(true);
  });

  it("allows a nullable foreign key, where a removal is a legal write", () => {
    const mapping = mappingFor({
      model: "Quiz",
      fields: [{ name: "drafts", type: "relationship", relationTo: "notes", hasMany: true }],
    });
    expect(mapping.fields.get("drafts")?.kind).toBe("relation");
  });

  it("allows an implicit many-to-many, where nothing is ever set to NULL", () => {
    // A removal there is a row leaving the join table.
    const mapping = mappingFor({
      model: "Quiz",
      fields: [{ name: "tags", type: "relationship", relationTo: "tags", hasMany: true }],
    });
    expect(mapping.fields.get("tags")?.kind).toBe("relation");
  });
});

describe("`orderBy` on a to-many", () => {
  it("records it, so the children come back in the editor's order", () => {
    const mapping = mappingFor({
      model: "Quiz",
      fields: [
        {
          name: "questions",
          type: "relationship",
          relationTo: "quiz-questions",
          hasMany: true,
          custom: { prisma: { readOnly: true, orderBy: { position: "asc" } } },
        },
      ],
    });

    const questions = mapping.fields.get("questions");
    if (questions?.kind !== "relation") throw new Error("expected a relation");
    expect(questions.orderBy).toEqual({ position: "asc" });
  });

  it("names the target's columns when it orders by one that is not there", () => {
    expect(() =>
      mappingFor({
        model: "Quiz",
        fields: [
          {
            name: "questions",
            type: "relationship",
            relationTo: "quiz-questions",
            hasMany: true,
            custom: { prisma: { readOnly: true, orderBy: { sortOrder: "asc" } } },
          },
        ],
      }),
    ).toThrow(/not a column on that model[\s\S]*prompt, position/);
  });

  it("refuses a direction Prisma does not take", () => {
    expect(() =>
      mappingFor({
        model: "Quiz",
        fields: [
          {
            name: "questions",
            type: "relationship",
            relationTo: "quiz-questions",
            hasMany: true,
            custom: { prisma: { readOnly: true, orderBy: { position: "ascending" } } },
          },
        ],
      }),
    ).toThrow(/Use "asc" or "desc"/);
  });

  it("refuses it on a to-one, which has one row anyway", () => {
    expect(() =>
      mappingFor({
        slug: "quiz-questions",
        model: "QuizQuestion",
        fields: [
          {
            name: "quiz",
            type: "relationship",
            relationTo: "quizzes",
            custom: { prisma: { orderBy: { title: "asc" } } },
          },
        ],
      }),
    ).toThrow(/to-one relationship/);
  });
});

describe("a column no create can fill in", () => {
  const drawings = (fields: unknown[]) =>
    mappingFor({ slug: "drawings", model: "Drawing", fields });

  it("lists a non-null column with no default that nothing maps", () => {
    // Reads are fine, which is why this is reported rather than raised: a
    // collection can legitimately be a view onto a table something else fills.
    expect(drawings([{ name: "note", type: "text" }]).uncreatable).toEqual(["value"]);
  });

  it("is empty once a field writes the column", () => {
    expect(drawings([{ name: "value", type: "text" }]).uncreatable).toEqual([]);
  });

  it("counts a read-only field as not writing it", () => {
    expect(
      drawings([{ name: "value", type: "text", custom: { prisma: { readOnly: true } } }])
        .uncreatable,
    ).toEqual(["value"]);
  });

  it("does not count a column with a default", () => {
    expect(drawings([{ name: "value", type: "text" }]).uncreatable).not.toContain("note");
  });

  it("does not count a foreign key its relationship writes", () => {
    // `quizId` is non-null with no default, but `connect` fills it in.
    const mapping = mappingFor({
      slug: "quiz-questions",
      model: "QuizQuestion",
      fields: [
        { name: "prompt", type: "text" },
        { name: "quiz", type: "relationship", relationTo: "quizzes" },
      ],
    });
    expect(mapping.uncreatable).toEqual([]);
  });

  it("does count a foreign key when nothing maps the relationship", () => {
    const mapping = mappingFor({
      slug: "quiz-questions",
      model: "QuizQuestion",
      fields: [{ name: "prompt", type: "text" }],
    });
    expect(mapping.uncreatable).toEqual(["quizId"]);
  });

  it("does not count a global's discriminator, which every create writes", () => {
    // `Setting.key` is non-null with no default and no field maps it, but
    // `custom.prisma.where` is merged into the create precisely so the row this
    // makes is the row the next read finds.
    const mapping = buildGlobalMapping({
      datamodel,
      global: {
        slug: "siteSettings",
        custom: { prisma: { model: "Setting", where: { key: "site" } } },
        flattenedFields: [{ name: "title", type: "text" }],
      } as unknown as SanitizedGlobalConfig,
    });
    expect(mapping.uncreatable).toEqual([]);
  });

  it("refuses the create rather than letting Prisma refuse it", async () => {
    const mapping = drawings([{ name: "note", type: "text" }]);
    const context: PrismaContext = {
      prisma: {
        drawing: {
          create: () => {
            throw new Error("the adapter should not have got this far");
          },
        },
      },
      mappings: new Map([[mapping.slug, mapping]]),
      globals: new Map(),
      byModel: new Map(),
    };

    await expect(
      create(context, { collection: "drawings", data: { note: "hi" } }),
    ).rejects.toThrow(/"Drawing.value" is non-null in schema.prisma with no default/);
  });
});
