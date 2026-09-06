import type { CollectionConfig } from "payload";

/**
 * The accounts that log in to `/admin`.
 *
 * No `custom.prisma`, so this collection is stored by the internal adapter.
 * Mapping it would mean adding `hash`, `salt`, `resetPasswordToken`,
 * `loginAttempts` and `lockUntil` columns to your schema.
 *
 * @see {@link ./People!People} for the `User` table that IS in your schema
 */
export const Admins: CollectionConfig = {
  slug: "admins",
  auth: true,
  labels: { plural: "Admins", singular: "Admin" },
  admin: {
    useAsTitle: "email",
    description: "Payload's own logins. Stored in the internal database, never in Postgres.",
  },
  fields: [
    { name: "name", type: "text" },
    {
      name: "role",
      type: "select",
      defaultValue: "editor",
      options: [
        { label: "Admin", value: "admin" },
        { label: "Editor", value: "editor" },
      ],
    },
  ],
};
