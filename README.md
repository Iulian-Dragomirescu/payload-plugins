# Payload CMS Packages

Packages for [Payload CMS](https://payloadcms.com). Today there is one: a
database adapter that runs Payload on a Prisma schema you already have, without
letting the CMS touch that schema.

Drop it into an existing Payload project, or see it working end to end in
[`apps/blog`](./apps/blog), a runnable app on a deliberately awkward schema.

## Quick start

```bash
pnpm add payload-adapter-prisma
```

```ts
// payload.config.ts
import { mongooseAdapter } from "@payloadcms/db-mongodb";
import { prismaAdapter } from "payload-adapter-prisma";
import { buildConfig } from "payload";

export default buildConfig({
  collections: [Posts, Authors, Admins],
  db: prismaAdapter({
    prisma,                                                      // your client
    internal: mongooseAdapter({ url: process.env.PAYLOAD_INTERNAL_URL! }),
  }),
});
```

```ts
// collections/Posts.ts, an ordinary Payload collection plus one line
export const Posts: CollectionConfig = {
  slug: "posts",
  custom: { prisma: { model: "BlogPost" } },
  fields: [
    { name: "title", type: "text", required: true },
    { name: "body", type: "textarea", custom: { prisma: { field: "content" } } },
    { name: "tags", type: "relationship", relationTo: "tags", hasMany: true },
  ],
};
```

Full walkthrough in [docs/getting-started.md](./docs/getting-started.md).

## Packages

| Package | Version | Description |
| --- | --- | --- |
| [`payload-adapter-prisma`](./packages/payload-adapter-prisma) | [![npm](https://img.shields.io/npm/v/payload-adapter-prisma)](https://www.npmjs.com/package/payload-adapter-prisma) | Payload database adapter for an existing Prisma schema |

## Prisma adapter for Payload CMS

Payload is installed, not forked. You get its admin panel, its REST and GraphQL
APIs, its hooks, its access control and its plugins, upstream and unmodified,
upgraded with `pnpm update payload`.

This adapter is the one seam underneath, and it does exactly two things.

**It translates.** Reads and writes for collections and globals you map onto
models in `schema.prisma` become Prisma queries, including native relationship
writes, which is the part a mapping layer usually gets wrong.

**It routes.** Everything Payload needs and your schema does not, meaning admin
logins, preferences, document locks, versions, drafts, migrations and the job
queue, goes to a second database.

The result is that `prisma migrate` stays the only thing that changes your
schema. The adapter issues no DDL against it. It creates no table, adds no
column, and writes no migration.

```bash
npm  install payload-adapter-prisma
yarn add     payload-adapter-prisma
pnpm add     payload-adapter-prisma
bun  add     payload-adapter-prisma
```

* Package: [`payload-adapter-prisma`](./packages/payload-adapter-prisma)
* Documentation: [`docs/`](./docs)

### Why

You have a Postgres database and a Prisma schema. You want a CMS over part of
it. Every CMS you try wants to own the schema. It generates tables, it insists on
its own id column, it adds a prefix to things, and now your schema is half yours
and half its.

This inverts that. Your schema is the input. The config is a view onto it.

### What you get

| | |
| --- | --- |
| Admin panel | Payload's own, mounted the standard way |
| REST and GraphQL | Payload's own, over your tables |
| Authentication | Works out of the box, in Payload's database |
| Plugins | Work, including ones that add fields |
| Relationships | Native `connect`, `set` and `disconnect` |
| Globals | In your schema or in Payload's, your choice |
| Your database | Untouched, and there is a test that proves it |

## Run the demo locally

[`apps/blog`](./apps/blog) is a full Payload app on a schema written to be
awkward in the ways real schemas are awkward: renamed tables, renamed columns,
two relations to the same model, an `Int` primary key, a self-relation, and
tables with no timestamp columns.

### Prerequisites

* Node.js 20 or newer
* pnpm 10
* Docker, for Postgres and MongoDB

### Steps

1. **Clone and install**

   ```bash
   git clone https://github.com/Iulian-Dragomirescu/payload-plugins.git
   cd payload-plugins
   pnpm install
   ```

2. **Start the databases and prepare the schema**

   ```bash
   pnpm --filter @repo/blog setup
   ```

   This starts the containers in `apps/blog/docker-compose.yml`, pushes
   `schema.prisma` to Postgres, generates the Prisma client, and writes
   Payload's import map.

3. **Seed content and an admin login**

   ```bash
   pnpm --filter @repo/blog seed
   ```

   It creates `admin@example.com` with the password `payload`, and narrates
   which database every write lands in.

4. **Start the app**

   ```bash
   pnpm dev
   ```

5. **Open the admin panel**

   Visit [http://localhost:3000/admin](http://localhost:3000/admin) and log in.

### Verify the claim

```bash
pnpm --filter @repo/blog test
```

25 integration tests against real Postgres and MongoDB. Several of them query
`pg_tables` and `information_schema` directly, rather than asserting in prose,
to check that nothing was created in your database and that no password hash
column exists in it.

## Repository layout

```
apps/
  blog/                        Runnable Payload app, demo and integration suite
packages/                      One directory per published package
  payload-adapter-prisma/
docs/                          Documentation and decision records
tsconfig.base.json             Compiler settings every workspace extends
```

`packages/` holds published packages and nothing else, so a new directory there
is always something that ships.

## Contributing

Issues, discussions and pull requests are welcome.

Commits follow [Conventional Commits](https://www.conventionalcommits.org).
Releases are automated per package, and which files a commit touched decides
which package is released. See [CLAUDE.md](./CLAUDE.md) for the development
guide.

## Licence

Apache-2.0. See [LICENSE](./LICENSE).
