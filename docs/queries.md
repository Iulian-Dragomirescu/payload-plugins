# Queries

Payload's `Where` trees and Prisma's are both trees of field conditions joined by
`and` and `or`, so most of the translation is a rename. The work is in the three
places they genuinely differ.

## Field names

Payload queries the field name from the config. Prisma wants the column. The
mapping is the only thing that knows both.

```ts
where: { body: { like: "hello" } }
// { content: { contains: "hello", mode: "insensitive" } }
```

## Operators

| Payload | Prisma |
| --- | --- |
| `equals` | `equals` |
| `not_equals` | `not` |
| `greater_than`, `greater_than_equal` | `gt`, `gte` |
| `less_than`, `less_than_equal` | `lt`, `lte` |
| `in`, `not_in` | `in`, `notIn` |
| `like`, `contains` | `contains` with `mode: "insensitive"` |
| `not_like` | `NOT: { contains }` |
| `exists: true` | `not: null` |
| `exists: false` | `equals: null` |
| `all` | `hasEvery` on a scalar list |

`near`, `within` and `intersects` are geospatial and have no translation. They
raise rather than being ignored.

### Scalar lists

A Prisma `String[]` is queried with membership operators, since `equals` on a
list would mean "is exactly this list", which is never what a CMS filter means.
`in` becomes `hasSome`, `all` becomes `hasEvery`, `equals` becomes `has`.

## Types

A query string carries `"5"`. An `Int` column needs `5`, and Prisma throws rather
than converting.

```ts
where: { views: { equals: "5" } }
// { views: { equals: 5 } }
```

Dates arrive as ISO strings and become `Date`. Relationship ids are coerced to
the target's key type.

## Relations

An owning to-one is filtered on its foreign-key column. It is the same question
asked of one table instead of two, and Postgres can use the foreign key's own
index:

```ts
where: { author: { equals: "a1" } }
// { authorId: { equals: "a1" } }
```

A to-many goes through `some`:

```ts
where: { tags: { in: ["1", "2"] } }
// { tags: { some: { id: { in: [1, 2] } } } }
```

`all` means every listed id is present, which is an AND of separate `some`
clauses. `some: { id: { in: [...] } }` would only require one of them.

### Through a relation

A dotted path travels into the target collection, and the remainder is resolved
against that collection's own mapping, so field renames on the other side are
honoured too:

```ts
where: { "author.name": { like: "ana" } }
// { author: { is: { name: { contains: "ana", mode: "insensitive" } } } }
```

This needs the target to be a mapped collection. If nothing maps onto that
model, its field names are unknown here, and the error says so and suggests
filtering by id instead.

## Sorting

```ts
sort: "-publishedAt"
// orderBy: [{ publishedAt: "desc" }, { id: "asc" }]
```

**Every sort ends with the primary key.** Without a unique tiebreaker, two rows
with the same `publishedAt` can come back in either order on either request, and
page two of a list view then repeats or skips whatever fell on the boundary.
Postgres is entitled to do that. A paginated admin table is not.

Sorting by a relation sorts by its foreign key, which is the only scalar there
is. Sorting by a property of the related row works through a dotted path.
Sorting by a to-many raises, because a row has many values for it and there is no
single one to order by.

## Pagination

`page` and `limit` become `skip` and `take`, with a `count` for the total.
`pagination: false` and `limit: 0` both mean everything, and Payload uses them
interchangeably.

## Nothing is dropped silently

A query that cannot be translated raises. It is never ignored.

A filter that silently disappears returns rows the caller believed were excluded.
In an access-control `where` that is a data leak rather than a bug, so the
failure is loud:

```
[prisma-adapter] Cannot query "nickname" on collection "authors": "nickname" is
not a field that maps to a Prisma column.
Queryable fields: name, email, role, organization, posts, id
```

An empty `or` is passed through rather than dropped, for the same reason.
`OR: []` matches nothing in Prisma just as it does in Payload, and dropping it
would widen the result set.

## `select` is accepted and ignored

Mapped reads return the whole mapped row. Returning more than was asked for is
always safe, and the cost is bandwidth rather than correctness. Columns the
config does not declare are still dropped, so this does not leak a
`passwordHash` into a list view.
