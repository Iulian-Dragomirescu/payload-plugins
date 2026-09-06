# globals

A global is a singleton. A table is not.

## The rule

**The first row, by primary key.** Read it. If the table is empty, the first save
creates it.

So a global-backed table is self-initialising. You never seed it, no migration
inserts a placeholder row, and it behaves the same whether it starts empty or
already holds the row.

## What it shows

| Global | Storage |
| --- | --- |
| `siteSettings` | Its own table, one row |
| `seoDefaults` | A shared table, the row where `key = 'seo'` |
| `socialLinks` | The same table, the row where `key = 'social'` |
| `editorialSettings` | Payload's database, no table at all |

## What to notice

**The choice is per global, and it is one line.** Remove `custom.prisma` and a
global still works. It just moves.

**`where` is Prisma's language, not Payload's.** It describes the storage rather
than the content, and nothing in the CMS has to know about it.

**`where` is written on create, not only matched on read.** Otherwise the row a
first save makes would not be the row the next read finds.

**Timestamps are dropped rather than raised.** Payload adds `createdAt` and
`updatedAt` to every global, and unlike a collection there is no
`timestamps: false` to turn them off. So for globals, a timestamp field whose
column does not exist is skipped. Without that, a global could almost never map
onto a table that was not designed for a CMS.

## Why map one at all

```ts
const settings = await prisma.siteSetting.findFirst();
```

That is the whole reason. A script, a background job or a server route reads
your site settings with no CMS loaded, because they are ordinary rows in an
ordinary table.

## What globals do not get from Prisma

**Versions and drafts** stay in the internal store. A table holding one row has
nowhere to put a history.

**Moving a global between the two databases does not migrate its content.** The
old copy is simply never read again.

## Verified where

* [`globals.test.ts`](../../src/globals.test.ts) checks the query itself against
  a recording stub: that the read is ordered by primary key, and that the
  discriminator is written on create. A real database holding one row would
  answer correctly for the wrong query just as easily as the right one.
* [`apps/blog/src/storage.test.ts`](../../../../apps/blog/src/storage.test.ts)
  checks the behaviour against real Postgres, including that an empty table gets
  its row on the first save and that repeated saves never insert a second.
