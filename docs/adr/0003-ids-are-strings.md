# 0003. Present every id as a string, whatever the column type

Status: accepted

## Context

Payload has one `defaultIDType` for the whole config, either `"text"` or
`"number"`. A real Prisma schema does not agree with itself about this:
`BlogPost.id` is a `cuid()`, `Tag.id` is an `Int @default(autoincrement())`,
another model uses `BigInt`.

The internal adapter has its own answer too. MongoDB ids are strings.

Meanwhile admin URLs, JSON request bodies and relationship pickers all carry ids
as strings regardless, and Prisma throws rather than coercing a `"7"` into an
`Int`.

Two options were considered.

**Follow the column type.** Return numbers for `Int` keys, strings for `cuid()`.
Payload then has one global `defaultIDType` that is wrong for half the
collections. A relationship value would mean different things depending on which
collection it points at, and validation would reject values it should accept.

**Pick one and stick to it.**

## Decision

Ids are strings above the adapter, whatever the column's type. The adapter
declares `defaultIDType: "text"`.

Reading, every id is rendered with `String()`. Writing, `coercePrimaryKey` takes
it back to the column's real type, which the schema states.

The boundary is exactly the adapter. Above it, Payload, the admin panel, the REST
and GraphQL APIs and every relationship value see a string. Below it, Prisma sees
the type its schema declares.

## Consequences

**Good.** One rule covers `cuid()`, `uuid()`, `Int @default(autoincrement())` and
`BigInt`. It matches what the internal store does, so a relationship value means
the same thing on both sides of the split. Nothing in a collection config has to
mention it.

**Good.** `BigInt` works at all. `JSON.stringify` throws on a `BigInt`, so a
numeric id would break the REST boundary for that type.

**Bad.** A caller reading `doc.id` on an `Int`-keyed collection gets `"7"` rather
than `7`. Code that compares it to a number needs a conversion. This is visible
in generated types, which is the best available place for it to be visible.

**Bad.** An `Int @id` without `autoincrement()` has to be supplied on create, and
the value arrives as a string. Coercion handles it, but the failure mode when it
cannot is a `TypeError` naming the value rather than a Prisma validation error.
