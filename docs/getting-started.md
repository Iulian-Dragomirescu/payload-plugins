# Getting started

You have a Postgres database and a `schema.prisma` that describes it. You want a
CMS over part of it, and you want your schema left alone.

By the end of this page you have Payload's admin panel editing your own tables.

## 1. Install

```bash
pnpm add payload @payloadcms/next @payloadcms/ui @payloadcms/richtext-lexical
pnpm add @payloadcms/db-mongodb
pnpm add payload-adapter-prisma
```

`@payloadcms/db-mongodb` is not a second database for your content. It is where
Payload keeps its own state, which is explained in [The two
databases](./two-databases.md). Any Payload adapter works there, including
`@payloadcms/db-postgres` pointed at a separate database.

## 2. Describe one collection

Take a model you already have:

```prisma
model BlogPost {
  id      String  @id @default(cuid())
  title   String
  content String?

  author   Author @relation(fields: [authorId], references: [id])
  authorId String

  @@map("blog_posts")
}
```

Write the collection that edits it. This is an ordinary Payload collection with
one extra line:

```ts
// collections/Posts.ts
import type { CollectionConfig } from "payload";

export const Posts: CollectionConfig = {
  slug: "posts",
  custom: { prisma: { model: "BlogPost" } },
  timestamps: false,
  fields: [
    { name: "title", type: "text", required: true },
    { name: "body", type: "textarea", custom: { prisma: { field: "content" } } },
    { name: "author", type: "relationship", relationTo: "authors" },
  ],
};
```

Three things are worth noticing.

`custom.prisma.model` names the model. Its presence is also what opts the
collection in. A collection without it is stored by the internal adapter, which
is how Payload's own collections stay out of your database.

`custom.prisma.field` names the column when it differs from the field. The
schema keeps the name it already had.

`timestamps: false` because `blog_posts` has no `createdAt` or `updatedAt`.
Payload adds both to every collection by default, and the adapter will not
invent columns for them. If your table has them, leave this out.

## 3. Wire up the adapter

```ts
// payload.config.ts
import { mongooseAdapter } from "@payloadcms/db-mongodb";
import { prismaAdapter } from "payload-adapter-prisma";
import { buildConfig } from "payload";

import { Admins } from "./collections/Admins";
import { Authors } from "./collections/Authors";
import { Posts } from "./collections/Posts";
import { prisma } from "./prisma";

export default buildConfig({
  admin: { user: Admins.slug },
  collections: [Posts, Authors, Admins],
  secret: process.env.PAYLOAD_SECRET!,

  db: prismaAdapter({
    prisma,
    schema: { path: "./prisma/schema.prisma" },
    internal: mongooseAdapter({ url: process.env.PAYLOAD_INTERNAL_URL! }),
  }),
});
```

`prisma` is your own client, opened the way you would open it without a CMS. The
adapter opens no connection of its own. Every query goes through the client you
pass, so your pooling, logging and extensions all still apply.

### If your schema is a folder

Prisma 7 gives new projects `prismaSchemaFolder`, so the schema is a directory of
files rather than one:

```
prisma/
  schema/
    schema.prisma
    models/
      quiz.prisma
      user.prisma
```

Point `schema.path` at the folder. Every `.prisma` file under it is read
recursively and concatenated before parsing, which is what lets a relation
declared in one file resolve against a model in another:

```ts
db: prismaAdapter({
  prisma,
  schema: { path: "./prisma/schema" },
  internal: mongooseAdapter({ url: process.env.PAYLOAD_INTERNAL_URL! }),
})
```

A list works too, for a layout that is neither: `path: ["./prisma/base.prisma",
"./prisma/models"]`.

With no `schema` at all the adapter looks for `./prisma/schema.prisma` and then
`./prisma/schema`, so both standard layouts need no configuration.

## 4. Add an admin collection

Payload needs somewhere to keep the accounts that log in. Give it a collection
with no mapping:

```ts
// collections/Admins.ts
import type { CollectionConfig } from "payload";

export const Admins: CollectionConfig = {
  slug: "admins",
  auth: true,
  fields: [{ name: "name", type: "text" }],
};
```

No `custom.prisma`, so it goes to the internal database, and Payload's
authentication works exactly as it does on any other adapter. The alternative
would be adding `hash`, `salt`, `resetPasswordToken`, `resetPasswordExpiration`,
`loginAttempts` and `lockUntil` columns to your schema. Payload needs them, your
schema should not have to carry them.

## 5. Mount the admin panel

These are Payload's standard files. Nothing about running on Prisma changes
them, so copy them from `create-payload-app` or from
[`apps/blog/src/app`](../apps/blog/src/app) in this repo:

```
app/(payload)/layout.tsx
app/(payload)/admin/[[...segments]]/page.tsx
app/(payload)/admin/[[...segments]]/not-found.tsx
app/(payload)/api/[...slug]/route.ts
app/(payload)/api/graphql/route.ts
```

Then generate the import map and start:

```bash
npx payload generate:importmap
npx next dev
```

Open `/admin`, create the first user, and the list view shows rows from
`blog_posts`.

## 6. Check what you got

Nothing was created in your database. Confirm it rather than take it on trust:

```sql
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
```

The list is the same as before you started. To see the split from the
application side:

```ts
import { describeStorage } from "payload-adapter-prisma";

console.table(describeStorage({ payload }));
// prisma:   [ 'posts', 'authors' ]
// internal: [ 'admins', 'payload-preferences', 'payload-locked-documents', ... ]
```

## When something does not resolve

Every mapping is checked when Payload boots, so a mismatch is a startup error
rather than a surprise on the first list view:

```
[prisma-adapter] Collection "posts" field "body" maps to "BlogPost.bodyText",
which does not exist.
Fields on "BlogPost": id, title, slug, content, views, featured, publishedAt
Set `custom: { prisma: { field: "…" } }` on the field, or add the column to your
schema.
```

## Next

* [The two databases](./two-databases.md) explains what lands where.
* [Mapping](./mapping.md) covers every key in `custom.prisma`.
* [Relationships](./relationships.md) is the part worth reading closely.
