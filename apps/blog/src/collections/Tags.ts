import type { CollectionConfig } from "payload";

/**
 * Tags, mapped onto `Tag`, whose primary key is an `Int` rather than a string.
 *
 * Ids are strings above the adapter whatever the column type, so these come
 * back as `"1"`, `"2"` and are coerced on the way into the database.
 */
export const Tags: CollectionConfig = {
  slug: "tags",
  custom: { prisma: { model: "Tag" } },
  timestamps: false,
  admin: { useAsTitle: "label" },
  fields: [{ name: "label", type: "text", required: true, unique: true }],
};
