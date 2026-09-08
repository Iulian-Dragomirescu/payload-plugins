import type { CollectionConfig } from "payload";

/**
 * Organizations, mapped onto `Organization`.
 *
 * `members` is a `join`, the reverse of `Authors.organization`. Nothing about it
 * is stored here: `authors.organizationId` holds the key, and the rows come back
 * on this collection's own read as a nested include, paginated per organization.
 */
export const Organizations: CollectionConfig = {
  slug: "organizations",
  custom: { prisma: { model: "Organization" } },
  timestamps: false,
  admin: { useAsTitle: "name" },
  fields: [
    { name: "name", type: "text", required: true },
    {
      name: "members",
      type: "join",
      collection: "authors",
      on: "organization",
      defaultSort: "name",
      defaultLimit: 5,
    },
  ],
};
