# Documentation

Reference for the packages in this repo.

## payload-adapter-prisma

Run Payload CMS on a Prisma schema you already have, without letting the CMS
touch that schema.

Read these in order the first time. Each one is short and stands on its own
afterwards.

| Page | What it answers |
| --- | --- |
| [Getting started](./getting-started.md) | How do I install it and see an admin panel? |
| [The two databases](./two-databases.md) | Where does each thing get stored, and why two? |
| [Mapping](./mapping.md) | How does a collection point at a model and a field at a column? |
| [Relationships](./relationships.md) | How do writes and reads handle relations? |
| [Join fields](./joins.md) | How does a parent read its children? |
| [Array fields](./arrays.md) | How does a parent write its children? |
| [Globals](./globals.md) | How is a singleton stored in a table? |
| [Queries](./queries.md) | Which filters and sorts translate, and which do not? |
| [Limitations](./limitations.md) | What is not supported, stated plainly? |

## Decisions

The [architecture decision records](./adr) explain choices that look surprising
until you know what they were weighed against.

| ADR | Decision |
| --- | --- |
| [0001](./adr/0001-schema-file-is-the-source-of-truth.md) | Parse `schema.prisma` instead of reading the generated client |
| [0002](./adr/0002-two-databases.md) | Give Payload a second database of its own |
| [0003](./adr/0003-ids-are-strings.md) | Present every id as a string, whatever the column type |
| [0004](./adr/0004-no-cross-store-transactions.md) | Ship with transactions off by default |
