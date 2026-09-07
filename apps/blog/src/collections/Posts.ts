import type { CollectionConfig } from "payload";

/**
 * Posts, mapped onto `BlogPost`. Uses every mapping key the adapter has.
 *
 * The model is `BlogPost` and the table `blog_posts` while the collection is
 * `posts`, the column is `content` while the field is `body`, and two relations
 * point at `Author`, told apart by foreign key.
 */
export const Posts: CollectionConfig = {
  slug: "posts",
  // Without this line the collection would go to the internal database instead.
  custom: { prisma: { model: "BlogPost" } },
  admin: {
    useAsTitle: "title",
    defaultColumns: ["title", "author", "featured", "publishedAt"],
    description: "Mapped onto the BlogPost model in schema.prisma.",
  },
  fields: [
    {
      name: "title",
      type: "text",
      required: true,
    },
    {
      name: "slug",
      type: "text",
      required: true,
      unique: true,
      admin: { description: "Unique in schema.prisma too — the database enforces it." },
    },
    {
      name: "body",
      type: "textarea",
      custom: { prisma: { field: "content" } },
    },
    {
      name: "views",
      type: "number",
      // Something else owns this counter, so a save from the panel must not
      // clobber it.
      custom: { prisma: { readOnly: true } },
      admin: { readOnly: true, position: "sidebar" },
    },
    {
      name: "featured",
      type: "checkbox",
      admin: { position: "sidebar" },
    },
    {
      name: "publishedAt",
      type: "date",
      admin: { position: "sidebar" },
    },
    {
      name: "author",
      type: "relationship",
      relationTo: "authors",
      required: true,
      // `BlogPost` has two relations to `Author`, so the foreign key is what
      // tells this one from `reviewer`.
      custom: { prisma: { field: "author", foreignKey: "authorId" } },
    },
    {
      name: "reviewer",
      type: "relationship",
      relationTo: "authors",
      custom: { prisma: { field: "reviewer", foreignKey: "reviewerId" } },
    },
    {
      name: "tags",
      type: "relationship",
      relationTo: "tags",
      hasMany: true,
      // Implicit many-to-many: an update writes `set`, so removing a tag here
      // removes it.
      admin: { description: "Many-to-many. Tag ids are Ints in the database." },
    },
    {
      name: "parent",
      type: "relationship",
      relationTo: "posts",
      // A self-relation, so depth expansion has a cycle to terminate on.
      custom: { prisma: { field: "parent", foreignKey: "parentId" } },
      admin: { position: "sidebar" },
    },
    {
      name: "sections",
      type: "array",
      // Rows in `post_sections`, not a `Json` column. `order` names the column
      // the array's index is written into; without it the rows would come back
      // in whatever order the database chose.
      custom: { prisma: { order: "order" } },
      fields: [
        { name: "heading", type: "text", required: true },
        { name: "body", type: "textarea" },
        {
          name: "links",
          type: "array",
          // An array inside an array: `section_links` rows, reached through the
          // section they belong to. One save writes the post, its sections and
          // their links in a single nested transaction.
          custom: { prisma: { order: "order" } },
          fields: [
            { name: "label", type: "text", required: true },
            { name: "url", type: "text", required: true },
          ],
        },
      ],
      admin: {
        description:
          "Rows in post_sections. Editing one keeps its id; removing one deletes the row.",
      },
    },
  ],
};
