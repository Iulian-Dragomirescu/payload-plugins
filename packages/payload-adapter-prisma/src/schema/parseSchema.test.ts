import { describe, expect, it } from "vitest";
import { getField, getModel, getPrimaryKeyField, isDatamodelThin } from "./datamodel";
import { parsePrismaSchema } from "./parseSchema";

/**
 * The parser is load-bearing, not a convenience.
 *
 * Prisma 7's generated client carries no relation metadata, so this is the only
 * source that can say which side of a relation owns the foreign key, and that
 * decides whether a write is a `connect` or a scalar assignment. A bug here is
 * a silently wrong write, not a crash.
 */

const SCHEMA = `
// A comment mentioning model NotAModel { that should be ignored.
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}

enum Status {
  DRAFT
  PUBLISHED
}

/// Doc comment.
model BlogPost {
  id          String    @id @default(cuid())
  title       String
  slug        String    @unique
  content     String?   // trailing comment
  views       Int       @default(0)
  status      Status    @default(DRAFT)
  publishedAt DateTime?
  updatedAt   DateTime  @updatedAt
  legacyName  String    @map("legacy_name")

  author   Author @relation("PostAuthor", fields: [authorId], references: [id])
  authorId String

  reviewer   Author? @relation("PostReviewer", fields: [reviewerId], references: [id])
  reviewerId String?

  tags Tag[] @relation("PostToTag")

  parent   BlogPost?  @relation("PostHierarchy", fields: [parentId], references: [id])
  parentId String?
  children BlogPost[] @relation("PostHierarchy")

  @@index([authorId])
  @@map("blog_posts")
}

model Author {
  id    String @id @default(cuid())
  name  String

  posts     BlogPost[] @relation("PostAuthor")
  reviewing BlogPost[] @relation("PostReviewer")

  @@map("authors")
}

model Tag {
  id    Int    @id @default(autoincrement())
  label String @unique

  posts BlogPost[] @relation("PostToTag")
}

model Membership {
  authorId       String
  organizationId String

  @@id([authorId, organizationId])
}
`;

const datamodel = parsePrismaSchema({ source: SCHEMA });

describe("models", () => {
  it("finds every model and no false positives from comments", () => {
    expect(Object.keys(datamodel.models).sort()).toEqual([
      "Author",
      "BlogPost",
      "Membership",
      "Tag",
    ]);
  });

  it("reads `@@map`", () => {
    expect(getModel({ datamodel, model: "BlogPost" })?.dbName).toBe("blog_posts");
  });

  it("leaves `dbName` unset for a model with no `@@map`", () => {
    expect(getModel({ datamodel, model: "Tag" })?.dbName).toBeUndefined();
  });

  it("reads a composite `@@id`", () => {
    // Not merely informational: a composite key is what `buildMapping` rejects,
    // and it can only reject what it can see.
    expect(getModel({ datamodel, model: "Membership" })?.compositePrimaryKey).toEqual([
      "authorId",
      "organizationId",
    ]);
  });

  it("does not treat `@@index` or `@@map` lines as fields", () => {
    const names = getModel({ datamodel, model: "BlogPost" })!.fields.map((f) => f.name);
    expect(names).not.toContain("@@index");
    expect(names).not.toContain("@@map");
  });
});

describe("scalar fields", () => {
  const model = getModel({ datamodel, model: "BlogPost" })!;

  it("marks the primary key", () => {
    expect(getPrimaryKeyField({ model })?.name).toBe("id");
  });

  it("reads optionality from the `?` suffix", () => {
    expect(getField({ model, field: "title" })?.isRequired).toBe(true);
    expect(getField({ model, field: "content" })?.isRequired).toBe(false);
  });

  it("reads `@unique`", () => {
    expect(getField({ model, field: "slug" })?.isUnique).toBe(true);
    expect(getField({ model, field: "title" })?.isUnique).toBe(false);
  });

  it("reads `@updatedAt`, which is what stops the adapter writing the column", () => {
    expect(getField({ model, field: "updatedAt" })?.isUpdatedAt).toBe(true);
  });

  it("reads `@default(autoincrement())` as database-generated", () => {
    const tag = getModel({ datamodel, model: "Tag" })!;
    expect(getField({ model: tag, field: "id" })?.isGenerated).toBe(true);
    expect(getField({ model, field: "views" })?.isGenerated).toBe(false);
  });

  it("reads `@map` on a field", () => {
    expect(getField({ model, field: "legacyName" })?.dbName).toBe("legacy_name");
  });

  it("classifies a declared enum as an enum, not as a relation", () => {
    // Without the enum pass, `Status` looks like another model and the field
    // becomes a relation the adapter would then try to `connect` to.
    expect(getField({ model, field: "status" })).toMatchObject({
      kind: "enum",
      type: "Status",
    });
  });

  it("ignores a trailing line comment", () => {
    expect(getField({ model, field: "content" })?.type).toBe("String");
  });
});

describe("relation fields — the metadata Prisma 7 no longer provides", () => {
  const model = getModel({ datamodel, model: "BlogPost" })!;

  it("marks the OWNING side with its local foreign key", () => {
    expect(getField({ model, field: "author" })).toMatchObject({
      kind: "object",
      type: "Author",
      relationName: "PostAuthor",
      relationFromFields: ["authorId"],
      relationToFields: ["id"],
      isList: false,
    });
  });

  it("distinguishes two relations to the same model by their foreign keys", () => {
    expect(getField({ model, field: "author" })?.relationFromFields).toEqual(["authorId"]);
    expect(getField({ model, field: "reviewer" })?.relationFromFields).toEqual(["reviewerId"]);
  });

  it("marks the NON-owning side with an empty foreign-key list, not undefined", () => {
    // "The other side owns it" is a real answer that changes how a write is
    // spelled. `undefined` would read as "unknown".
    const author = getModel({ datamodel, model: "Author" })!;
    expect(getField({ model: author, field: "posts" })).toMatchObject({
      isList: true,
      relationFromFields: [],
    });
  });

  it("marks an implicit many-to-many as a list with no foreign key", () => {
    expect(getField({ model, field: "tags" })).toMatchObject({
      kind: "object",
      type: "Tag",
      isList: true,
      relationFromFields: [],
    });
  });

  it("parses both halves of a self-relation", () => {
    expect(getField({ model, field: "parent" })).toMatchObject({
      type: "BlogPost",
      isList: false,
      relationFromFields: ["parentId"],
    });
    expect(getField({ model, field: "children" })).toMatchObject({
      type: "BlogPost",
      isList: true,
      relationFromFields: [],
    });
  });

  it("reads a positional relation name as well as a `name:` one", () => {
    const source = `
      model A {
        id String @id
        b  B      @relation("Named", fields: [bId], references: [id])
        bId String
        c  C      @relation(name: "Keyed", fields: [cId], references: [id])
        cId String
      }
    `;
    const parsed = parsePrismaSchema({ source });
    const a = getModel({ datamodel: parsed, model: "A" })!;
    expect(getField({ model: a, field: "b" })?.relationName).toBe("Named");
    expect(getField({ model: a, field: "c" })?.relationName).toBe("Keyed");
  });
});

describe("isDatamodelThin", () => {
  it("accepts a parsed schema, which always carries primary keys", () => {
    expect(isDatamodelThin({ datamodel })).toBe(false);
  });

  it("rejects a Prisma 7 runtime datamodel, which carries none", () => {
    // The exact shape `_runtimeDataModel` has on Prisma 7: a name, a kind, a
    // type, a relation name, and nothing else. Detecting it is what turns a
    // silently wrong mapping into an actionable error.
    const thin = {
      models: {
        BlogPost: {
          name: "BlogPost",
          dbName: "blog_posts",
          fields: [
            {
              name: "id",
              kind: "scalar" as const,
              type: "String",
              isList: false,
              isRequired: true,
              isId: false,
              isUnique: false,
              hasDefaultValue: false,
              isUpdatedAt: false,
              isGenerated: false,
            },
          ],
        },
      },
    };
    expect(isDatamodelThin({ datamodel: thin })).toBe(true);
  });

  it("rejects an empty datamodel", () => {
    expect(isDatamodelThin({ datamodel: { models: {} } })).toBe(true);
  });
});
