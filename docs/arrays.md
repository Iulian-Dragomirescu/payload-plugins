# Array fields

A Payload `array` maps onto a child table you already have.

```prisma
model Quiz {
  id      String       @id @default(cuid())
  title   String
  options QuizOption[]
}

model QuizOption {
  id       String  @id @default(cuid())
  label    String
  correct  Boolean @default(false)
  position Int
  quiz     Quiz    @relation(fields: [quizId], references: [id], onDelete: Cascade)
  quizId   String
}
```

```ts
{
  name: "options",
  type: "array",
  custom: { prisma: { order: "position" } },
  fields: [
    { name: "label", type: "text", required: true },
    { name: "correct", type: "checkbox" },
  ],
}
```

One save writes the quiz and its options together. Editing a row keeps its id,
removing one deletes it.

## Which arrays become rows

An array whose Prisma field is a **relation** becomes rows in the child table.
One whose Prisma field is a **column** stays a `Json` value, as in
[Mapping](./mapping.md#structured-fields).

That is the only rule, and it is why adding this broke no existing config: an
array that worked before pointed at a column.

## Why this writes where a relationship cannot

`QuizOption.quizId` is NOT NULL, the usual shape for a row that cannot exist
without its parent. A `relationship hasMany` over it is a startup error: removing
a row would mean writing NULL into that column. See
[Relationships](./relationships.md#a-to-many-whose-children-cannot-be-detached).

An array **owns** its rows. A removal is a `deleteMany`, not a `disconnect`, so
nothing is ever set to NULL and the non-null foreign key is no obstacle.

| | reads | writes | rows the parent owns |
| --- | --- | --- | --- |
| `join` | yes | no | no |
| `relationship hasMany` | yes | yes, if the foreign key is nullable | no |
| `array` | yes | yes | yes |

## `order`

`custom.prisma.order` names a numeric column on the child. The adapter writes the
array's index into it on every save, because the submitted order **is** the
order.

It is required, unless the field sets `admin: { isSortable: false }`. A Payload
array is ordered and a table is not, so without a column the rows come back in
whatever order the database chose.

The column is not a field. Its value is the array's index, and Payload has
nothing to do with a second copy of it.

## What gets queried

Reading, on the parent's own query:

```ts
prisma.quiz.findMany({
  include: {
    options: {
      select: { id: true, label: true, correct: true },
      orderBy: [{ position: "asc" }, { id: "asc" }],
    },
  },
});
```

`select` rather than `true`, so a column the config does not declare stays out of
the document. The order ends on the primary key: without a unique tiebreaker two
rows sharing a position can come back either way round.

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

## An incoming id is a claim, not a key

Payload's admin panel gives every new row a client-side ObjectId before the
adapter sees it. A row that has never been saved arrives carrying an id that
looks real and matches nothing.

So an update reads the ids the parent actually holds first, in one query, and
only an id that read confirms is treated as an edit. Everything else is an
insert, with the placeholder dropped.

Without that step a save would delete and recreate every row it was only meant to
edit, or key an insert on a placeholder and fail against an `Int @id`.

## Nesting

An array can hold arrays, as deep as the config declares.

```ts
{
  name: "sections",
  type: "array",
  custom: { prisma: { order: "order" } },
  fields: [
    { name: "heading", type: "text", required: true },
    {
      name: "links",
      type: "array",
      custom: { prisma: { order: "order" } },
      fields: [{ name: "label", type: "text", required: true }],
    },
  ],
}
```

Still one read and one nested write. Which rows exist depends on **which row you
are inside**: two sections have different links, so the pre-read is a tree rather
than a flat set. Sending a link's id under a different section adds a new link
there rather than moving it.

Give the grandchild `onDelete: Cascade` so removing a section takes its links
with it. That is your schema's job; the adapter issues no DDL.

## What it costs

The rows stop being addressable on their own. No list view, no access control, no
hooks of their own: they are read and written as part of the parent.

Mapping the same table as both an array and a collection is possible and usually
a mistake. Two write paths reach the same rows, and the array's `deleteMany` does
not know about the collection's.

An array's subfields are not queryable or sortable. It is rows, not a column, so
`where: { "options.label": … }` has nothing to translate.

## What raises

Every one of these is a startup error naming the field and the fix.

**A to-one relation.** One row, not a list. Use a `group`.

**No order column,** unless `admin.isSortable` is `false`.

**An order column that is not numeric,** or that the database maintains.

**A many-to-many.** The child holds no foreign key back, so its rows exist
independently and other documents share them. An array would delete them. Use a
`relationship`.

**A child `@id` with no default.** The row is created as part of saving the
parent, and there is nothing there to supply an id from.

**A child column no row could fill in:** non-null, no default, and the array
declares no field for it. For a collection this is a warning, because a
collection can be a read-only view. An array is editable by definition.

**A subfield writing the foreign key or the order column.** The adapter writes
both, and a field on either would be a second writer.

## In the example app

[`apps/blog/src/collections/Posts.ts`](../apps/blog/src/collections/Posts.ts)
maps `sections` onto `post_sections`, with `links` nested onto `section_links`.
The assertions are in
[`apps/blog/src/storage.test.ts`](../apps/blog/src/storage.test.ts), against real
Postgres.
