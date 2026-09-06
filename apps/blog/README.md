# @repo/blog

A complete Payload CMS app on an ordinary Prisma schema. It is the demo and the
integration suite at the same time, which is why it is not throwaway code.

It imports `payload` and `payload-adapter-prisma` exactly as an installed
project would, so this directory doubles as the template for starting your own.

## Run it

```bash
pnpm setup     # docker compose up, db push, prisma generate, import map
pnpm seed      # an admin login, some content, and a narrated tour of both databases
pnpm dev       # http://localhost:3000/admin
```

`pnpm seed` prints the login it creates: **admin@example.com / payload**.

```bash
pnpm test      # 25 integration tests against real Postgres and MongoDB
pnpm db:down   # stop the containers and delete the volumes
```

The suite writes to the same database the dev server reads, and one test empties
`site_settings` to check that a global creates its own row. Running both at once
can make a count-sensitive assertion fail. Stop `pnpm dev` first, or accept the
occasional re-run.

## What to click through

`/admin` is Payload's admin panel. Not a copy of it and not a port, but the
`@payloadcms/next` package, mounted the way `create-payload-app` mounts it.

Each collection demonstrates a different part of the mapping.

**Posts** is the interesting one. `Body` edits the `content` column. `Author` and
`Reviewer` are two pickers over the same `Author` model, told apart by their
foreign keys. `Tags` is a many-to-many written with `set`, so removing a tag
actually removes it. `Views` is read-only. `Parent` is a self-relation. The
**SEO** tab is `@payloadcms/plugin-seo`, storing into a `Json` column.

**Tags** has an `Int @default(autoincrement())` primary key. Payload still sees
string ids.

**People** is the `users` table from `schema.prisma`. Your data.

**Admins** are the accounts that log in, and they are not in your database. This
is the clearest illustration of the split: both collections are about people, and
they live in different databases for a reason that has nothing to do with the
word "user".

**Site settings**, under Globals, is one row of `site_settings` in your Postgres.
The table starts empty and the first save creates the row, so nothing seeds it.
`prisma.siteSetting.findFirst()` reads it with no CMS loaded.

**Editorial settings**, also under Globals, is the same API with no table at all.
It reads and writes MongoDB, and `pg_tables` never changes. The only difference
between the two globals is one line of config.

## The two databases

`docker-compose.yml` brings up two.

**Postgres on 5433** holds your data. `schema.prisma` describes it, Prisma owns
every table in it, and the adapter creates none of its own.

**MongoDB on 27018** holds Payload's state: logins, preferences, locks, versions,
migrations, and any global you did not map. None of it belongs in your schema, so
none of it goes there.

Both use non-default host ports so an existing local Postgres or Mongo keeps
working.

Prefer one engine? Swap `mongooseAdapter` for `postgresAdapter` pointed at a
second database. The split is the same, the internal side just uses tables.

## What to read, in order

| File | What it shows |
| --- | --- |
| [`prisma/schema.prisma`](prisma/schema.prisma) | An ordinary schema. Nothing in it is Payload's. |
| [`src/payload.config.ts`](src/payload.config.ts) | An ordinary Payload config. Two lines are the adapter's. |
| [`src/collections/Posts.ts`](src/collections/Posts.ts) | Every mapping key, each one earning its place. |
| [`src/collections/People.ts`](src/collections/People.ts) | Your `users` table, mapped. |
| [`src/collections/Admins.ts`](src/collections/Admins.ts) | Payload's logins, unmapped, so internal. |
| [`src/globals/SiteSettings.ts`](src/globals/SiteSettings.ts) | A global stored as one row of your own table. |
| [`src/globals/EditorialSettings.ts`](src/globals/EditorialSettings.ts) | The same thing with no table at all. |
| [`src/seed.ts`](src/seed.ts) | A narrated tour: create, relate, update, and where each write lands. |
| [`src/storage.test.ts`](src/storage.test.ts) | The same operations, asserted against raw SQL. |
| [`src/app/(payload)/`](<src/app/(payload)>) | Payload's standard route files, unmodified. |

## What the schema is doing

It is deliberately awkward, in the ways a real schema is awkward.

`BlogPost` is mapped to `blog_posts` and the collection is called `posts`, so
`custom: { prisma: { model: "BlogPost" } }` is load-bearing.

The column is `content` and the field is `body`, so `field: "content"` is
load-bearing.

`BlogPost` has **two** relations to `Author`, so `foreignKey: "authorId"` is
load-bearing.

`Tag.id` is an `Int @default(autoincrement())` rather than a string, so id
coercion is exercised.

`BlogPost.parent` is a self-relation, so depth expansion has a cycle to
terminate on.

`updatedAt` is `@updatedAt`, so there is a column the adapter must never write.

`SiteSetting` is a one-row table backing a global, so "the first row, by primary
key" is exercised against a table that starts empty.

`authors`, `tags`, `organizations` and `users` have no timestamp columns, so
those collections set `timestamps: false`. The adapter will not invent columns
Payload expects.

If it works here, it works on a schema that was not designed for it.

## The proof

Five of the integration tests are the ones that matter most:

```ts
it("adds no table to `public`, every one is from schema.prisma", …)
it("adds no schema to your database either", …)
it("keeps admin logins out of your database entirely", …)
it("REPLACES a to-many on update, so removing actually removes", …)
it("creates its row on the first save, so the table needs no seeding", …)
```

Every one of them queries Postgres directly rather than asserting the claim in
prose.

## Prisma 7

This app is on Prisma 7, which changes three things.

The datasource block has no `url`. It moved to
[`prisma.config.ts`](prisma.config.ts).

The generator is `prisma-client`, which is ESM, with an explicit `output`, so the
client is imported from `./generated/prisma/client`.

A driver adapter, `@prisma/adapter-pg`, holds the connection.

The adapter reads `schema.prisma` rather than the generated client, because
Prisma 7's client no longer carries the relation metadata the mapping needs. See
[ADR 0001](../../docs/adr/0001-schema-file-is-the-source-of-truth.md).
