# Limitations

Stated plainly, because the boundaries are real. Everything on this page raises a
named error rather than misbehaving quietly.

## Transactions are off by default

A transaction opened by the internal adapter covers only the writes that go to
it. A Payload request that saves a document and its version writes to both
databases, so a rollback of the internal half would leave the Prisma half
committed while looking, from the outside, exactly like a clean rollback.

No transaction at all is a weaker guarantee that does not lie. Payload runs
correctly without them, which is also how the MongoDB adapter behaves without a
replica set.

Turn them on when your mapped collections have no versions and no drafts, so no
single request spans both stores:

```ts
prismaAdapter({ prisma, internal, transactions: true })
```

See [ADR 0004](./adr/0004-no-cross-store-transactions.md).

## Polymorphic relationships

`relationTo: ["pages", "posts"]` has no Prisma equivalent. A Prisma relation
points at exactly one model, so there is no column this can be.

Split it into one field per target, or leave the collection unmapped.

## Composite primary keys

Payload addresses every document by one id, in URLs, in relationship values, in
`findByID`. A model with `@@id([a, b])` has nothing to put there.

Add a surrogate `@id` column, or leave the collection unmapped.

## Localization

Not implemented for mapped collections. Payload stores locales as a nested object
per field. A column holds one value.

A localized collection can still be unmapped and stored internally.

## A to-many whose children cannot be detached

A Payload update writes the whole set at once, which Prisma spells `set`, and
`set` disconnects every row the editor removed. When the child's foreign key is
non-null, that means writing NULL into a NOT NULL column, and the database
refuses.

The adapter raises this at startup rather than on the first removal. Read the
field as a [join](./joins.md), write it as an [array](./arrays.md), mark it
`readOnly`, or make the foreign key optional.

An array is usually the right answer when the rows belong to the parent: it
deletes a removed row instead of detaching it, so the non-null foreign key stops
being a problem.

## A column no create can fill in

A non-null column with no default that no field maps makes every `create` on that
collection fail. Reads are unaffected, so this is a startup warning rather than
an error: a collection is allowed to be a read-only view onto a table something
else fills. A `create` against one refuses with the column named.

## Join fields, partly

Supported, and documented in [Join fields](./joins.md). Five shapes are not, and
each is a startup error rather than a field that renders empty:

* a polymorphic join, `collection: ["a", "b"]`
* a nested `on`, which would point inside a `Json` column
* a join on a global, which Payload never populates on any adapter
* a join over a one-to-one, which has no page to paginate
* a join over a relation a `relationship` field already maps

## Geospatial operators

`near`, `within` and `intersects` are not translated. A `point` field has no
Prisma column type in this adapter.

## Versions and drafts live in the internal store

Whichever database holds the published document. This is by design rather than a
gap: a version is a snapshot, and snapshots of your rows do not belong in your
schema.

It does mean `queryDrafts` always queries the internal database, and that a
mapped collection with drafts enabled is one of the cases where a request spans
both stores, which is what keeps transactions off by default.

## `select` is ignored

Mapped reads return the whole mapped row. Columns the config does not declare are
still dropped, so nothing leaks, but the query is not narrowed. The cost is
bandwidth.

## Decimal precision

A Prisma `Decimal` reads back as a number, which is what Payload's `number` field
expects. That trades exact decimal arithmetic for a value the CMS can display.

A column where the last digits matter should be read through Prisma directly.

## Migrating between the two databases

Moving a collection or global from internal storage to Prisma, or back, does not
move its content. The old copy is simply never read again. Copy it across
yourself.
