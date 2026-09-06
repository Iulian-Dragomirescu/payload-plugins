import type { SanitizedCollectionConfig } from "payload";
import { describe, expect, it } from "vitest";

import { buildCollectionMapping } from "../mapping/build.js";
import { parsePrismaSchema } from "../schema/parseSchema.js";
import { toPayloadDoc } from "./read.js";
import { buildData } from "./write.js";

/**
 * The relation write table, asserted:
 *
 * | Relation | create           | update                            |
 * | -------- | ---------------- | --------------------------------- |
 * | to-one   | connect          | connect, or disconnect for null   |
 * | to-many  | connect (list)   | set, replaces the whole set       |
 *
 * The `set` row matters most. `connect` on an update only ever adds, so
 * removing a tag would silently do nothing.
 */

const datamodel = parsePrismaSchema({
  source: `
model BlogPost {
  id        String    @id @default(cuid())
  title     String
  content   String?
  views     Int       @default(0)
  publishedAt DateTime?
  updatedAt DateTime  @updatedAt
  author    Author    @relation("A", fields: [authorId], references: [id])
  authorId  String
  reviewer  Author?   @relation("R", fields: [reviewerId], references: [id])
  reviewerId String?
  tags      Tag[]     @relation("T")
}
model Author {
  id   String @id
  name String
  posts BlogPost[] @relation("A")
  reviewing BlogPost[] @relation("R")
}
model Tag {
  id    Int    @id @default(autoincrement())
  label String
  posts BlogPost[] @relation("T")
}
`,
});

const mapping = buildCollectionMapping({
  datamodel,
  collection: {
    slug: "posts",
    custom: { prisma: { model: "BlogPost" } },
    flattenedFields: [
      { name: "title", type: "text" },
      { name: "body", type: "textarea", custom: { prisma: { field: "content" } } },
      { name: "views", type: "number", custom: { prisma: { readOnly: true } } },
      { name: "publishedAt", type: "date" },
      { name: "updatedAt", type: "date" },
      {
        name: "author",
        type: "relationship",
        relationTo: "authors",
        custom: { prisma: { foreignKey: "authorId" } },
      },
      {
        name: "reviewer",
        type: "relationship",
        relationTo: "authors",
        custom: { prisma: { foreignKey: "reviewerId" } },
      },
      { name: "tags", type: "relationship", relationTo: "tags", hasMany: true },
    ],
  } as unknown as SanitizedCollectionConfig,
});

const create = (data: Record<string, unknown>) => buildData({ data, mapping, mode: "create" });
const update = (data: Record<string, unknown>) => buildData({ data, mapping, mode: "update" });

describe("buildData — relationships", () => {
  it("connects a to-one on create", () => {
    expect(create({ author: "a1" })).toEqual({ author: { connect: { id: "a1" } } });
  });

  it("connects a list on create", () => {
    expect(create({ tags: ["1", "2"] })).toEqual({
      tags: { connect: [{ id: 1 }, { id: 2 }] },
    });
  });

  it("SETS a list on update, replacing it", () => {
    expect(update({ tags: ["2"] })).toEqual({ tags: { set: [{ id: 2 }] } });
  });

  it("clears a list with an empty set", () => {
    expect(update({ tags: [] })).toEqual({ tags: { set: [] } });
  });

  it("disconnects a to-one cleared on update", () => {
    expect(update({ reviewer: null })).toEqual({ reviewer: { disconnect: true } });
  });

  it("omits a to-one that is null on create — there is nothing to detach from", () => {
    expect(create({ reviewer: null, title: "x" })).toEqual({ title: "x" });
  });

  it("coerces relationship ids to the target key's type", () => {
    // A picker sends `"7"`. `Tag.id` is an `Int`, and Prisma will not convert.
    expect(create({ tags: ["7"] })).toEqual({ tags: { connect: [{ id: 7 }] } });
  });

  it("accepts a whole document where an id was expected", () => {
    expect(create({ author: { id: "a1", name: "Ana" } })).toEqual({
      author: { connect: { id: "a1" } },
    });
  });

  it("writes two relations to the same model separately", () => {
    expect(create({ author: "a1", reviewer: "a2" })).toEqual({
      author: { connect: { id: "a1" } },
      reviewer: { connect: { id: "a2" } },
    });
  });
});

describe("buildData — what it will not write", () => {
  it("drops a field the config does not declare", () => {
    expect(create({ secret: "leak", title: "x" })).toEqual({ title: "x" });
  });

  it("drops a read-only field", () => {
    expect(update({ views: 999 })).toEqual({});
  });

  it("drops `@updatedAt`, which Prisma maintains", () => {
    expect(update({ updatedAt: "2024-01-01T00:00:00.000Z" })).toEqual({});
  });

  it("refuses to clear a non-nullable column", () => {
    expect(() => update({ title: null })).toThrow(/non-nullable/);
  });
});

describe("buildData — scalars", () => {
  it("renames a field to its column", () => {
    expect(create({ body: "hello" })).toEqual({ content: "hello" });
  });

  it("parses an ISO string into a Date", () => {
    const data = create({ publishedAt: "2024-06-01T10:00:00.000Z" });
    expect(data.publishedAt).toBeInstanceOf(Date);
  });
});

describe("toPayloadDoc", () => {
  it("reads an owning to-one off its foreign key, with no join", () => {
    const doc = toPayloadDoc({
      mapping,
      row: { id: "p1", title: "t", content: "c", authorId: "a1", reviewerId: null },
    });
    expect(doc).toMatchObject({ author: "a1", body: "c", id: "p1", reviewer: null });
  });

  it("renders every id as a string, whatever the column's type", () => {
    const doc = toPayloadDoc({
      mapping,
      row: { id: "p1", tags: [{ id: 1 }, { id: 2 }] },
    });
    expect(doc.tags).toEqual(["1", "2"]);
  });

  it("renders dates as ISO strings, which is the adapter contract", () => {
    const doc = toPayloadDoc({
      mapping,
      row: { id: "p1", publishedAt: new Date("2024-06-01T10:00:00.000Z") },
    });
    expect(doc.publishedAt).toBe("2024-06-01T10:00:00.000Z");
  });

  it("drops a column the config does not declare", () => {
    const doc = toPayloadDoc({ mapping, row: { id: "p1", passwordHash: "$2b$…" } });
    expect(doc).not.toHaveProperty("passwordHash");
  });

  it("reads a NULL structured column as absent, not null", () => {
    // Payload fills an absent `group` with `{}` so hooks inside it can run,
    // and reads a literal `null` there as a crash. An empty `meta` column
    // would otherwise take down every list view that includes it.
    const withGroup = buildCollectionMapping({
      datamodel,
      collection: {
        slug: "posts",
        custom: { prisma: { model: "BlogPost" } },
        flattenedFields: [
          { name: "title", type: "text" },
          { name: "content", type: "group", flattenedFields: [] },
        ],
      } as unknown as SanitizedCollectionConfig,
    });

    const doc = toPayloadDoc({ mapping: withGroup, row: { id: "p1", content: null } });
    expect(doc).not.toHaveProperty("content");
    // A plain scalar still reads back as null, which is a real value.
    expect(toPayloadDoc({ mapping, row: { id: "p1", content: null } }).body).toBeNull();
  });
});
