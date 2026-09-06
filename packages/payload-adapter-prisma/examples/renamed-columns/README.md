# renamed-columns

A schema that was not written for a CMS, which is the normal case.

## What it shows

| Difference | Key |
| --- | --- |
| The slug is `posts`, the model is `BlogPost` | `model` |
| The field is `body`, the column is `content` | `field` |
| A trigger owns `view_count` | `readOnly` |
| `authors` has no timestamp columns | `timestamps: false` on the collection |

## What to notice

**`@map("view_count")` is never mentioned in the config.** Prisma already knows
the column name, and the adapter reads it from the schema. The config names the
Prisma field, not the database column.

**`updatedAt` needs no key.** The adapter sees `@updatedAt` in the schema and
marks it read-only on its own. Prisma maintains that column, so writing it is an
error rather than a preference, and it is not left to the config to remember.

**`readOnly` appears twice, in two different places.** `custom.prisma.readOnly`
drops the field from writes. `admin.readOnly` stops the input being editable.
They are different things and you usually want both.

**`timestamps: false` is a Payload option, not one of ours.** The adapter does
not need a key for this, because Payload already has one.

## What happens if you get it wrong

Every mapping is resolved when Payload boots, so a mismatch is a startup error
naming the fix rather than a surprise on the first list view:

```
[prisma-adapter] Collection "posts" field "body" maps to "BlogPost.bodyText",
which does not exist.
Fields on "BlogPost": id, title, slug, content, viewCount, publishedAt,
createdAt, updatedAt
Set `custom: { prisma: { field: "…" } }` on the field, or add the column to your
schema.
```

## Next

[`relationships`](../relationships).
