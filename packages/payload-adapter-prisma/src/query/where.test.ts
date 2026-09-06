import type { SanitizedCollectionConfig } from "payload";
import { describe, expect, it } from "vitest";

import { buildCollectionMapping } from "../mapping/build.js";
import type { ModelMapping } from "../mapping/types.js";
import { parsePrismaSchema } from "../schema/parseSchema.js";
import { buildOrderBy } from "./sort.js";
import { buildWhere } from "./where.js";

/**
 * A filter that silently disappears returns rows the caller believed were
 * excluded, which in an access-control `where` is a data leak. So both halves
 * are checked: that a supported query translates, and that an unsupported one
 * raises rather than falling through.
 */

const datamodel = parsePrismaSchema({
  source: `
model BlogPost {
  id       String @id
  title    String
  views    Int    @default(0)
  featured Boolean @default(false)
  publishedAt DateTime?
  author   Author @relation("A", fields: [authorId], references: [id])
  authorId String
  tags     Tag[]  @relation("T")
}
model Author {
  id    String @id
  name  String
  posts BlogPost[] @relation("A")
}
model Tag {
  id    Int    @id @default(autoincrement())
  label String
  posts BlogPost[] @relation("T")
}
`,
});

function mappingFor(props: {
  slug: string;
  model: string;
  fields: unknown[];
}): ModelMapping {
  return buildCollectionMapping({
    datamodel,
    collection: {
      slug: props.slug,
      custom: { prisma: { model: props.model } },
      flattenedFields: props.fields,
    } as unknown as SanitizedCollectionConfig,
  });
}

const posts = mappingFor({
  slug: "posts",
  model: "BlogPost",
  fields: [
    { name: "title", type: "text" },
    { name: "views", type: "number" },
    { name: "featured", type: "checkbox" },
    { name: "publishedAt", type: "date" },
    { name: "author", type: "relationship", relationTo: "authors" },
    { name: "tags", type: "relationship", relationTo: "tags", hasMany: true },
  ],
});

const authors = mappingFor({
  slug: "authors",
  model: "Author",
  fields: [{ name: "name", type: "text" }],
});

const byModel = new Map([
  ["BlogPost", posts],
  ["Author", authors],
]);

const where = (input: Parameters<typeof buildWhere>[0]["where"]) =>
  buildWhere({ where: input, mapping: posts, byModel });

describe("buildWhere — scalars", () => {
  it("translates the comparison operators", () => {
    expect(where({ views: { greater_than: 5 } })).toEqual({ views: { gt: 5 } });
    expect(where({ views: { less_than_equal: 5 } })).toEqual({ views: { lte: 5 } });
    expect(where({ title: { not_equals: "x" } })).toEqual({ title: { not: "x" } });
  });

  it("makes text search case-insensitive, as Payload's own adapters do", () => {
    expect(where({ title: { like: "hello" } })).toEqual({
      title: { contains: "hello", mode: "insensitive" },
    });
  });

  it("coerces a query-string value to the column's type", () => {
    // A URL carries `?where[views][equals]=5`, and Prisma will not convert it.
    expect(where({ views: { equals: "5" } })).toEqual({ views: { equals: 5 } });
    const parsed = where({ publishedAt: { greater_than: "2024-01-01T00:00:00.000Z" } });
    expect((parsed?.publishedAt as { gt: Date }).gt).toBeInstanceOf(Date);
  });

  it("distinguishes `exists` from `equals: null`", () => {
    expect(where({ publishedAt: { exists: true } })).toEqual({ publishedAt: { not: null } });
    expect(where({ publishedAt: { equals: null } })).toEqual({ publishedAt: { equals: null } });
  });

  it("reads several operators on one path as AND", () => {
    expect(where({ views: { greater_than: 1, less_than: 10 } })).toEqual({
      AND: [{ views: { gt: 1 } }, { views: { lt: 10 } }],
    });
  });
});

describe("buildWhere — relationships", () => {
  it("filters an owning to-one on its foreign key, with no join", () => {
    expect(where({ author: { equals: "a1" } })).toEqual({ authorId: { equals: "a1" } });
  });

  it("filters a to-many through `some`, coercing the ids", () => {
    // The picker sends strings; `Tag.id` is an Int.
    expect(where({ tags: { in: ["1", "2"] } })).toEqual({
      tags: { some: { id: { in: [1, 2] } } },
    });
  });

  it("reads `all` as every id present, not any", () => {
    expect(where({ tags: { all: ["1", "2"] } })).toEqual({
      AND: [{ tags: { some: { id: 1 } } }, { tags: { some: { id: 2 } } }],
    });
  });

  it("traverses a dotted path into the target's own field names", () => {
    expect(where({ "author.name": { like: "ana" } })).toEqual({
      author: { is: { name: { contains: "ana", mode: "insensitive" } } },
    });
  });
});

describe("buildWhere — structure", () => {
  it("keeps and/or", () => {
    expect(where({ or: [{ featured: { equals: true } }, { views: { greater_than: 100 } }] })).toEqual(
      { OR: [{ featured: { equals: true } }, { views: { gt: 100 } }] },
    );
  });

  it("preserves an empty `or`, which matches nothing", () => {
    // Dropping it would WIDEN the result set, which for an access-control
    // filter is a leak.
    expect(where({ or: [] })).toEqual({ OR: [] });
  });

  it("returns undefined for an empty query", () => {
    expect(where({})).toBeUndefined();
    expect(where(undefined)).toBeUndefined();
  });
});

describe("buildWhere — what it refuses", () => {
  it("refuses an unmapped field rather than ignoring it", () => {
    expect(() => where({ nope: { equals: 1 } })).toThrow(/not a field that maps/);
  });

  it("refuses a geospatial operator it cannot express", () => {
    expect(() => where({ title: { near: [1, 2] } })).toThrow(/geospatial/);
  });

  it("refuses to traverse past a scalar", () => {
    expect(() => where({ "title.length": { equals: 1 } })).toThrow(/scalar column/);
  });
});

describe("buildOrderBy", () => {
  it("appends the primary key so pages cannot repeat a row", () => {
    expect(buildOrderBy({ sort: "-views", mapping: posts, byModel })).toEqual([
      { views: "desc" },
      { id: "asc" },
    ]);
  });

  it("does not append it twice", () => {
    expect(buildOrderBy({ sort: "id", mapping: posts, byModel })).toEqual([{ id: "asc" }]);
  });

  it("sorts an owning to-one by its foreign key", () => {
    expect(buildOrderBy({ sort: "author", mapping: posts, byModel })).toEqual([
      { authorId: "asc" },
      { id: "asc" },
    ]);
  });

  it("sorts through a relation", () => {
    expect(buildOrderBy({ sort: "-author.name", mapping: posts, byModel })).toEqual([
      { author: { name: "desc" } },
      { id: "asc" },
    ]);
  });

  it("refuses to sort by a to-many, which has no single value", () => {
    expect(() => buildOrderBy({ sort: "tags.label", mapping: posts, byModel })).toThrow(
      /to-many/,
    );
  });
});
