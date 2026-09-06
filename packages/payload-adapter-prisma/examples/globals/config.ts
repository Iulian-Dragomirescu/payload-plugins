import type { GlobalConfig } from "payload";

/**
 * A global backed by a table of its own.
 *
 * A global is a singleton and a table is not, so something has to say which row
 * the global is. The rule is the plainest one available: the first row, by
 * primary key. Read it, and if the table is empty the first save creates it.
 *
 * That makes the table self-initialising. You never seed it, no migration
 * inserts a placeholder, and it behaves the same whether it starts empty or
 * already holds the row.
 *
 * The payoff is that site settings become ordinary data:
 *
 *     const settings = await prisma.siteSetting.findFirst();
 *
 * A script, a background job or a server route reads them with no CMS loaded.
 */
export const SiteSettings: GlobalConfig = {
  slug: "siteSettings",
  label: "Site settings",
  custom: { prisma: { model: "SiteSetting" } },
  fields: [
    { name: "title", type: "text", required: true },
    { name: "tagline", type: "text" },
    { name: "postsPerPage", type: "number", defaultValue: 10 },
  ],
};

/**
 * Two globals sharing one table, told apart by a key column.
 *
 * `where` is written in Prisma's language rather than Payload's, because it
 * describes the storage and not the content. Nothing in the CMS should have to
 * know about it.
 *
 * It is applied to reads AND merged into creates. Writing it on create is not
 * an optimisation, it is what makes the next read find the row.
 */
export const SeoDefaults: GlobalConfig = {
  slug: "seoDefaults",
  custom: { prisma: { model: "Setting", where: { key: "seo" } } },
  fields: [{ name: "value", type: "json" }],
};

export const SocialLinks: GlobalConfig = {
  slug: "socialLinks",
  custom: { prisma: { model: "Setting", where: { key: "social" } } },
  fields: [{ name: "value", type: "json" }],
};

/**
 * A global with no table at all.
 *
 * No `custom.prisma`, so it goes to the internal database. No schema change, no
 * migration, and `pg_tables` never moves.
 *
 * This is the right home for CMS bookkeeping. How long an idle edit lock lasts
 * is a fact about the CMS, not about the publication, and giving it a table
 * would put the CMS's own state into a schema that has no reason to know about
 * it.
 *
 * The rule of thumb: if you would want to read it from a script that has never
 * heard of Payload, map it. Otherwise do not.
 */
export const EditorialSettings: GlobalConfig = {
  slug: "editorialSettings",
  fields: [
    { name: "showDraftBanner", type: "checkbox", defaultValue: true },
    { name: "lockMinutes", type: "number", defaultValue: 15 },
  ],
};
