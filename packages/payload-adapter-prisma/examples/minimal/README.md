# minimal

The smallest config that works.

## What it shows

One mapping key, `custom.prisma.model`. Every field maps to a column of the same
name, so nothing else is needed.

## What to notice

**`Admins` has no mapping.** That single omission is what keeps six columns of
password bookkeeping out of your schema. Payload's authentication works
normally, in the internal database.

**`createdAt` and `updatedAt` are not in the config.** Payload adds them to
every collection, and `Article` has both columns, so they resolve on their own.
If your table does not have them, set `timestamps: false` on the collection.

**`schema` is not passed.** It defaults to `./prisma/schema.prisma`.

## Try it

Nothing was created in your database. The check is one query:

```sql
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
```

The list is the same as before Payload started.

## Next

[`renamed-columns`](../renamed-columns), because a schema that lines up this
neatly is the exception.
