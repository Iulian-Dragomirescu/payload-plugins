import type { CollectionConfig } from "payload";

/**
 * The application's own `User` table, read and written as ordinary data.
 *
 * The pair with {@link ./Admins!Admins} is the point: same subject, different
 * databases. `User` is a table in your schema, while the accounts that log in
 * to `/admin` need columns your schema does not have.
 */
export const People: CollectionConfig = {
  slug: "people",
  custom: { prisma: { model: "User" } },
  timestamps: false,
  labels: { plural: "People", singular: "Person" },
  admin: {
    useAsTitle: "name",
    defaultColumns: ["name", "email", "roles"],
    description: "The `users` table from schema.prisma — your data, not Payload's logins.",
  },
  fields: [
    { name: "name", type: "text", required: true },
    { name: "email", type: "email", required: true, unique: true },
    { name: "roles", type: "text" },
  ],
};
