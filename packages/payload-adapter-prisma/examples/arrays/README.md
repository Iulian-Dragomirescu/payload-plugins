# arrays

A parent writing its children, from the parent's own form.

## What it shows

| Shape | In the schema | In the config |
| --- | --- | --- |
| Rows in a child table | `options QuizOption[]` | `type: "array"` |
| Their order | `position Int` | `custom: { prisma: { order: "position" } }` |
| A second level | `hints QuizHint[]` | an `array` inside the array |

## Why not `relationship hasMany`

`QuizOption.quizId` is NOT NULL. A Payload update writes the whole set, which the
adapter spells `set`, and `set` disconnects every row the editor removed. That
means writing NULL into `quizId`, so the database refuses.

An array **owns** its rows. A removal is a `deleteMany`, not a `disconnect`, so
nothing is ever set to NULL.

## Why not `join`

A [join](../joins) reads the children and leaves them a collection of their own,
with their own list view, access control and hooks. An array edits them from the
parent and gives all of that up.

Use a join when the children are documents. Use an array when they are parts of
the parent.

## What gets queried

Reading, on the parent's own query:

```ts
prisma.quiz.findMany({
  include: {
    options: {
      select: {
        id: true,
        label: true,
        correct: true,
        hints: { select: { id: true, text: true }, orderBy: [{ rank: "asc" }, { id: "asc" }] },
      },
      orderBy: [{ position: "asc" }, { id: "asc" }],
    },
  },
});
```

Writing an update, as one nested transaction:

```ts
prisma.quiz.update({
  where: { id },
  data: {
    options: {
      deleteMany: { id: { notIn: ["o1"] } },
      update: [{ where: { id: "o1" }, data: { label: "Crimson", position: 0 } }],
      create: [{ label: "Green", position: 1 }],
    },
  },
});
```

The ids the parent already holds are read first, in one query. Payload's admin
panel invents a client-side ObjectId for every new row, so an incoming id is a
claim to check, never a key to write.

## What raises

**A to-one relation.** One row, not a list. Use a `group`.

**No order column,** unless `admin.isSortable` is `false`.

**A many-to-many.** Its rows are shared with other documents, and an array would
delete them. Use a `relationship`.

**A child `@id` with no default,** or a non-null child column the array does not
map. The row is created as part of saving the parent.

**A subfield writing the foreign key or the order column.** The adapter writes
both.

## Related

* [Array fields](../../../../docs/arrays.md)
* [`apps/blog/src/collections/Posts.ts`](../../../../apps/blog/src/collections/Posts.ts)
  maps `sections` onto `post_sections` with `links` nested underneath, and
  [`apps/blog/src/storage.test.ts`](../../../../apps/blog/src/storage.test.ts)
  checks it against real Postgres.

## Next

[`globals`](../globals).
