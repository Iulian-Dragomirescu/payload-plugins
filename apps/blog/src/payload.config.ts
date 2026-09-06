import path from "node:path";
import { fileURLToPath } from "node:url";

import { mongooseAdapter } from "@payloadcms/db-mongodb";
import { seoPlugin } from "@payloadcms/plugin-seo";
import { lexicalEditor } from "@payloadcms/richtext-lexical";
import { prismaAdapter } from "payload-adapter-prisma";
import { buildConfig } from "payload";

import { Admins } from "./collections/Admins";
import { Authors } from "./collections/Authors";
import { Organizations } from "./collections/Organizations";
import { People } from "./collections/People";
import { Posts } from "./collections/Posts";
import { Tags } from "./collections/Tags";
import { EditorialSettings } from "./globals/EditorialSettings";
import { SiteSettings } from "./globals/SiteSettings";
import { prisma } from "./prisma";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The example's Payload config.
 *
 * Two things here are the adapter's: `db: prismaAdapter(...)`, and the
 * `custom.prisma` mapping inside each collection. Everything else is stock
 * Payload and would work unchanged on `@payloadcms/db-postgres`.
 */
export default buildConfig({
  admin: {
    user: Admins.slug,
    meta: {
      titleSuffix: " · Payload on Prisma",
    },
  },

  collections: [Posts, Authors, Tags, Organizations, People, Admins],
  // One global in each database. The only difference between them is whether
  // the config names a Prisma model.
  globals: [SiteSettings, EditorialSettings],

  editor: lexicalEditor(),
  secret: process.env.PAYLOAD_SECRET ?? "prisma-example-development-secret",

  // A plugin that adds fields to a mapped collection needs columns for them,
  // and adding those is yours to do: `meta` is a group, so it is the one
  // `Json?` column `schema.prisma` declares. A plugin that adds its own
  // collections needs nothing, they go to the internal database.
  plugins: [
    seoPlugin({
      collections: ["posts"],
      generateTitle: ({ doc }) => `${doc.title} — the adapter`,
      uploadsCollection: undefined,
    }),
  ],

  typescript: {
    outputFile: path.resolve(dirname, "payload-types.ts"),
  },

  db: prismaAdapter({
    // The client you already have. The adapter issues no DDL against it, ever.
    prisma,

    // Read from `schema.prisma`, not from the generated client: Prisma 7
    // dropped the relation metadata that says which side owns the foreign key.
    schema: { path: path.resolve(dirname, "../prisma/schema.prisma") },

    // Payload's own storage: admin logins, unmapped globals, preferences,
    // document locks, versions and drafts, migrations, the job queue. Any
    // Payload adapter works here, including a second Postgres database.
    internal: mongooseAdapter({
      url:
        process.env.PAYLOAD_INTERNAL_URL ??
        "mongodb://payload:payload@localhost:27018/payload_internal?authSource=admin",
    }),
  }),
});
