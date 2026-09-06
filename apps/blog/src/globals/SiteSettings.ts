import type { GlobalConfig } from "payload";

/**
 * A global stored in your database, as one row of `site_settings`.
 *
 * A global is a singleton and a table is not, so something has to say which row
 * the global is: it is the first row by primary key, and the first save creates
 * it if the table is empty. The table needs no seed row and no migration that
 * inserts one.
 *
 * @see {@link ./EditorialSettings!EditorialSettings} for the other choice
 */
export const SiteSettings: GlobalConfig = {
  slug: "siteSettings",
  label: "Site settings",
  // Remove this line and the global still works, it just moves to the internal
  // database.
  custom: { prisma: { model: "SiteSetting", } },
  admin: {
    description: "One row of `site_settings` in your Postgres. Readable straight from Prisma.",
  },
  fields: [
    { name: "title", type: "text", required: true, defaultValue: "Payload on Prisma" },
    { name: "tagline", type: "text" },
    { name: "postsPerPage", type: "number", defaultValue: 10 },
  ],
};
