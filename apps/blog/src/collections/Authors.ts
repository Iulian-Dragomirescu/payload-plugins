import type { CollectionConfig } from "payload";

/**
 * Authors, mapped onto `Author`. Three edge cases in one config.
 *
 * `timestamps: false` because the `authors` table has no `createdAt` or
 * `updatedAt`, and the adapter will not invent the columns Payload adds by
 * default.
 *
 * `posts` and `reviewed` are both NON-OWNING sides of a to-many, and the
 * difference between them is the schema rather than the config.
 * `blog_posts.authorId` is NOT NULL, so the `set` an update writes could not
 * disconnect a post and the field has to be read-only. `blog_posts.reviewerId`
 * is nullable, so `reviewed` is writable and removing a post there works.
 *
 * `Author` declares two relations to `BlogPost`, so `custom.prisma.field` is
 * what tells them apart.
 */
export const Authors: CollectionConfig = {
  slug: "authors",
  custom: { prisma: { model: "Author" } },
  timestamps: false,
  admin: {
    useAsTitle: "name",
    defaultColumns: ["name", "email", "role", "organization"],
  },
  fields: [
    { name: "name", type: "text", required: true },
    { name: "email", type: "email", required: true, unique: true },
    { name: "role", type: "text" },
    {
      name: "organization",
      type: "relationship",
      relationTo: "organizations",
      custom: { prisma: { field: "organization", foreignKey: "organizationId" } },
    },
    {
      name: "posts",
      type: "relationship",
      relationTo: "posts",
      hasMany: true,
      custom: { prisma: { field: "posts", readOnly: true } },
      admin: {
        readOnly: true,
        description: "Read from the other side of the relation. Edit it on the post.",
      },
    },
    {
      name: "reviewed",
      type: "relationship",
      relationTo: "posts",
      hasMany: true,
      // The Payload field is `reviewed` and the Prisma relation is `reviewing`,
      // so `field` names it. Unlike `posts` above this one is WRITABLE:
      // `blog_posts.reviewerId` is nullable, so the `set` an update writes may
      // legally disconnect a post the editor removed.
      //
      // `orderBy` because an include comes back in whatever order the database
      // chose, and this list means "newest first".
      custom: { prisma: { field: "reviewing", orderBy: { publishedAt: "desc" } } },
      admin: { description: "Posts this author reviewed, newest first." },
    },
  ],
};
