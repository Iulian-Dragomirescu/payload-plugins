# joins

Parent to children, which an existing schema is full of and which a
`relationship` cannot express.

## What it shows

| Shape | In the schema | In the config |
| --- | --- | --- |
| A parent's children | `questions QuizQuestion[]` | `type: "join", on: "parent"` |
| A second join to the same model | `archived` with `@relation("QuizArchive")` | a different `on` |
| A renamed child relationship | `quiz` | `on` names the Payload field, `custom.prisma.field` names the column |
| Ordering | `position Int` | `defaultSort: "position"` |
| A permanent filter | nothing | `where: { hidden: { equals: false } }` |

## Why not `relationship hasMany`

`QuizQuestion.quizId` is NOT NULL, which is the usual shape for a child that
cannot exist without its parent.

A `relationship` writes, and a Payload update writes the whole set at once, which
the adapter spells `set`. `set` disconnects everything the editor removed, so a
removal writes NULL into `quizId` and the database refuses. The field would work
for as long as nobody removed anything.

The adapter raises that at startup rather than on the first removal, and names
this page as one of the ways out.

## What gets queried

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

`take` is one more than the page, so `hasNextPage` costs no second query. A
count only runs when the request asked for `totalDocs`.

Nested rather than a second flat query keyed on the parent ids, because each
parent needs its own page. One flat query over ten quizzes could only paginate
the pile: the first quiz would take all 25 rows and the rest would get none.

## What comes back

```ts
{
  docs: ["q1", "q2"],   // ids, populated by Payload at depth
  hasNextPage: true,
  totalDocs: 42,        // only when the request asked to count
}
```

## What a request can override

```ts
await payload.findByID({
  collection: "quizzes",
  id,
  joins: { questions: { limit: 5, page: 2, sort: "-position", count: true } },
});
```

## What raises

**A polymorphic join.** `collection: ["a", "b"]` reaches two models keeping their
foreign keys in different places.

**A nested `on`.** A `group` or an `array` on the child is one `Json` column,
with no column under it to match the parent against.

**A join on a global.** Payload populates joins on collections only, so the field
would render empty forever on any adapter.

**A one-to-one.** Nothing to paginate. Use a `relationship`.

**A join over a relation a `relationship` field already maps.** Prisma reads one
relation once per query.

## Related

* [Join fields](../../../../docs/joins.md)
* [`apps/blog/src/collections/Organizations.ts`](../../../../apps/blog/src/collections/Organizations.ts)
  reads its members as a join, and
  [`apps/blog/src/storage.test.ts`](../../../../apps/blog/src/storage.test.ts)
  checks it against real Postgres.

## Next

[`globals`](../globals).
