# 0004. Ship with transactions off by default

Status: accepted

## Context

Payload asks its adapter to open a transaction per request. An adapter that
cannot returns `null` from `beginTransaction`, and Payload then runs without one.
The MongoDB adapter does exactly this when there is no replica set, so the
unconfigured path is well travelled.

This adapter writes to two stores. A single request can touch both: saving a
mapped document writes the row to Prisma and its version to the internal store.

The internal adapter can open a transaction, but it covers only its own writes.

## Decision

`beginTransaction` returns `null` by default. An opt-in flag delegates to the
internal adapter for people whose mapped collections have no versions and no
drafts:

```ts
prismaAdapter({ prisma, internal, transactions: true })
```

## Consequences

**Good.** No operation claims atomicity it does not have. If a partial failure
happens, it looks like a partial failure.

The alternative is worse than it first appears. With internal transactions on, a
request that writes a Prisma row and then fails on the version would roll the
version back and leave the row committed, while every log line and every error
message describes a clean rollback. Silent partial state that presents as
consistent is harder to diagnose than partial state that presents as partial.

**Bad.** No atomicity anywhere by default, including for operations entirely
inside one store. A create that triggers several internal writes can leave some
of them applied.

**Bad.** The opt-in is a footgun for anyone who enables drafts later and does not
revisit the flag. The option's documentation says so, which is the most that can
be done from here.

## Not chosen

**Two-phase commit across Prisma and the internal store.** Correct in principle,
and far more machinery than a CMS adapter should contain. Neither store offers
the primitives to do it properly.

**Prisma-only transactions.** `prisma.$transaction` around the mapped writes,
nothing around the internal ones. This is the same lie in a smaller box.
