# relationships

The part worth reading closely.

## What it shows

| Shape | In the schema | In the config |
| --- | --- | --- |
| To-one, owning | `author` with `fields: [authorId]` | `foreignKey: "authorId"` |
| A second to-one to the same model | `reviewer` with `fields: [reviewerId]` | `foreignKey: "reviewerId"` |
| Many-to-many | `tags Tag[]` | `hasMany: true` |
| To-many, non-owning | `posts BlogPost[]` on `Author` | `hasMany: true` plus `readOnly` |
| Self-relation | `parent` pointing at `BlogPost` | `foreignKey: "parentId"` |
| Int primary key | `Tag.id Int @id` | nothing |

## What gets written

```ts
await payload.create({
  collection: "posts",
  data: { title: "Hello", author: "a1", reviewer: "a2", tags: ["1", "2"] },
});
// {
//   title: "Hello",
//   author:   { connect: { id: "a1" } },
//   reviewer: { connect: { id: "a2" } },
//   tags:     { connect: [{ id: 1 }, { id: 2 }] },
// }

await payload.update({ collection: "posts", id: "p1", data: { tags: ["1"] } });
// { tags: { set: [{ id: 1 }] } }        tag 2 is now removed
```

Note the tag ids. The picker sends `"1"` and `"2"`. `Tag.id` is an `Int`, and
Prisma throws rather than converting, so the coercion happens before the query
is built.

## Why `set` and not `connect` on update

A multi-select submits the complete intended set, not a diff. `connect` only ever
adds, so an update that used it would appear to work, save without error, and
change nothing. That is the worst kind of bug: it looks like a feature.

## What reads cost

**A to-one this model owns costs no join.** The id is already in the row, on the
foreign-key column.

**A to-many, and the non-owning half of a to-one, are included**, pulling back
the target's id and nothing else:

```ts
include: { tags: { select: { id: true } } }
```

The id is all a Payload relationship field holds. Payload populates the rest
itself, above the adapter, so fetching whole rows here would be work thrown
away.

## What raises

**Cardinality that disagrees.** `hasMany: false` against a `Tag[]` is a startup
error. The admin panel would otherwise submit a shape the write layer cannot
translate.

**Polymorphic relationships.** `relationTo: ["pages", "posts"]` has no Prisma
equivalent, because a Prisma relation points at exactly one model.

**A `foreignKey` no relation travels over.** The error lists the ones that do.

## Referential integrity is yours

Deleting an author a post references fails, because `BlogPost.author` declares no
`onDelete: Cascade`. The adapter does not cascade behind your schema's back.

## Next

[`globals`](../globals).
