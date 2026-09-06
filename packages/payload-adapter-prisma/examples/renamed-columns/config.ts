import type { CollectionConfig } from "payload";

/**
 * A collection whose names differ from the schema's at every level.
 *
 * The slug is `posts`, the model is `BlogPost`, the table is `blog_posts`. The
 * field is `body`, the column is `content`. Each difference costs one key, and
 * the schema does not move.
 */
export const Posts: CollectionConfig = {
  slug: "posts",
  // The slug says `posts`, the model says `BlogPost`, so the mapping has to
  // name it rather than leaving the adapter to guess.
  custom: { prisma: { model: "BlogPost" } },
  admin: { useAsTitle: "title" },
  fields: [
    { name: "title", type: "text", required: true },
    { name: "slug", type: "text", required: true, unique: true },
    {
      name: "body",
      type: "textarea",
      // The column keeps the name it already had.
      custom: { prisma: { field: "content" } },
    },
    {
      name: "viewCount",
      type: "number",
      // A trigger owns this column. The field still reads and still renders; it
      // is dropped from every create and update, so a save cannot clobber it.
      custom: { prisma: { readOnly: true } },
      // `custom.prisma.readOnly` stops the write. This stops the input being
      // editable. You usually want both.
      admin: { readOnly: true, position: "sidebar" },
    },
    { name: "publishedAt", type: "date", admin: { position: "sidebar" } },
  ],
  // `updatedAt` is `@updatedAt`, so the adapter marks it read-only on its own.
  // Prisma maintains it, and writing it is an error rather than a preference.
};

/**
 * A collection whose table has no timestamp columns.
 *
 * Payload adds `createdAt` and `updatedAt` to every collection by default, and
 * the adapter will not invent columns for them. `timestamps: false` is the
 * Payload option that says the table does not have them.
 *
 * Without it, startup fails with:
 *
 *     [prisma-adapter] Collection "authors" field "createdAt" maps to
 *     "Author.createdAt", which does not exist.
 */
export const Authors: CollectionConfig = {
  slug: "authors",
  custom: { prisma: { model: "Author" } },
  timestamps: false,
  admin: { useAsTitle: "name" },
  fields: [
    { name: "name", type: "text", required: true },
    { name: "email", type: "email", required: true, unique: true },
  ],
};
