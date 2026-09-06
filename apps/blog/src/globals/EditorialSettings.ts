import type { GlobalConfig } from "payload";

/**
 * A global with no table behind it.
 *
 * No `custom.prisma`, so it goes to the internal database and `schema.prisma`
 * does not change. The rule of thumb for the choice: if you would want to read
 * it from a script that has never heard of Payload, map it. Otherwise leave it
 * here.
 *
 * @see {@link ./SiteSettings!SiteSettings} for the mapped case
 */
export const EditorialSettings: GlobalConfig = {
  slug: "editorialSettings",
  label: "Editorial settings",
  admin: {
    description: "Stored in the internal database. Your Postgres never sees it.",
  },
  fields: [
    {
      name: "showDraftBanner",
      type: "checkbox",
      defaultValue: true,
      label: "Warn editors when viewing a draft",
    },
    {
      name: "lockMinutes",
      type: "number",
      defaultValue: 15,
      label: "Minutes before an idle edit lock expires",
    },
  ],
};
