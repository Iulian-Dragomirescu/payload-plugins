# payload-adapter-prisma

[![npm](https://img.shields.io/npm/v/payload-adapter-prisma)](https://www.npmjs.com/package/payload-adapter-prisma)

A [Payload CMS](https://payloadcms.com) database adapter for a Prisma schema you
already have.

Payload is installed, not forked. The admin panel, REST and GraphQL APIs, hooks,
access control and plugins are all upstream Payload. This package is the seam
underneath, and it does two things.

**It translates.** Reads and writes for collections and globals you map onto
models in `schema.prisma` become Prisma queries, including native relationship
writes.

**It routes.** Everything Payload needs and your schema does not, meaning admin
logins, preferences, document locks, versions, drafts, migrations and the job
queue, goes to a second database.

**It issues no DDL against your database.** No table, no column, no migration.
`prisma migrate` stays the only thing that changes your schema.

## Install

```bash
pnpm add payload-adapter-prisma
```

Peer dependency: `payload` 3.88 or newer.

You also need an adapter for Payload's own state. Any Payload adapter works:

```bash
pnpm add @payloadcms/db-mongodb
```

## Use

```ts
// payload.config.ts
import { mongooseAdapter } from "@payloadcms/db-mongodb";
import { prismaAdapter } from "payload-adapter-prisma";
import { buildConfig } from "payload";

import { PrismaClient } from "./generated/prisma/client";

const prisma = new PrismaClient({ adapter });

export default buildConfig({
  collections: [Posts, Authors, Admins],
  globals: [SiteSettings],

  db: prismaAdapter({
    prisma,
    schema: { path: "./prisma/schema.prisma" },
    internal: mongooseAdapter({ url: process.env.PAYLOAD_INTERNAL_URL! }),
  }),
});
```

```ts
// collections/Posts.ts
export const Posts: CollectionConfig = {
  slug: "posts",
  custom: { prisma: { model: "BlogPost" } },
  fields: [
    { name: "title", type: "text", required: true },
    { name: "body", type: "textarea", custom: { prisma: { field: "content" } } },
    {
      name: "author",
      type: "relationship",
      relationTo: "authors",
      custom: { prisma: { foreignKey: "authorId" } },
    },
    { name: "tags", type: "relationship", relationTo: "tags", hasMany: true },
  ],
};
```

A collection or global carrying `custom.prisma` is stored in your database.
Anything without it goes to the internal adapter, which is how Payload's own
collections stay out of your schema without anybody listing them anywhere.

## Options

```ts
prismaAdapter({
  prisma,                                   // required, your PrismaClient
  internal,                                 // required, any Payload adapter
  schema: { path: "./prisma/schema.prisma" },
  transactions: false,
});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `prisma` | required | Your client. The adapter opens no connection of its own. |
| `internal` | required | Where Payload's own state goes. |
| `schema.path` | `./prisma/schema.prisma`, then `./prisma/schema` | Where the datamodel is read from. A file, a folder of `.prisma` files, or a list of either. |
| `schema.datamodel` | none | A pre-parsed datamodel, or a Prisma 5 or 6 client. |
| `transactions` | `false` | Let the internal adapter open transactions. See [limitations](../../docs/limitations.md#transactions-are-off-by-default). |
| `idTypeMismatch` | `"reconcile"` | What to do when the internal adapter's ids are not text. See [the two databases](../../docs/two-databases.md#id-types-have-to-agree). |
| `internalCollections` | `"all"` | Whether the internal adapter is shown the mapped collections. |

## Mapping keys

| Key | Where | What it says |
| --- | --- | --- |
| `model` | collection, global | Which Prisma model backs it, and what opts it in |
| `field` | field | Which column backs this field |
| `foreignKey` | relationship | Which foreign key the relation travels over |
| `readOnly` | field | Read this column, never write it |
| `orderBy` | to-many relationship | Which order its rows come back in |
| `where` | global | Which row of the table this global is |

Everything else, meaning column types, nullability, relation ownership, the
primary key, `@updatedAt`, is read from the schema rather than restated in the
config. The two cannot drift, because only one of them says it.

## Relationship writes

| Relation | `create` | `update` |
| --- | --- | --- |
| to-one | `connect` | `connect`, or `disconnect` for `null` |
| to-many | `connect` with a list | `set`, which replaces the whole set |

`set` rather than `connect` on an update is deliberate. A multi-select submits
the complete intended set, so `connect` would only ever add, and removing a tag
in the admin panel would silently do nothing.

`set` also disconnects, so a to-many whose child holds a non-null foreign key
cannot be written this way at all. That is a startup error, not a runtime one.

## Join fields

The parent's view of a child's foreign key: paginated, sorted, filterable, never
written.

```ts
{
  name: "questions",
  type: "join",
  collection: "quiz-questions",
  on: "quiz",              // the relationship field on the child
  defaultSort: "position",
  defaultLimit: 25,
}
```

The children ride along on the parent's own read as a nested Prisma `include`, so
a page of quizzes is one query and each quiz still gets its own page of
questions. See [Join fields](../../docs/joins.md).

## Globals

A global is the first row of its table, by primary key. Read it, and if the table
is empty the first save creates it. So a global-backed table is
self-initialising, and reading it needs no CMS:

```ts
const settings = await prisma.siteSetting.findFirst();
```

## Exports

```ts
import {
  prismaAdapter,      // the adapter, for buildConfig({ db })
  describeStorage,    // which database each collection and global lives in
} from "payload-adapter-prisma";
```

Plus the mapping and schema internals, for tooling that wants to inspect a
config without booting Payload. See [`src/index.ts`](./src/index.ts).

## Examples

Runnable configurations, one per shape, in [`examples/`](./examples):

| Example | Shows |
| --- | --- |
| [`minimal`](./examples/minimal) | The smallest config that works |
| [`renamed-columns`](./examples/renamed-columns) | A schema whose names differ from the CMS's |
| [`relationships`](./examples/relationships) | Two relations to one model, many-to-many, self-relation |
| [`joins`](./examples/joins) | A parent reading its children, paginated and sorted |
| [`globals`](./examples/globals) | A global in your table, and one in Payload's |

A full app using all of them is in [`apps/blog`](../../apps/blog).

## Tests

```bash
pnpm test
```

167 unit tests. They cover the parser, the schema loader, the mapping and its
startup errors, query translation, the relationship write table, join
translation, the singleton semantics for globals, and that every example in
[`examples/`](./examples) still resolves against its own schema. None of them
touch a database.

The integration suite lives with the example app, because it needs real Postgres
and MongoDB:

```bash
pnpm --filter @repo/blog test
```

## Documentation

* [Getting started](../../docs/getting-started.md)
* [The two databases](../../docs/two-databases.md)
* [Mapping](../../docs/mapping.md)
* [Relationships](../../docs/relationships.md)
* [Join fields](../../docs/joins.md)
* [Globals](../../docs/globals.md)
* [Queries](../../docs/queries.md)
* [Limitations](../../docs/limitations.md)

## Licence

Apache-2.0.
