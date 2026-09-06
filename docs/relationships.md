# Relationships

This is the part that has to be right, and the part a mapping layer usually gets
wrong.

Prisma will not accept an id where it expects a relation. Which nested operation
is correct depends on the relation's shape and on whether the row already
exists, and getting it wrong fails quietly rather than loudly.

## Writes

| Relation | `create` | `update` |
| --- | --- | --- |
| to-one | `connect` | `connect`, or `disconnect` for `null` |
| to-many | `connect` with a list | `set`, which replaces the whole set |

```ts
await payload.create({
  collection: "posts",
  data: { title: "Hello", author: "a1", reviewer: "a2", tags: ["1", "2"] },
});
// data sent to Prisma:
// {
//   title: "Hello",
//   author:   { connect: { id: "a1" } },
//   reviewer: { connect: { id: "a2" } },
//   tags:     { connect: [{ id: 1 }, { id: 2 }] },
// }

await payload.update({ collection: "posts", id: "p1", data: { tags: ["1"] } });
// { tags: { set: [{ id: 1 }] } }        tag 2 is now removed
```

### Why `set` and not `connect` on update

A multi-select submits the complete intended set, not a diff. `connect` only ever
adds. If an update used `connect`, removing a tag in the admin panel would
appear to work, save without error, and change nothing.

That is the worst kind of bug: it looks like a feature that works.

### Clearing a to-one

`null` on an update becomes `disconnect: true`. On a create it is dropped,
because there is nothing to detach from yet.

### Ids are coerced

A relationship picker sends `"7"`. An `Int @id` needs `7`, and Prisma will not
convert. The target's key type comes from the schema, so the coercion happens
before the query is built. See [ADR 0003](./adr/0003-ids-are-strings.md).

A value is accepted as a bare id, as `{ id }`, or as a whole document. All three
are natural things for a caller to have on hand.

## Reads

A read costs no join where it does not need one.

**A to-one this model owns** is read straight off its foreign-key column. The id
is already in the row, so there is nothing to fetch.

**A to-many, and the non-owning half of a to-one**, are included. Each pulls back
the target's id and nothing else:

```ts
include: { tags: { select: { id: true } } }
```

The id is all a Payload relationship field holds. Payload populates the rest
itself, above the adapter, through its own data loader. Fetching whole rows here
would be work thrown away.

## Two relations to the same model

A post with an `author` and a `reviewer`, both pointing at `Author`. Prisma tells
them apart by their foreign keys, so the config does too:

```prisma
model BlogPost {
  author     Author  @relation("PostAuthor", fields: [authorId], references: [id])
  authorId   String
  reviewer   Author? @relation("PostReviewer", fields: [reviewerId], references: [id])
  reviewerId String?
}
```

```ts
{
  name: "author",
  type: "relationship",
  relationTo: "authors",
  custom: { prisma: { foreignKey: "authorId" } },
},
{
  name: "reviewer",
  type: "relationship",
  relationTo: "authors",
  custom: { prisma: { foreignKey: "reviewerId" } },
}
```

Name matching resolves this when the Payload field is named after the relation.
`foreignKey` resolves it when it is not. If neither applies and the target is
ambiguous, the adapter raises at startup rather than guessing, because a guess
here writes to the wrong column and nothing complains.

## Cardinality has to agree

`hasMany` on the Payload side and `isList` on the Prisma side are two statements
about the same relation. A disagreement means the admin panel submits a shape the
write layer cannot translate, an array where Prisma wants one id or the reverse,
so it is a startup error.

## Referential integrity stays yours

Deleting a row another table references fails unless the relation declares
`onDelete: Cascade`. The adapter does not cascade behind your schema's back, and
the error explains whose rule it was:

```
[prisma-adapter] The database refused this write because of a foreign key on
"Author".
Referential integrity is your schema's, not the adapter's. A row another table
points at cannot be deleted unless the relation declares `onDelete: Cascade`.
```

## Polymorphic relationships

`relationTo: ["pages", "posts"]` has no Prisma equivalent, because a Prisma
relation points at exactly one model. This is a startup error with two ways out:
split it into one field per target, or leave the collection unmapped so it is
stored internally.

## Self-relations

Supported, and exercised by the example. `BlogPost.parent` pointing at
`BlogPost` is an ordinary owning to-one, read off `parentId`. Depth expansion
terminates because Payload owns it, not the adapter.

## What this looks like in practice

The example app has all of it in one collection. See
[`apps/blog/src/collections/Posts.ts`](../apps/blog/src/collections/Posts.ts),
and the assertions in
[`apps/blog/src/storage.test.ts`](../apps/blog/src/storage.test.ts), which check
the actual foreign keys and join table rows rather than the values Payload hands
back.
