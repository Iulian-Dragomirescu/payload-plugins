import type { CollectionConfig } from "payload";

/**
 * Authors, mapped onto `Author`. Two edge cases in one config.
 *
 * `timestamps: false` because the `authors` table has no `createdAt` or
 * `updatedAt`, and the adapter will not invent the columns Payload adds by
 * default.
 *
 * `posts` is the NON-OWNING side of a relation: `blog_posts.authorId` holds the
 * key, so there is no column here to write, and the field is read-only.
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
  ],
};
