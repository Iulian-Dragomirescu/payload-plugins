import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadDatamodel, PrismaAdapterSchemaError } from "./load.js";

/**
 * Prisma 7 gives new projects `prismaSchemaFolder`, so "the schema" is a
 * directory of files rather than one file, and a real project's models are
 * spread across it. These tests run against a directory on disk, because what
 * is being checked is the reading, and a stubbed filesystem would only prove
 * the stub.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "prisma-adapter-"));
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

/** Writes a file, creating the directories above it. */
function write(relative: string, source: string): string {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, source, "utf8");
  return path;
}

const POST = `
model BlogPost {
  id       String @id @default(cuid())
  title    String
  author   Author @relation(fields: [authorId], references: [id])
  authorId String
}
`;

const AUTHOR = `
model Author {
  id    String     @id @default(cuid())
  name  String
  posts BlogPost[]
}
`;

describe("loadDatamodel — one file", () => {
  it("reads a path to a file", () => {
    const path = write("prisma/schema.prisma", POST + AUTHOR);
    const datamodel = loadDatamodel({ schema: { path } });

    expect(Object.keys(datamodel.models).sort()).toEqual(["Author", "BlogPost"]);
  });

  it("names the path it could not read", () => {
    expect(() => loadDatamodel({ schema: { path: join(root, "nope.prisma") } })).toThrow(
      /Could not read the Prisma schema at .*nope\.prisma/,
    );
  });

  it("refuses a schema with no models", () => {
    const path = write("prisma/schema.prisma", 'generator client { provider = "prisma-client" }');
    expect(() => loadDatamodel({ schema: { path } })).toThrow(/declares no models/);
  });
});

describe("loadDatamodel — a schema folder", () => {
  it("reads every `.prisma` file under a directory, recursively", () => {
    write("prisma/schema/schema.prisma", 'datasource db { provider = "postgresql" }');
    write("prisma/schema/models/post.prisma", POST);
    write("prisma/schema/models/author.prisma", AUTHOR);

    const datamodel = loadDatamodel({ schema: { path: join(root, "prisma/schema") } });

    expect(Object.keys(datamodel.models).sort()).toEqual(["Author", "BlogPost"]);
  });

  it("resolves a relation whose two sides are in different files", () => {
    // The whole reason the files are concatenated before parsing rather than
    // parsed one at a time and merged.
    write("prisma/schema/models/post.prisma", POST);
    write("prisma/schema/models/author.prisma", AUTHOR);

    const datamodel = loadDatamodel({ schema: { path: join(root, "prisma/schema") } });
    const author = datamodel.models.BlogPost?.fields.find((field) => field.name === "author");

    expect(author?.kind).toBe("object");
    expect(author?.relationFromFields).toEqual(["authorId"]);
  });

  it("sees an enum declared in another file", () => {
    // The parser scans for enums before classifying field types, and it can
    // only do that across files if it has them all at once. Without this,
    // `status Status` reads as a relation to a model called `Status`.
    write("prisma/schema/enums.prisma", "enum Status {\n  DRAFT\n  LIVE\n}");
    write(
      "prisma/schema/models/post.prisma",
      "model Post {\n  id String @id\n  status Status\n}",
    );

    const datamodel = loadDatamodel({ schema: { path: join(root, "prisma/schema") } });
    const status = datamodel.models.Post?.fields.find((field) => field.name === "status");

    expect(status?.kind).toBe("enum");
  });

  it("ignores files that are not `.prisma`", () => {
    write("prisma/schema/models/post.prisma", POST + AUTHOR);
    write("prisma/schema/README.md", "model NotAModel { id String @id }");

    const datamodel = loadDatamodel({ schema: { path: join(root, "prisma/schema") } });
    expect(datamodel.models.NotAModel).toBeUndefined();
  });

  it("names the folder when it holds no schema files", () => {
    mkdirSync(join(root, "prisma/schema"), { recursive: true });
    expect(() => loadDatamodel({ schema: { path: join(root, "prisma/schema") } })).toThrow(
      /holds no `\.prisma` files/,
    );
  });
});

describe("loadDatamodel — a list of paths", () => {
  it("reads files and folders together", () => {
    const base = write("prisma/base.prisma", AUTHOR);
    write("prisma/models/post.prisma", POST);

    const datamodel = loadDatamodel({
      schema: { path: [base, join(root, "prisma/models")] },
    });

    expect(Object.keys(datamodel.models).sort()).toEqual(["Author", "BlogPost"]);
  });

  it("fails on the entry that is missing, not silently on the rest", () => {
    const base = write("prisma/base.prisma", AUTHOR);
    expect(() =>
      loadDatamodel({ schema: { path: [base, join(root, "gone.prisma")] } }),
    ).toThrow(PrismaAdapterSchemaError);
  });
});

describe("loadDatamodel — the default path", () => {
  const cwd = process.cwd();
  afterEach(() => process.chdir(cwd));

  it("finds `prisma/schema.prisma`", () => {
    write("prisma/schema.prisma", POST + AUTHOR);
    process.chdir(root);

    expect(Object.keys(loadDatamodel({}).models).sort()).toEqual(["Author", "BlogPost"]);
  });

  it("falls back to the `prisma/schema` folder, which Prisma 7 generates", () => {
    write("prisma/schema/models/post.prisma", POST);
    write("prisma/schema/models/author.prisma", AUTHOR);
    process.chdir(root);

    expect(Object.keys(loadDatamodel({}).models).sort()).toEqual(["Author", "BlogPost"]);
  });

  it("names both places it looked when there is neither", () => {
    process.chdir(root);
    expect(() => loadDatamodel({})).toThrow(/schema\.prisma[\s\S]*prisma[\/\\]schema/);
  });
});
