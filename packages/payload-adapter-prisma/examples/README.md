# Examples

Each folder is one shape of problem, with the `schema.prisma` that causes it and
the config that resolves it. They are meant to be read side by side and copied
from.

| Example | Shows |
| --- | --- |
| [`minimal`](./minimal) | The smallest config that works |
| [`renamed-columns`](./renamed-columns) | A schema whose names differ from the CMS's |
| [`relationships`](./relationships) | Two relations to one model, many-to-many, self-relation |
| [`globals`](./globals) | A global in your table, and one in Payload's |

None of these are standalone projects. They are the interesting files, without
the Next.js scaffolding around them. For a complete app you can run, see
[`apps/blog`](../../../apps/blog), which uses every one of these shapes at once
and asserts them in [its test
suite](../../../apps/blog/src/storage.test.ts).

## Reading order

Start with `minimal` to see how little is required. Then `renamed-columns`,
because a schema you did not write for a CMS is the normal case rather than the
exception. Then `relationships`, which is the part worth reading closely.
`globals` last, because it is a separate idea.

## The pattern they share

Every example has the same three files:

```
schema.prisma       the database, which does not change
config.ts           the Payload config, which is a view onto it
README.md           what the example is showing, and why
```

The point of the pairing is to make the direction visible. In each one, the
schema was written first and without a CMS in mind, and the config bends to it.
