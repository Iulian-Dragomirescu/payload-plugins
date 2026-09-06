# payload-plugins, agent guide

A monorepo of packages for [Payload CMS](https://payloadcms.com). Today it holds
one: a database adapter that runs Payload on an existing Prisma schema.

## Stack

| Thing | Choice |
| --- | --- |
| Package manager | pnpm 10, workspaces plus a catalog |
| Language | TypeScript, ESM everywhere (`"type": "module"`) |
| Bundler | tsup for packages, Next.js for the app |
| Tests | Vitest |
| Releases | multi-semantic-release, per package, from `main` |
| Linter | none yet, see [Open choices](#open-choices) |

There is no Turborepo. With one package and one app, `pnpm -r` is the whole
build graph, and a second build system would be a thing to maintain rather than
a thing that helps.

## Structure

```
apps/
  blog/                        @repo/blog, private
                               A runnable Payload app on a deliberately awkward
                               Prisma schema. It is the demo AND the integration
                               suite, which is why it is not throwaway code.
packages/                      Published packages, and nothing else
  payload-adapter-prisma/      The product. A Payload database adapter.
docs/                          Reference documentation, see docs/README.md
tsconfig.base.json             Compiler settings every workspace extends
```

**`packages/` is for things that ship.** A new directory in there is always a
package someone can install, which keeps `--ignore-private-packages` from being
the only thing standing between shared config and npm. Shared configuration
lives at the root as a plain file and is extended with a relative path.

`apps/blog` consumes the adapter through `workspace:*`, exactly as an installed
copy would resolve, so the example doubles as proof that the published shape
works.

## Commands

```bash
pnpm install
pnpm build              # build packages/*
pnpm typecheck          # every workspace
pnpm test               # unit tests in packages/*

pnpm --filter @repo/blog setup    # docker compose up, db push, prisma generate, import map
pnpm dev                          # the blog app on http://localhost:3000/admin
pnpm --filter @repo/blog seed     # an admin login, content, and a narrated tour
pnpm --filter @repo/blog test     # integration tests against real Postgres and MongoDB
```

The integration suite needs the containers in `apps/blog/docker-compose.yml`.
Unit tests never touch a database.

## What the adapter actually is

Read this before changing anything under `packages/payload-adapter-prisma`.

Payload is installed, not forked. The admin panel, REST and GraphQL APIs, hooks,
access control and plugins are all upstream Payload. This package implements
Payload's `BaseDatabaseAdapter` interface and does two things:

1. **Translates** Payload reads and writes into Prisma queries, for collections
   and globals that carry `custom.prisma` in their config.
2. **Routes** everything else to a second adapter, called the internal adapter.
   That covers admin logins, preferences, document locks, versions, drafts,
   migrations and the job queue.

The invariant the whole package exists to keep: **it issues no DDL against your
database.** No table, no column, no migration. If a change would create
something in the user's schema, the change is wrong.

### Where the layers live

```
src/
  adapter.ts        The router. Wraps the internal adapter in a Proxy and
                    overrides the methods that address mapped configs.
  operations.ts     One function per Payload database method.
  mapping/          Resolves a Payload config against the parsed datamodel.
                    Every startup error worth having is raised here.
  query/            Payload `Where` and `Sort` into Prisma `where` and `orderBy`.
  transform/        Prisma row into Payload document, and back.
  schema/           Parses schema.prisma. This is the source of truth.
```

### Things that look wrong but are not

- **`schema.prisma` is parsed, not read from the generated client.** Prisma 7
  removed relation metadata from the client, so there is no other way to know
  which side of a relation owns the foreign key. Do not replace the parser with
  a client lookup.
- **The router is a `Proxy`, not a spread.** The internal adapter assigns state
  lazily, `connection` during `connect()`. A copy taken at init freezes the
  object before any of that exists.
- **Ids are strings above the adapter, whatever the column type.** One rule
  covers `cuid()`, `uuid()`, `Int` and `BigInt`. Coercion back to the real type
  happens at the database boundary.
- **A to-many update writes `set`, not `connect`.** `connect` only ever adds, so
  removing a tag in the admin panel would silently do nothing.
- **Dates leave the adapter as ISO strings.** A live `Date` survives a read but
  not the deep copy Payload takes before an update.
- **A NULL column for a `group` field is dropped, not returned as null.** Payload
  fills an absent group with `{}` and treats a literal `null` as a crash.
- **Transactions are off by default.** One opened by the internal adapter covers
  only half the writes, and a rollback that looks clean but is not is worse than
  no transaction.

Each of these has a test naming the reason. If a test fails, read the reason
before changing the assertion.

## Releases

Automated by multi-semantic-release from `main`. Each package releases
independently, and **which files a commit touched decides which package is
released**, not the commit scope.

Packages are discovered from `pnpm-workspace.yaml`, not from a `workspaces`
field in `package.json`. multi-semantic-release reads it through
`@manypkg/get-packages`, which understands pnpm. There is nothing to list in the
root manifest, and adding a `workspaces` field there would be a second, silent
source of truth. Check it any time with:

```bash
pnpm release:dry
```

It prints the packages it found and which ones it skipped as private.

| Commit type | Bump |
| --- | --- |
| `fix:` | patch |
| `feat:` | minor |
| `feat!:` or `BREAKING CHANGE:` | major |
| `docs:`, `refactor:`, `perf:` | patch |
| `chore:` | no release |

Private packages (`@repo/*`) are skipped by `--ignore-private-packages`.

Two things must be true before the first release works:

1. `repository.url` in `packages/payload-adapter-prisma/package.json` matches the
   git remote exactly. semantic-release fails with a git error otherwise.
2. npm Trusted Publishing is configured for the package, pointing at this repo,
   the `Release` workflow, and branch `main`. `provenance: true` signs the
   artifact but does not authenticate the publish, so without a trusted
   publisher the release fails with `ENONPMTOKEN`.

Never hand-edit a `version` field. semantic-release owns it.

## Adding a package

1. Create `packages/<name>/` with a `package.json` carrying `"private": false`
   and `"publishConfig": { "access": "public" }`.
2. Set `repository.url` to this repo and `repository.directory` to its path.
3. Give it `build`, `typecheck` and `test` scripts so the root scripts pick it up.
4. Add a `README.md`, and a page under `docs/` if it needs more than a page.

pnpm workspaces discover it. Nothing else needs editing.

## House style

- **Comments say why, not what.** The code already says what. A comment earns
  its place by recording a decision, a constraint, or a trap.
- **Assume the reader knows the stack.** This is open source, and a comment
  explaining what Next, Prisma or Payload already documents is noise. If a
  competent developer would know it, do not write it. No essays, no narration
  of the line below, no rhetorical flourish. A good comment is the one on
  `transformWriteData`: a table of which nested Prisma operation applies, and
  one sentence on why an update writes `set`. A bad one is a paragraph on what
  `allowedDevOrigins` is for.
- **Every exported symbol gets a docstring** with `@param` and `@returns`.
  Keep it to what the signature does not already say.
- **Errors name the fix.** A mapping is a set of strings pointing at another
  file, and nothing in the type system checks them. The error message is the
  type check, so it must say what was looked for, what is actually there, and
  the one line of config that resolves it.
- **Prose in docs and READMEs uses no dashes as punctuation.** Write the
  sentence, or use a comma, a colon, or two sentences.
- **Never claim something is verified unless it was run.** HTTP 200 is not proof
  a page rendered.

## Open choices

Deliberately not decided, so nobody has to guess whether they were forgotten:

- **No linter or formatter.** The reference repo this layout follows uses
  oxlint and oxfmt through Ultracite. Adding one now would reformat every file
  at once. Worth doing, worth doing as its own commit.
- **No Turborepo.** See [Stack](#stack).
- **The npm name is unscoped.** `payload-adapter-prisma` is claimed by nobody at
  the time of writing, but a scope avoids the question entirely.
