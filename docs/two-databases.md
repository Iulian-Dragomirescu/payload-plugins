# The two databases

A CMS needs state your domain does not have. This page explains where that state
goes, and why it is not in your schema.

## The split

```
┌──────────────────────────────┐   ┌───────────────────────────────┐
│  YOUR database (Postgres)    │   │  PAYLOAD's database           │
│  schema.prisma owns it       │   │  Mongo, or a second Postgres  │
├──────────────────────────────┤   ├───────────────────────────────┤
│  blog_posts                  │   │  admins (logins, hashes)      │
│  authors                     │   │  payload-preferences          │
│  tags                        │   │  payload-locked-documents     │
│  organizations               │   │  payload-migrations           │
│  site_settings   (a global)  │   │  versions and drafts          │
│                              │   │  unmapped globals             │
│  nothing was created here    │   │  Payload owns all of this     │
└──────────────────────────────┘   └───────────────────────────────┘
       DATABASE_URL                     PAYLOAD_INTERNAL_URL
```

## Why not one database

Take the accounts that log in to `/admin`. Payload needs six columns for them:
`hash`, `salt`, `resetPasswordToken`, `resetPasswordExpiration`, `loginAttempts`
and `lockUntil`. Every one of those is about the CMS, not about your
application.

Putting them in your schema means the CMS writes DDL against a database it does
not own. Then it needs a migration table to track what it wrote. Then the
document locks, the per-user column preferences, the draft snapshots. Before
long your schema is half yours and half the CMS's, and `prisma migrate diff`
proposes dropping things it has never heard of.

So they go somewhere else. Payload gets a database of its own, and everything it
needs that your domain does not have lives there.

## What decides the split

One thing: whether a collection or global carries `custom.prisma`.

```ts
custom: { prisma: { model: "BlogPost" } }   // your database
// no custom.prisma                          // Payload's database
```

Opting in explicitly rather than by matching names is deliberate. Payload adds
`payload-preferences`, `payload-locked-documents` and `payload-migrations` to
every config it builds. A naming coincidence must never be able to route one of
those into your database, so nothing is inferred.

The rule of thumb for your own configs: if you would want to read it from a
script that has never heard of Payload, map it. Otherwise leave it unmapped.

## What always goes to the internal adapter

Whatever you map, these never reach your database:

| Thing | Why |
| --- | --- |
| Admin accounts and sessions | Six columns of CMS bookkeeping |
| Versions and drafts | A snapshot per save, in a table per collection |
| Document locks | Which editor has a document open right now |
| Admin preferences | Column widths and sort order, per user |
| The migrations table | Payload's own migration history |
| The job queue | Background work Payload schedules |
| Unmapped globals | See [Globals](./globals.md) |

Version methods stay internal even for a mapped collection. A draft is a row in
the versions store, so querying drafts is a query against the internal database
whichever database holds the published document.

## Choosing the internal adapter

`internal` takes any Payload database adapter.

```ts
// MongoDB, a different engine entirely
internal: mongooseAdapter({ url: process.env.PAYLOAD_INTERNAL_URL! })

// or Postgres, in a second database
internal: postgresAdapter({ pool: { connectionString: process.env.PAYLOAD_INTERNAL_URL } })
```

MongoDB makes the boundary hard to blur by accident, since Prisma has never
heard of it. A second Postgres database is closer to home and lets you back both
up the same way. Either is fine. The split is identical.

Point the internal adapter at the same database as your Prisma schema and you
have given up the guarantee this package exists for.

### Id types have to agree

Payload keeps ONE `db.defaultIDType` for the whole config, and this adapter is
what answers it. It answers `"text"`, because ids are strings above the adapter
whatever the column type. See [ADR 0003](./adr/0003-ids-are-strings.md).

`postgresAdapter` without `idType` uses `serial`, so the collections it stores
have NUMERIC ids. Payload then validates a relationship as

```ts
collections[slug].customIDType || db.defaultIDType   // "text"
```

and rejects every numeric id it is given. What that looks like is not an id
error. `payload-preferences.user` fails validation on every list view, so the
admin panel cannot save its column state and **every list comes back blank**,
with a message naming a field called "User".

The adapter settles this at startup. It sets `customIDType` on the collections
routed to the internal adapter, which Payload consults ahead of
`db.defaultIDType`, and logs one line saying it did:

```
[prisma-adapter] The internal adapter stores number ids and this adapter reports
text, so `customIDType: "number"` was set on the 6 collections it stores.
```

Two other settings, if you would rather it did not:

```ts
prismaAdapter({ …, idTypeMismatch: "error" })    // refuse to start, naming both types
prismaAdapter({ …, idTypeMismatch: "ignore" })   // leave it alone
```

The other way out is giving the internal adapter text ids in the first place,
which is one line and avoids the question:

```ts
internal: postgresAdapter({ idType: "uuid", pool: { connectionString: … } })
```

The same disagreement runs the other way too. The internal adapter stores rows
that point BACK at your documents: a document lock, a preference, a version. A
Mongo internal adapter casts a relationship's value to an `ObjectId` unless the
target collection's config declares an `id` field, and a cuid is not one, so it
throws from inside BSON.

`db.defaultIDType` cannot answer this, because there is one of it and two
answers. The per-collection answer is an `id` field in the config, so the adapter
declares a hidden one on every mapped collection at startup. Payload derives
`customIDType` from the same field.

Without it, editing a saved document fails while creating one works: the admin
panel takes a lock the moment you touch the form, and a new document has no id
yet.

### Empty tables for mapped collections

The internal adapter is handed the whole config, so an adapter in push mode
materialises storage for the Prisma-backed collections too. Those tables are
never read, but they are there.

They have a job: versions, drafts, document locks and admin preferences for a
mapped collection are all stored internally, and the adapter can only do that if
it knows the collection exists. If your mapped collections have none of those,
hide them:

```ts
prismaAdapter({ …, internalCollections: "unmapped" })
```

## One connection to your database

The adapter opens no connection of its own. It reads the datamodel from
`schema.prisma` and sends every query through the `PrismaClient` you passed, so
there is one pool against your database rather than two, and your logging,
pooling and Prisma extensions all apply to the admin panel as well.

## Proving it

Claims about a database are worth checking against the database. The example app
does this in its test suite rather than in prose:

```ts
it("adds no table to `public`, every one is from schema.prisma", async () => {
  const { rows } = await sql.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  expect(rows.map((row) => row.tablename)).toEqual(SCHEMA_TABLES);
});

it("keeps admin logins out of your database entirely", async () => {
  const { rows } = await sql.query(
    `SELECT count(*) FROM information_schema.columns
     WHERE table_schema = 'public'
       AND column_name IN ('hash', 'salt', 'resetPasswordToken', 'loginAttempts')`,
  );
  expect(rows[0].count).toBe("0");
});
```

See [`apps/blog/src/storage.test.ts`](../apps/blog/src/storage.test.ts).

## Related

* [ADR 0002](./adr/0002-two-databases.md) records the decision and what it costs.
* [ADR 0004](./adr/0004-no-cross-store-transactions.md) explains why transactions
  are off by default.
