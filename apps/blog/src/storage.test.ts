import "dotenv/config";

import { Client } from "pg";
import { getPayload, type Payload } from "payload";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { describeStorage } from "payload-adapter-prisma";

import config from "./payload.config";

/**
 * The integration suite, against the two databases in `docker-compose.yml`.
 *
 * Written from the outside: every operation goes through Payload's Local API,
 * exactly as the admin panel and the REST API do, and every assertion that
 * matters is then checked with raw SQL rather than against the layer that
 * wrote it.
 *
 * ```bash
 * pnpm db:up && pnpm test
 * ```
 */

let payload: Payload;
let sql: Client;

/** Every table `schema.prisma` accounts for, including Prisma's join table. */
const SCHEMA_TABLES = [
  "_PostToTag",
  "authors",
  "blog_posts",
  "organizations",
  "site_settings",
  "tags",
  "users",
];

beforeAll(async () => {
  payload = await getPayload({ config });
  sql = new Client({ connectionString: process.env.DATABASE_URL });
  await sql.connect();
});

afterAll(async () => {
  await sql.end();
});

/**
 * Creates an author nobody else's test will collide with.
 *
 * The NAME is made unique too, not just the email: these tests run against a
 * database that keeps its rows between runs, and a query filtering on a name
 * would otherwise match every previous run's author as well.
 */
async function anAuthor(label: string) {
  const name = `${label}-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  return payload.create({
    collection: "authors",
    data: { email: `${name}@example.com`, name },
  });
}

/** Creates a post with a required author. */
async function aPost(data: Record<string, unknown>) {
  return payload.create({
    collection: "posts",
    data: { slug: `post-${Date.now()}-${Math.random()}`, title: "Test", ...data } as never,
  });
}

describe("the two databases", () => {
  it("adds no table to `public` — every one is from schema.prisma", async () => {
    const { rows } = await sql.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    expect(rows.map((row) => row.tablename)).toEqual(SCHEMA_TABLES);
  });

  it("adds no schema to your database either", async () => {
    const { rows } = await sql.query<{ nspname: string }>(
      "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY nspname",
    );
    expect(rows.map((row) => row.nspname)).toEqual(["public"]);
  });

  it("routes each collection and global by whether it declares a Prisma model", () => {
    const storage = describeStorage({ payload });
    expect(storage.prisma).toEqual([
      "posts",
      "authors",
      "tags",
      "organizations",
      "people",
      "global:siteSettings",
    ]);
    // Payload's own collections were never listed anywhere. They are internal
    // because they carry no mapping.
    expect(storage.internal).toContain("payload-preferences");
    expect(storage.internal).toContain("payload-locked-documents");
    expect(storage.internal).toContain("admins");
    expect(storage.internal).toContain("global:editorialSettings");
  });

  it("keeps admin logins out of your database entirely", async () => {
    const { rows } = await sql.query<{ count: string }>(
      "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND column_name IN ('hash', 'salt', 'resetPasswordToken', 'loginAttempts')",
    );
    expect(rows[0]?.count).toBe("0");
  });
});

describe("a global stored in Prisma", () => {
  it("creates its row on the first save, so the table needs no seeding", async () => {
    // Start from a genuinely empty table, the state a fresh `prisma db push`
    // leaves and the one a global has to cope with.
    await sql.query("DELETE FROM site_settings");
    expect((await sql.query("SELECT id FROM site_settings")).rowCount).toBe(0);

    await payload.updateGlobal({
      slug: "siteSettings",
      data: { postsPerPage: 7, tagline: "Written by the first save", title: "Created" },
    });

    const { rows } = await sql.query<{ postsPerPage: number; title: string }>(
      'SELECT title, "postsPerPage" FROM site_settings',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Created");
    expect(rows[0]?.postsPerPage).toBe(7);
  });

  it("reads back the row it wrote", async () => {
    await payload.updateGlobal({ slug: "siteSettings", data: { title: "Round-tripped" } });
    const global = await payload.findGlobal({ slug: "siteSettings" });
    expect(global.title).toBe("Round-tripped");
  });

  it("updates the same row rather than inserting another", async () => {
    await payload.updateGlobal({ slug: "siteSettings", data: { title: "One" } });
    await payload.updateGlobal({ slug: "siteSettings", data: { title: "Two" } });
    await payload.updateGlobal({ slug: "siteSettings", data: { title: "Three" } });

    const { rows } = await sql.query<{ title: string }>("SELECT title FROM site_settings");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Three");
  });

  it("is readable straight from the database, with no CMS involved", async () => {
    await payload.updateGlobal({ slug: "siteSettings", data: { tagline: "Plain SQL" } });

    // The point of mapping a global: a script, a job or a server route can read
    // it without Payload ever loading.
    const { rows } = await sql.query<{ tagline: string }>(
      "SELECT tagline FROM site_settings ORDER BY id ASC LIMIT 1",
    );
    expect(rows[0]?.tagline).toBe("Plain SQL");
  });
});

describe("a global stored internally", () => {
  it("reads and writes without touching Postgres", async () => {
    const before = await sql.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");

    await payload.updateGlobal({
      slug: "editorialSettings",
      data: { lockMinutes: 42, showDraftBanner: false },
    });
    const global = await payload.findGlobal({ slug: "editorialSettings" });
    expect(global.lockMinutes).toBe(42);

    const after = await sql.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    expect(after.rowCount).toBe(before.rowCount);
    expect(after.rows.map((row) => (row as { tablename: string }).tablename).sort()).toEqual(
      SCHEMA_TABLES,
    );
  });
});

describe("the field mapping", () => {
  it("writes `body` to the `content` column", async () => {
    const author = await anAuthor("Mapping");
    const post = await aPost({ author: author.id, body: "into content" });

    const { rows } = await sql.query<{ content: string }>(
      "SELECT content FROM blog_posts WHERE id = $1",
      [post.id],
    );
    expect(rows[0]?.content).toBe("into content");
    expect(post.body).toBe("into content");
  });

  it("never writes a read-only column", async () => {
    const author = await anAuthor("ReadOnly");
    const post = await aPost({ author: author.id });
    await sql.query("UPDATE blog_posts SET views = 99 WHERE id = $1", [post.id]);

    await payload.update({
      collection: "posts",
      id: post.id,
      data: { title: "Renamed", views: 0 } as never,
    });

    const { rows } = await sql.query<{ views: number }>(
      "SELECT views FROM blog_posts WHERE id = $1",
      [post.id],
    );
    expect(rows[0]?.views).toBe(99);
  });

  it("leaves `@updatedAt` to Prisma", async () => {
    const author = await anAuthor("Timestamps");
    const post = await aPost({ author: author.id });
    const first = await sql.query<{ updatedAt: Date }>(
      'SELECT "updatedAt" FROM blog_posts WHERE id = $1',
      [post.id],
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    await payload.update({ collection: "posts", id: post.id, data: { title: "Touched" } });

    const second = await sql.query<{ updatedAt: Date }>(
      'SELECT "updatedAt" FROM blog_posts WHERE id = $1',
      [post.id],
    );
    expect(second.rows[0]!.updatedAt.getTime()).toBeGreaterThan(
      first.rows[0]!.updatedAt.getTime(),
    );
  });
});

describe("relationships", () => {
  it("writes two relations to the same model over their own foreign keys", async () => {
    const author = await anAuthor("Writer");
    const reviewer = await anAuthor("Reviewer");
    const post = await aPost({ author: author.id, reviewer: reviewer.id });

    const { rows } = await sql.query<{ authorId: string; reviewerId: string }>(
      'SELECT "authorId", "reviewerId" FROM blog_posts WHERE id = $1',
      [post.id],
    );
    expect(rows[0]?.authorId).toBe(author.id);
    expect(rows[0]?.reviewerId).toBe(reviewer.id);
  });

  it("connects a to-many on create", async () => {
    const author = await anAuthor("Tagger");
    const one = await payload.create({ collection: "tags", data: { label: `a-${Date.now()}` } });
    const two = await payload.create({ collection: "tags", data: { label: `b-${Date.now()}` } });

    const post = await aPost({ author: author.id, tags: [one.id, two.id] });

    const { rows } = await sql.query<{ B: number }>(
      'SELECT "B" FROM "_PostToTag" WHERE "A" = $1 ORDER BY "B"',
      [post.id],
    );
    expect(rows.map((row) => String(row.B))).toEqual([one.id, two.id].map(String).sort());
  });

  it("REPLACES a to-many on update, so removing actually removes", async () => {
    const author = await anAuthor("Setter");
    const one = await payload.create({ collection: "tags", data: { label: `c-${Date.now()}` } });
    const two = await payload.create({ collection: "tags", data: { label: `d-${Date.now()}` } });
    const post = await aPost({ author: author.id, tags: [one.id, two.id] });

    await payload.update({ collection: "posts", id: post.id, data: { tags: [two.id] } });

    const { rows } = await sql.query<{ B: number }>(
      'SELECT "B" FROM "_PostToTag" WHERE "A" = $1',
      [post.id],
    );
    // `connect` would have left both. `set` is the only spelling that lets an
    // admin panel remove a tag.
    expect(rows.map((row) => String(row.B))).toEqual([String(two.id)]);
  });

  it("disconnects a to-one set to null", async () => {
    const author = await anAuthor("Keeper");
    const reviewer = await anAuthor("Leaver");
    const post = await aPost({ author: author.id, reviewer: reviewer.id });

    await payload.update({ collection: "posts", id: post.id, data: { reviewer: null } });

    const { rows } = await sql.query<{ reviewerId: null | string }>(
      'SELECT "reviewerId" FROM blog_posts WHERE id = $1',
      [post.id],
    );
    expect(rows[0]?.reviewerId).toBeNull();
  });

  it("reads a non-owning to-many back through the other side", async () => {
    const author = await anAuthor("Prolific");
    await aPost({ author: author.id });
    await aPost({ author: author.id });

    const reread = await payload.findByID({ collection: "authors", depth: 0, id: author.id });
    expect(reread.posts).toHaveLength(2);
  });

  it("leaves referential integrity to your schema", async () => {
    const author = await anAuthor("Referenced");
    await aPost({ author: author.id });

    // `BlogPost.author` declares no `onDelete: Cascade`, so Postgres refuses.
    // The adapter does not cascade behind the schema's back.
    await expect(
      payload.delete({ collection: "authors", id: author.id }),
    ).rejects.toThrow();
  });
});

describe("plugins", () => {
  it("runs an official Payload plugin on a Prisma-backed collection", async () => {
    const author = await anAuthor("Seo");
    const post = await aPost({
      author: author.id,
      // `meta` is not in the collection config, `@payloadcms/plugin-seo` added
      // it. A group is one value, so it maps to the one `Json?` column
      // `BlogPost.meta`.
      meta: { description: "Described", title: "Optimised" },
    });

    const { rows } = await sql.query<{ meta: { description: string; title: string } }>(
      "SELECT meta FROM blog_posts WHERE id = $1",
      [post.id],
    );
    expect(rows[0]?.meta).toEqual({ description: "Described", title: "Optimised" });

    const reread = await payload.findByID({ collection: "posts", id: post.id });
    expect((reread as unknown as { meta: { title: string } }).meta.title).toBe("Optimised");
  });
});

describe("ids", () => {
  it("round-trips an `Int @default(autoincrement())` key as a string", async () => {
    const tag = await payload.create({ collection: "tags", data: { label: `int-${Date.now()}` } });
    expect(typeof tag.id).toBe("string");

    const found = await payload.findByID({ collection: "tags", id: tag.id });
    expect(found.id).toBe(tag.id);

    const { rows } = await sql.query<{ id: number }>("SELECT id FROM tags WHERE id = $1", [
      Number(tag.id),
    ]);
    expect(typeof rows[0]?.id).toBe("number");
  });
});

describe("queries", () => {
  it("filters through a relation", async () => {
    const author = await anAuthor("Findable");
    await aPost({ author: author.id, title: "Through a relation" });

    const found = await payload.find({
      collection: "posts",
      where: { "author.name": { equals: author.name } },
    });
    expect(found.totalDocs).toBe(1);
    expect(found.docs[0]?.title).toBe("Through a relation");
  });

  it("filters on a foreign key without joining", async () => {
    const author = await anAuthor("ByKey");
    await aPost({ author: author.id });

    const found = await payload.find({
      collection: "posts",
      where: { author: { equals: author.id } },
    });
    expect(found.totalDocs).toBe(1);
  });

  it("paginates deterministically even when the sort key ties", async () => {
    const author = await anAuthor("Paged");
    for (let index = 0; index < 5; index += 1) {
      await aPost({ author: author.id, featured: true, title: "Same title" });
    }

    const where = { author: { equals: author.id } };
    const first = await payload.find({ collection: "posts", limit: 2, page: 1, sort: "title", where });
    const second = await payload.find({ collection: "posts", limit: 2, page: 2, sort: "title", where });

    expect(first.totalDocs).toBe(5);
    expect(first.totalPages).toBe(3);
    // Every id is unique across pages: the primary key is appended to the sort,
    // so no row can fall on a page boundary twice.
    const ids = [...first.docs, ...second.docs].map((doc) => doc.id);
    expect(new Set(ids).size).toBe(4);
  });

  it("counts with the same filter it reads with", async () => {
    const author = await anAuthor("Counted");
    await aPost({ author: author.id });
    await aPost({ author: author.id });

    const count = await payload.count({
      collection: "posts",
      where: { author: { equals: author.id } },
    });
    expect(count.totalDocs).toBe(2);
  });

  it("rejects a filter it cannot express rather than dropping it", async () => {
    await expect(
      payload.find({ collection: "posts", where: { nonexistent: { equals: 1 } } }),
    ).rejects.toThrow(/nonexistent/);
  });
});
