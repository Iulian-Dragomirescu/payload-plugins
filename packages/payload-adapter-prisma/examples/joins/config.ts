import type { CollectionConfig } from "payload";

/**
 * A parent reading its children.
 *
 * `join` is the only field type here that is not a column. Nothing about it is
 * stored on `Quiz`: the rows are found by querying `QuizQuestion` for the ones
 * pointing back, which is what a reverse lookup is.
 *
 * The children come back on this collection's own read, as a nested Prisma
 * `include` carrying `where`, `orderBy`, `skip` and `take`. So a page of
 * quizzes is one query, and each quiz still gets its own page of questions.
 */
export const Quizzes: CollectionConfig = {
  slug: "quizzes",
  custom: { prisma: { model: "Quiz" } },
  timestamps: false,
  admin: { useAsTitle: "title" },
  fields: [
    { name: "title", type: "text", required: true },

    // `on` names the RELATIONSHIP FIELD on the child, not the column and not
    // the Prisma relation. It is resolved through the child's own mapping, so
    // `QuizQuestions.parent` below keeps working while pointing at `quiz`.
    {
      name: "questions",
      type: "join",
      collection: "quiz-questions",
      on: "parent",
      // Applied when the request asks for no sort. It always ends on the
      // primary key, or page two would repeat whatever shared a position with
      // the last row of page one.
      defaultSort: "position",
      defaultLimit: 25,
      // ANDed into every read of this field.
      where: { hidden: { equals: false } },
    },

    // `Quiz` has two relations to `QuizQuestion`, which is the case `on` exists
    // for. Neither field mentions a Prisma name.
    {
      name: "archive",
      type: "join",
      collection: "quiz-questions",
      on: "archivedFrom",
      admin: { defaultColumns: ["prompt"] },
    },
  ],
};

export const QuizQuestions: CollectionConfig = {
  slug: "quiz-questions",
  custom: { prisma: { model: "QuizQuestion" } },
  timestamps: false,
  admin: { useAsTitle: "prompt" },
  fields: [
    { name: "prompt", type: "text", required: true },
    { name: "position", type: "number" },
    { name: "hidden", type: "checkbox" },

    // The owning side, and the field the join above travels over. Renamed on
    // purpose: `on: "parent"` is the Payload name, and the adapter follows the
    // rename to the `quiz` relation rather than guessing from the field name.
    {
      name: "parent",
      type: "relationship",
      relationTo: "quizzes",
      required: true,
      custom: { prisma: { field: "quiz" } },
    },
    {
      name: "archivedFrom",
      type: "relationship",
      relationTo: "quizzes",
      custom: { prisma: { foreignKey: "archivedFromId" } },
    },
  ],
};
