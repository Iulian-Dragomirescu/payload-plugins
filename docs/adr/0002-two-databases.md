# 0002. Give Payload a second database of its own

Status: accepted

## Context

Payload needs to store things your domain schema has no reason to contain:

* admin accounts, with `hash`, `salt`, `resetPasswordToken`,
  `resetPasswordExpiration`, `loginAttempts` and `lockUntil`
* per-user admin preferences, such as column widths and sort order
* document locks, recording who has a document open
* versions and drafts, a snapshot per save
* its own migrations table
* a job queue

The premise of this package is that the CMS issues no DDL against your database.
Those two facts are in direct conflict, and the conflict has to be resolved
somewhere.

Three options were considered.

**Put them in the user's schema.** This is what every CMS does, and it is the
thing this package exists not to do. It also compounds: once the CMS writes
tables, it needs a migration table to track them, and `prisma migrate diff` then
proposes dropping things it has never heard of.

**Do without them.** Drop auth, versions, preferences and locks. That is not
Payload any more, it is a thin CRUD panel. An earlier iteration of this project
went down this road and the result had no login at all.

**Give Payload a second store.** Everything unmapped goes there.

## Decision

The adapter is a router in front of two stores.

A collection or global carrying `custom.prisma` is a view onto a Prisma model.
Everything else, including the collections Payload adds to your config itself,
goes to an internal adapter that the user supplies.

`internal` accepts any Payload database adapter. It composes rather than
reimplements: `mongooseAdapter` and `postgresAdapter` already handle every
Payload storage concern correctly, and reimplementing them would be a large
amount of code that could only be worse.

Opting in is explicit. Nothing is inferred from names, because Payload adds
`payload-preferences`, `payload-locked-documents` and `payload-migrations` to
every config, and a naming coincidence must never be able to route one of those
into a user's database.

## Consequences

**Good.** Authentication works out of the box, with no schema change. Versions
and drafts work. Preferences work. The guarantee about the user's database is
absolute rather than best-effort, and it is checkable with a `pg_tables` query.

**Bad.** Two databases to run, back up and monitor. The example uses MongoDB to
make the boundary obvious, but a second Postgres database is equally valid and
closer to most people's operations.

**Bad.** A single request can span both stores, which is why transactions are off
by default. See [ADR 0004](./0004-no-cross-store-transactions.md).

**Bad.** Moving a collection or global from one side to the other does not
migrate its content.

**Surprising but fine.** The internal adapter is handed the whole Payload config,
because versions of a mapped collection still need somewhere to go. Adapters that
support it are told not to materialise storage for mapped collections, so an
internal MongoDB does not end up with empty collections named after Postgres
tables.
