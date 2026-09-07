import type { CollectionConfig } from "payload";

/**
 * A parent writing its children.
 *
 * An `array` whose Prisma field is a RELATION maps onto that child table. One
 * whose Prisma field is a column stays a `Json` value, which is what makes this
 * safe to add to a config that already has arrays.
 *
 * `QuizOption.quizId` is NOT NULL, so a `relationship hasMany` over it is a
 * startup error: removing a row would write NULL into it. An array owns its
 * rows, so a removal is a `deleteMany` and nothing is ever set to NULL.
 */
export const Quizzes: CollectionConfig = {
  slug: "quizzes",
  custom: { prisma: { model: "Quiz" } },
  timestamps: false,
  admin: { useAsTitle: "title" },
  fields: [
    { name: "title", type: "text", required: true },

    {
      name: "options",
      type: "array",
      // Names a numeric column on `QuizOption`. The adapter writes the array's
      // index into it on every save, because the submitted order IS the order.
      // Required, unless the field sets `admin: { isSortable: false }`.
      custom: { prisma: { order: "position" } },
      fields: [
        { name: "label", type: "text", required: true },
        { name: "correct", type: "checkbox" },

        // An array can hold arrays. Still one read and one nested write: which
        // rows exist is scoped to the option they are inside.
        {
          name: "hints",
          type: "array",
          custom: { prisma: { order: "rank" } },
          fields: [{ name: "text", type: "text", required: true }],
        },
      ],
    },
  ],
};
