import type { CollectionConfig } from "payload";

/** Organizations, mapped onto `Organization`. The mapping with nothing odd in it. */
export const Organizations: CollectionConfig = {
  slug: "organizations",
  custom: { prisma: { model: "Organization" } },
  timestamps: false,
  admin: { useAsTitle: "name" },
  fields: [{ name: "name", type: "text", required: true }],
};
