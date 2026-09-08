# Join fields

In an existing schema, parent to children is everywhere. A quiz has questions, a
question has options, a wheel has segments. The child holds the foreign key, and
the parent holds nothing at all.

Payload's `join` field is the parent's view of that. It is a reverse lookup:
paginated, sorted, filterable, and never written.

```prisma
model Quiz {
  id        String         @id @default(cuid())
  title     String
  questions QuizQuestion[]
}

model QuizQuestion {
  id       String @id @default(cuid())
  prompt   String
  position Int    @default(0)
  quiz     Quiz   @relation(fields: [quizId], references: [id], onDelete: Cascade)
  quizId   String
}
```

```ts
// collections/Quizzes.ts
export const Quizzes: CollectionConfig = {
  slug: "quizzes",
  custom: { prisma: { model: "Quiz" } },
  fields: [
    { name: "title", type: "text" },
    {
      name: "questions",
      type: "join",
      collection: "quiz-questions",
      on: "quiz",
      defaultSort: "position",
      defaultLimit: 25,
    },
  ],
};
```

`on` names the **relationship field on the child**, not the column and not the
Prisma relation. It is resolved through the child collection's own mapping, so a
child that renames its relationship keeps working:

```ts
// collections/QuizQuestions.ts
{
  name: "parent",
  type: "relationship",
  relationTo: "quizzes",
  custom: { prisma: { field: "quiz" } },
}
```

```ts
// then the join says `on: "parent"`, the Payload name
{ name: "questions", type: "join", collection: "quiz-questions", on: "parent" }
```

## Why not a `relationship hasMany`

A `relationship` is a picker over documents that already exist, and it writes.
Writing is the problem: a Payload update submits the whole set, which the adapter
spells `set`, and `set` disconnects everything the editor removed. On a child
whose foreign key is non-null, which is the usual shape, that write is illegal.
See [Relationships](./relationships.md#a-to-many-whose-children-cannot-be-detached).

A join reads. There is no set to replace, so there is nothing that can fail.

## Why not an `array`

Both read a parent's children, and the difference is who owns them.

An [array](./arrays.md) edits the rows from the parent's form and deletes the
ones the editor removes. The rows stop being a collection: no list view, no
access control, no hooks of their own.

A join leaves them a collection and only reads them. Use it when the children are
documents in their own right, an array when they are parts of the parent.

## What it costs

One query. The children come back on the parent's own read, as a nested Prisma
`include`:

```ts
prisma.quiz.findMany({
  include: {
    questions: {
      select: { id: true },
      where: { hidden: { equals: false } },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      skip: 0,
      take: 26,
    },
  },
});
```

Two details in there are deliberate.

`take` is one more than the page. That answers `hasNextPage` without a second
query, and a count only runs when the caller asked for `totalDocs`.

The whole thing is nested rather than a second flat query keyed on the parent
ids, because **each parent needs its own page**. One flat query over ten quizzes
can only paginate the pile: the first quiz would get all 25 rows and the rest
would get none.

`orderBy` always ends on the primary key. Without a unique tiebreaker, two
questions sharing a `position` can come back in either order on either request,
and page two then repeats or skips whichever fell on the boundary.

## What the field controls

| Key | Effect |
| --- | --- |
| `defaultLimit` | Rows per page when the request asks for none. Payload's own default is 10. |
| `defaultSort` | Order when the request asks for none. Any sort [Queries](./queries.md) accepts, resolved against the child. |
| `where` | ANDed into every read of the field. |

A request overrides all three:

```ts
await payload.findByID({
  collection: "quizzes",
  id,
  joins: { questions: { limit: 5, page: 2, sort: "-position", count: true } },
});
```

## What comes back

```ts
{
  docs: ["q1", "q2"],   // ids, populated by Payload at depth
  hasNextPage: true,
  totalDocs: 42,        // only when the request asked to count
}
```

Ids, the same as a relationship field. Payload turns them into documents in its
own `afterRead`, through its data loader, so the adapter never fetches rows the
caller might not have asked for.

## What does not translate

**A polymorphic join.** `collection: ["quiz-questions", "quiz-options"]` reaches
two models, each keeping its foreign key somewhere else, so there is no one query
this can be. Split it into one join per target.

**A nested `on`.** The adapter stores a `group` or an `array` whole, in one
`Json` column, so there is no column under `meta.quiz` to match the parent
against. Move the relationship to the top level of the child.

**A join on a global.** Payload populates joins on collections only: `findGlobal`
carries no join query and the globals operations never build one. The field would
render empty forever, so the adapter refuses it at startup rather than letting it
look like a global with no children.

**A one-to-one.** When the child's foreign key is `@unique`, the parent side
holds one row rather than a list, and there is nothing to paginate or sort. Use a
`relationship` field, which addresses that row directly.

**A relation a `relationship` field already maps.** Prisma reads one relation
once per query, and two fields over it would need two different `take`s on the
same include. Keep the join for reading, or the relationship for picking, not
both.

Every one of these is a startup error naming the field, the collection, and the
line that fixes it.

## In the example app

[`apps/blog/src/collections/Organizations.ts`](../apps/blog/src/collections/Organizations.ts)
reads its `members` as a join, the reverse of `Authors.organization`.
[`Authors.ts`](../apps/blog/src/collections/Authors.ts) has the two shapes a join
competes with, so the three are worth reading together: `posts` as a read-only
`relationship`, because `blog_posts.authorId` is NOT NULL, and `reviewed` as a
writable one, because `blog_posts.reviewerId` is not.

The assertions are in
[`apps/blog/src/storage.test.ts`](../apps/blog/src/storage.test.ts), against real
Postgres.
