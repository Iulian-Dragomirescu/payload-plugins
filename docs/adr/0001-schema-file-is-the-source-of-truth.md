# 0001. Parse `schema.prisma` rather than read the generated client

Status: accepted

## Context

To translate a Payload write into a Prisma query, the adapter has to know things
the Payload config does not say:

* which field is the primary key, and what type it is
* which side of a relation owns the foreign key
* whether a relation is to-one or to-many
* whether a column is `@updatedAt` or `@default(autoincrement())`

The obvious source is the generated client. Prisma 5 and 6 expose enough on it,
through `Prisma.dmmf` or `_runtimeDataModel`.

Prisma 7 does not. Its `_runtimeDataModel` carries only
`{ name, kind, type, relationName }` per field. No `isId`, no `isList`, no
`relationFromFields`.

Without relation ownership there is no way to decide whether a write is a nested
`connect` or a plain scalar assignment. Without primary keys no collection can be
addressed at all. A mapping built from a Prisma 7 client would not fail, it would
be confidently wrong: every relation would look non-owning.

## Decision

Parse `schema.prisma` directly, and treat it as the primary source rather than a
fallback.

The parser is small and deliberate, about 220 lines. It reads model blocks and
field lines, handles comments, `@map`, `@@map`, `@relation` with named fields and
references, optional and list types, and composite `@@id`. It does not handle
`type` blocks or `view` blocks, which are not mappable anyway.

Depending on `@prisma/internals` for this was considered and rejected. It adds
tens of megabytes and a version coupling for a job that fits on a page.

A client can still be passed as `schema: { datamodel: client }` for a deployment
where the schema file is not on disk. On Prisma 7 that path detects the missing
metadata and raises an actionable error rather than proceeding.

## Consequences

**Good.** It works before `prisma generate` has ever run. It does not change
shape between Prisma versions, since the schema language is far more stable than
the client internals. It is also the honest source: the project rests on the
schema being the source of truth, and reading a derived artifact would make that
claim one step less true.

**Bad.** The schema file must be reachable at runtime. The default path is
`./prisma/schema.prisma` and `schema: { path }` overrides it, but a bundled
deployment that does not ship the file has to pass a datamodel instead.

**Also.** There is a hand-written parser to maintain. It has 22 tests, and a bug
in it is a silently wrong write rather than a crash, so it is the one part of
this package that deserves paranoid testing.
