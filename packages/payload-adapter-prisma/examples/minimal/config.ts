import { mongooseAdapter } from "@payloadcms/db-mongodb";
import type { CollectionConfig } from "payload";
import { buildConfig } from "payload";
import { prismaAdapter } from "payload-adapter-prisma";

import { prisma } from "./prisma";

/**
 * The smallest config that works.
 *
 * `custom.prisma.model` is the only mapping key present, and every field maps
 * to a column of the same name. `createdAt` and `updatedAt` are not listed
 * because Payload adds them to every collection, and `Article` happens to have
 * both columns.
 */
const Articles: CollectionConfig = {
  slug: "articles",
  custom: { prisma: { model: "Article" } },
  admin: { useAsTitle: "title" },
  fields: [
    { name: "title", type: "text", required: true },
    { name: "body", type: "textarea" },
    { name: "published", type: "checkbox" },
  ],
};

/**
 * Payload's own logins. No `custom.prisma`, so they are stored by the internal
 * adapter, and the schema above needs no password columns.
 */
const Admins: CollectionConfig = {
  slug: "admins",
  auth: true,
  fields: [],
};

export default buildConfig({
  admin: { user: Admins.slug },
  collections: [Articles, Admins],
  secret: process.env.PAYLOAD_SECRET!,

  db: prismaAdapter({
    prisma,
    internal: mongooseAdapter({ url: process.env.PAYLOAD_INTERNAL_URL! }),
  }),
});
