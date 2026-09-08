# Mapping

A Payload config describes an editing experience. `schema.prisma` describes a
database. Mapping is how the two are connected, and the direction matters: the
schema is fixed, and the config is a view onto it.

Everything lives under `custom`, which is Payload's own extension slot. A config
carrying it is still an ordinary Payload config that any Payload tool can read.
There is no wrapper function and no fork.

## The keys

| Key | Where | What it says |
| --- | --- | --- |
| `model` | collection, global | Which Prisma model backs it. Its presence is what opts the config in. |
| `field` | field | Which column backs this field. Defaults to the field's name. |
| `foreignKey` | relationship | Which foreign key this relation travels over. |
| `readOnly` | field | Read this column, never write it. |
| `orderBy` | to-many relationship | Which order its rows come back in. See [Relationships](./relationships.md#ordering-an-included-to-many). |
| `where` | global | Which row of the table this global is. See [Globals](./globals.md). |

Only `model` is required, and most fields need nothing at all.

## What is never in the config

Column types, nullability, which side of a relation owns the foreign key, what
the primary key is called, whether a column is `@updatedAt` or
`@default(autoincrement())`. All of it is read from the schema.

This is not a convenience. If both files said it, they could disagree, and the
config would be a second source of truth that silently drifts. Only one of them
says it, so they cannot drift.

## Collections

```ts
export const Posts: CollectionConfig = {
  slug: "posts",
  custom: { prisma: { model: "BlogPost" } },
  fields: [ /* ... */ ],
};
```

`model` defaults to nothing. There is no name convention, because guessing which
model a slug means is exactly the kind of inference that goes wrong quietly.

### Timestamps

Payload adds `createdAt` and `updatedAt` to every collection. If your table does
not have those columns, set `timestamps: false` on the collection. The adapter
will not invent columns, and the error says so:

```
[prisma-adapter] Collection "authors" field "createdAt" maps to
"Author.createdAt", which does not exist.
```

An `@updatedAt` column that does exist is marked read-only automatically. Prisma
maintains it, and writing it is an error rather than a preference, so this is not
left to the config to remember.

## Fields

By default a field maps to the column with the same name.

```ts
{ name: "title", type: "text" }                                    // → title
{ name: "body", type: "textarea", custom: { prisma: { field: "content" } } }  // → content
```

### Read-only

For a column something else owns, a counter maintained by a trigger, a value
another service writes:

```ts
{
  name: "views",
  type: "number",
  custom: { prisma: { readOnly: true } },
  admin: { readOnly: true },
}
```

The field still renders and still reads. It is dropped from every `create` and
`update` payload, so a save from the admin panel cannot clobber it.

`custom.prisma.readOnly` and `admin.readOnly` are different things and you
usually want both. The first stops the write. The second stops the input from
being editable.

### Structured fields

`group`, `array`, `blocks`, `json` and `richText` hold a structure rather than a
scalar. They land in a `Json` column whole.

```prisma
model BlogPost {
  meta Json?
}
```

```ts
{ name: "meta", type: "group", fields: [ /* ... */ ] }
```

Payload's relational adapters explode these into child tables. This adapter
cannot, because creating those tables is the one thing it does not do. One value
means one column.

A NULL in that column reads back as absent rather than as `null`, because Payload
fills an absent group with `{}` so hooks inside it can run, and treats a literal
`null` there as a crash.

### What is not a column

`join` fields are reverse lookups: nothing is stored on this model, and the rows
are found by querying the child. They are resolved against the child collection's
mapping instead, in a second pass, and are covered in [Join
fields](./joins.md).

Fields marked `virtual` are populated by hooks, and are not looked for in the
schema at all.

## Startup errors

A mapping is a set of strings pointing at another file, and nothing in the type
system checks a string against a schema. So the error message is the type check,
and it is raised when Payload boots rather than on the first request that happens
to touch the mismatch.

Every message names the config, the field, what was looked for, what is actually
there, and the one line that resolves it.

```
[prisma-adapter] Collection "posts" field "author" maps to "BlogPost.writer",
which is not a relation on that model.
Relations on "BlogPost": author, reviewer, tags, parent, children
Set `custom: { prisma: { field: "…" } }` on the field to name the relation, or
`foreignKey: "…"` to name the column it travels over.
```

```
[prisma-adapter] Collection "posts" field "tags" is `hasMany: false`, but
"BlogPost.tags" is a list in schema.prisma.
The two have to agree, add `hasMany: true` to the field.
```

```
[prisma-adapter] Collection "pairs" maps to "Composite", which has no
single-column `@id`.
It has a composite key (`@@id([left, right])`), and Payload addresses every
document by one id, in URLs, in relationship values, in `findByID`. There is
nothing to put there.
Add a surrogate `@id` column, or leave this collection unmapped.
```

## Typed, not stringly typed

The package augments Payload's `CollectionCustom`, `GlobalCustom` and
`FieldCustom` interfaces, which Payload declares open for exactly this. Import
the package anywhere in your project and `custom.prisma` autocompletes, and a
typo in a key is a compile error.

The value of `model` is still a string, and only the startup check can verify it.

## Related

* [Relationships](./relationships.md) covers `foreignKey` and `orderBy` in depth.
* [Join fields](./joins.md) covers reading a parent's children.
* [Globals](./globals.md) covers `where`.
