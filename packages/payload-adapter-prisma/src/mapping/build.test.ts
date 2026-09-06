import type { SanitizedCollectionConfig, SanitizedGlobalConfig } from "payload";
import { describe, expect, it } from "vitest";

import { parsePrismaSchema } from "../schema/parseSchema.js";
import { buildCollectionMapping, buildGlobalMapping, PrismaAdapterMappingError } from "./build.js";

/**
 * The mapping is a set of strings pointing at another file, and nothing in the
 * type system checks them. These tests are that check: a correct config
 * resolves, and a wrong one fails with a message naming the fix.
 */

const SCHEMA = `
model BlogPost {
  id          String    @id @default(cuid())
  title       String
  content     String?
  views       Int       @default(0)
  updatedAt   DateTime  @updatedAt

  author   Author @relation("PostAuthor", fields: [authorId], references: [id])
  authorId String

  reviewer   Author? @relation("PostReviewer", fields: [reviewerId], references: [id])
  reviewerId String?

  tags Tag[] @relation("PostToTag")

  @@map("blog_posts")
}

model Author {
  id    String     @id @default(cuid())
  name  String
  posts BlogPost[] @relation("PostAuthor")
  reviewing BlogPost[] @relation("PostReviewer")
}

model Tag {
  id    Int    @id @default(autoincrement())
  label String
  posts BlogPost[] @relation("PostToTag")
}

model Composite {
  left  String
  right String
  @@id([left, right])
}

model SiteSetting {
  id           String @id @default(cuid())
  title        String
  postsPerPage Int    @default(10)
}

model Setting {
  id    String @id @default(cuid())
  key   String @unique
  value String
}
`;

const datamodel = parsePrismaSchema({ source: SCHEMA });

/** Builds the minimum of a sanitized collection the mapper reads. */
function collection(props: {
  slug: string;
  custom?: unknown;
  fields: unknown[];
}): SanitizedCollectionConfig {
  return {
    slug: props.slug,
    custom: props.custom,
    flattenedFields: props.fields,
  } as unknown as SanitizedCollectionConfig;
}

describe("buildCollectionMapping — a config that resolves", () => {
  const mapping = buildCollectionMapping({
    datamodel,
    collection: collection({
      slug: "posts",
      custom: { prisma: { model: "BlogPost" } },
      fields: [
        { name: "title", type: "text" },
        { name: "body", type: "textarea", custom: { prisma: { field: "content" } } },
        { name: "views", type: "number" },
        { name: "updatedAt", type: "date" },
        {
          name: "author",
          type: "relationship",
          relationTo: "authors",
          custom: { prisma: { field: "author", foreignKey: "authorId" } },
        },
        {
          name: "reviewer",
          type: "relationship",
          relationTo: "authors",
          custom: { prisma: { foreignKey: "reviewerId" } },
        },
        { name: "tags", type: "relationship", relationTo: "tags", hasMany: true },
      ],
    }),
  });

  it("resolves the model and its delegate", () => {
    expect(mapping.model).toBe("BlogPost");
    expect(mapping.delegate).toBe("blogPost");
    expect(mapping.idField.name).toBe("id");
  });

  it("maps a renamed field to its column", () => {
    expect(mapping.fields.get("body")?.prismaField).toBe("content");
  });

  it("adds `id` even though the config never lists it", () => {
    expect(mapping.fields.get("id")?.prismaField).toBe("id");
  });

  it("marks `@updatedAt` read-only without being told to", () => {
    // Prisma maintains this column. Writing it is an error, not a preference,
    // so it is not left to the config to remember.
    expect(mapping.fields.get("updatedAt")?.readOnly).toBe(true);
  });

  it("tells two relations to the same model apart by foreign key", () => {
    const author = mapping.fields.get("author");
    const reviewer = mapping.fields.get("reviewer");
    expect(author?.kind).toBe("relation");
    expect(reviewer?.kind).toBe("relation");
    if (author?.kind !== "relation" || reviewer?.kind !== "relation") return;

    expect(author.foreignKey).toBe("authorId");
    expect(reviewer.foreignKey).toBe("reviewerId");
    expect(author.prismaField).toBe("author");
    expect(reviewer.prismaField).toBe("reviewer");
  });

  it("records the target's key type, so ids can be coerced", () => {
    const tags = mapping.fields.get("tags");
    if (tags?.kind !== "relation") throw new Error("expected a relation");
    expect(tags.targetIdField.type).toBe("Int");
    expect(tags.isList).toBe(true);
  });

  it("includes only relations that cannot be read off a local column", () => {
    // `author` and `reviewer` are owning to-ones, readable from their foreign
    // keys, so including them would add a join for data already in the row.
    expect(mapping.includes.map((relation) => relation.path)).toEqual(["tags"]);
  });
});

describe("buildCollectionMapping — a config that does not", () => {
  it("names the models when the model is missing", () => {
    expect(() =>
      buildCollectionMapping({
        datamodel,
        collection: collection({
          slug: "posts",
          custom: { prisma: { model: "Post" } },
          fields: [],
        }),
      }),
    ).toThrow(/not in the schema[\s\S]*BlogPost/);
  });

  it("names the columns when a field is missing", () => {
    expect(() =>
      buildCollectionMapping({
        datamodel,
        collection: collection({
          slug: "posts",
          custom: { prisma: { model: "BlogPost" } },
          fields: [{ name: "bodyText", type: "text" }],
        }),
      }),
    ).toThrow(/does not exist[\s\S]*title, content/);
  });

  it("refuses a cardinality that disagrees with the schema", () => {
    expect(() =>
      buildCollectionMapping({
        datamodel,
        collection: collection({
          slug: "posts",
          custom: { prisma: { model: "BlogPost" } },
          fields: [{ name: "tags", type: "relationship", relationTo: "tags" }],
        }),
      }),
    ).toThrow(/hasMany: false[\s\S]*is a list/);
  });

  it("refuses a polymorphic relationship, which has no column", () => {
    expect(() =>
      buildCollectionMapping({
        datamodel,
        collection: collection({
          slug: "posts",
          custom: { prisma: { model: "BlogPost" } },
          fields: [
            { name: "author", type: "relationship", relationTo: ["authors", "tags"] },
          ],
        }),
      }),
    ).toThrow(/polymorphic/);
  });

  it("refuses a composite primary key, which has no id to address", () => {
    expect(() =>
      buildCollectionMapping({
        datamodel,
        collection: collection({
          slug: "pairs",
          custom: { prisma: { model: "Composite" } },
          fields: [],
        }),
      }),
    ).toThrow(/composite key/);
  });

  it("refuses a foreignKey no relation travels over", () => {
    expect(() =>
      buildCollectionMapping({
        datamodel,
        collection: collection({
          slug: "posts",
          custom: { prisma: { model: "BlogPost" } },
          fields: [
            {
              name: "author",
              type: "relationship",
              relationTo: "authors",
              custom: { prisma: { foreignKey: "writerId" } },
            },
          ],
        }),
      }),
    ).toThrow(PrismaAdapterMappingError);
  });
});


/** Builds the minimum of a sanitized global the mapper reads. */
function global_(props: {
  slug: string;
  custom?: unknown;
  fields: unknown[];
}): SanitizedGlobalConfig {
  return {
    slug: props.slug,
    custom: props.custom,
    flattenedFields: props.fields,
  } as unknown as SanitizedGlobalConfig;
}

describe("buildGlobalMapping", () => {
  // Payload adds `createdAt` and `updatedAt` to EVERY global, and unlike a
  // collection there is no `timestamps: false` to turn them off. A table that
  // was not designed for a CMS will not have those columns, so a global that
  // could not map without them could barely map at all.
  const fields = [
    { name: "title", type: "text" },
    { name: "postsPerPage", type: "number" },
    { name: "updatedAt", type: "date" },
    { name: "createdAt", type: "date" },
  ];

  it("maps onto a model that has no timestamp columns", () => {
    const mapping = buildGlobalMapping({
      datamodel,
      global: global_({
        slug: "siteSettings",
        custom: { prisma: { model: "SiteSetting" } },
        fields,
      }),
    });

    expect(mapping.kind).toBe("global");
    expect(mapping.model).toBe("SiteSetting");
    expect(mapping.fields.get("title")?.prismaField).toBe("title");
    // Silently dropped rather than mapped to a column that is not there.
    expect(mapping.fields.has("createdAt")).toBe(false);
    expect(mapping.fields.has("updatedAt")).toBe(false);
  });

  it("still maps a timestamp column that DOES exist", () => {
    const mapping = buildGlobalMapping({
      datamodel,
      global: global_({
        slug: "posts",
        custom: { prisma: { model: "BlogPost" } },
        fields: [{ name: "title", type: "text" }, { name: "updatedAt", type: "date" }],
      }),
    });
    expect(mapping.fields.get("updatedAt")?.prismaField).toBe("updatedAt");
    // And it is still Prisma's to maintain.
    expect(mapping.fields.get("updatedAt")?.readOnly).toBe(true);
  });

  it("records `where` as the row this global is", () => {
    const mapping = buildGlobalMapping({
      datamodel,
      global: global_({
        slug: "siteSettings",
        custom: { prisma: { model: "Setting", where: { key: "site" } } },
        fields: [{ name: "value", type: "text" }],
      }),
    });
    expect(mapping.singleton).toEqual({ key: "site" });
  });

  it("has no `singleton` when the global is simply the first row", () => {
    const mapping = buildGlobalMapping({
      datamodel,
      global: global_({
        slug: "siteSettings",
        custom: { prisma: { model: "SiteSetting" } },
        fields,
      }),
    });
    expect(mapping.singleton).toBeUndefined();
  });

  it("names the global, not a collection, when the model is missing", () => {
    expect(() =>
      buildGlobalMapping({
        datamodel,
        global: global_({
          slug: "siteSettings",
          custom: { prisma: { model: "Nope" } },
          fields: [],
        }),
      }),
    ).toThrow(/Global "siteSettings"/);
  });
});
