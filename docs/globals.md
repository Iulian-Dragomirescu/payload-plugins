# Globals

A global is a singleton. A table is not. Something has to say which row of the
table the global is.

## The rule

**The first row, by primary key.** Read it. If the table is empty, the first save
creates it.

That makes a global-backed table self-initialising. You never seed it, no
migration inserts a placeholder row, and it behaves the same whether it starts
empty or already holds the row.

## Mapping one

Add a model:

```prisma
model SiteSetting {
  id           String  @id @default(cuid())
  title        String  @default("My site")
  tagline      String?
  postsPerPage Int     @default(10)

  @@map("site_settings")
}
```

Point the global at it:

```ts
import type { GlobalConfig } from "payload";

export const SiteSettings: GlobalConfig = {
  slug: "siteSettings",
  custom: { prisma: { model: "SiteSetting" } },
  fields: [
    { name: "title", type: "text", required: true },
    { name: "tagline", type: "text" },
    { name: "postsPerPage", type: "number", defaultValue: 10 },
  ],
};
```

Nothing in that table belongs to the CMS. No discriminator column, no prefix, no
marker row. It is an ordinary table that happens to hold one row, which is the
point:

```ts
const settings = await prisma.siteSetting.findFirst();
```

A script, a background job or a server route reads your site settings with no
CMS loaded.

## Several globals in one table

A common shape is one settings table with a key column:

```prisma
model Setting {
  id    String @id @default(cuid())
  key   String @unique
  value Json
}
```

Say which row each global is:

```ts
custom: { prisma: { model: "Setting", where: { key: "site" } } }
```

`where` is written in Prisma's language rather than Payload's, because it
describes the storage and not the content. Nothing in the CMS should have to know
about it.

It is applied to reads and merged into creates, so the row it finds is the row a
first save makes. Writing it on create is not an optimisation, it is what makes
the read work at all.

## Leaving a global unmapped

Drop `custom.prisma` and the global goes to the internal database. No table, no
schema change, no migration.

```ts
export const EditorialSettings: GlobalConfig = {
  slug: "editorialSettings",
  fields: [
    { name: "showDraftBanner", type: "checkbox", defaultValue: true },
    { name: "lockMinutes", type: "number", defaultValue: 15 },
  ],
};
```

That is the right home for CMS bookkeeping. How long an idle edit lock lasts is a
fact about the CMS, not about the publication. Giving it a table puts the CMS's
own state into a schema that has no reason to know about it.

The rule of thumb, again: if you would want to read it from a script that has
never heard of Payload, map it. Otherwise do not.

## Timestamps

Payload adds `createdAt` and `updatedAt` to every global, and unlike a collection
there is no `timestamps: false` to turn them off.

So for globals, and only for globals, a timestamp field whose column does not
exist is dropped rather than raised as an error. Without that, a global could
almost never map onto a table that was not designed for a CMS, which is the
whole point.

A timestamp column that does exist is mapped normally, and an `@updatedAt` one is
still read-only.

## What globals do not get from Prisma

**Versions and drafts** stay in the internal store. A table holding one row has
nowhere to put a history.

**Moving a global between the two databases does not migrate its content.** The
old copy is simply never read again. Copy it across yourself if you need it.

## Checking the behaviour

The example asserts each part of the rule against real Postgres:

```ts
it("creates its row on the first save, so the table needs no seeding", …)
it("updates the same row rather than inserting another", …)
it("is readable straight from the database, with no CMS involved", …)
```

The singleton query itself is checked against a recording stub in
[`packages/payload-adapter-prisma/src/globals.test.ts`](../packages/payload-adapter-prisma/src/globals.test.ts),
because what matters there is the query, that the read is ordered and that the
discriminator is written on create. A real database with one row in it would
answer correctly for the wrong query just as easily as the right one.
