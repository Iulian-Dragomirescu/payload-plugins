import type { CollectionConfig } from "payload";

/**
 * Every relation shape, mapped.
 *
 * The write each one produces is decided by the schema, not by this file:
 *
 * | Relation | create           | update                          |
 * | -------- | ---------------- | ------------------------------- |
 * | to-one   | connect          | connect, or disconnect for null |
 * | to-many  | connect (a list) | set, replacing the whole set    |
 */
export const Posts: CollectionConfig = {
  slug: "posts",
  custom: { prisma: { model: "BlogPost" } },
  timestamps: false,
  admin: { useAsTitle: "title" },
  fields: [
    { name: "title", type: "text", required: true },

    // Two relations to the SAME model. The relation name resolves this one,
    // and the foreign key makes it unambiguous. Without `foreignKey` the
    // adapter would have to guess between `author` and `reviewer`, and a guess
    // here writes to the wrong column with nothing to complain about.
    {
      name: "author",
      type: "relationship",
      relationTo: "authors",
      required: true,
      custom: { prisma: { foreignKey: "authorId" } },
    },
    {
      name: "reviewer",
      type: "relationship",
      relationTo: "authors",
      custom: { prisma: { foreignKey: "reviewerId" } },
    },

    // Many-to-many. `hasMany` and the schema's `Tag[]` are two statements about
    // the same relation, and a disagreement is a startup error.
    //
    // An update writes `set`, not `connect`. A multi-select submits the whole
    // intended set, so `connect` would only ever add, and removing a tag would
    // save without error and change nothing.
    {
      name: "tags",
      type: "relationship",
      relationTo: "tags",
      hasMany: true,
    },

    // A self-relation is an ordinary owning to-one. Depth expansion terminates
    // because Payload owns it, not the adapter.
    {
      name: "parent",
      type: "relationship",
      relationTo: "posts",
      custom: { prisma: { foreignKey: "parentId" } },
      admin: { position: "sidebar" },
    },
  ],
};

export const Authors: CollectionConfig = {
  slug: "authors",
  custom: { prisma: { model: "Author" } },
  timestamps: false,
  admin: { useAsTitle: "name" },
  fields: [
    { name: "name", type: "text", required: true },

    // The NON-owning side of a to-many. `blog_posts.authorId` holds the key, so
    // there is no column here to write. It reads back through an `include`, and
    // `readOnly` says so: reassigning an author's entire post list is a
    // different operation from editing an author.
    {
      name: "posts",
      type: "relationship",
      relationTo: "posts",
      hasMany: true,
      custom: { prisma: { readOnly: true } },
      admin: { readOnly: true },
    },
  ],
};

export const Tags: CollectionConfig = {
  slug: "tags",
  custom: { prisma: { model: "Tag" } },
  timestamps: false,
  admin: { useAsTitle: "label" },
  // `Tag.id` is an Int. Nothing in this file mentions that, which is the point:
  // ids are strings above the adapter and coerced back at the database
  // boundary, where the schema says what the type really is.
  fields: [{ name: "label", type: "text", required: true, unique: true }],
};
