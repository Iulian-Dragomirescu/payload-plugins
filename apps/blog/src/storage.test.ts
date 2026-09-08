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
  "post_sections",
  "section_links",
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
    // Numerically on both sides: `tags.id` is an Int, so SQL orders 99 before
    // 100 while a string sort does the opposite.
    expect(rows.map((row) => Number(row.B))).toEqual(
      [one.id, two.id].map(Number).sort((left, right) => left - right),
    );
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

describe("join fields", () => {
  /** An organization with `count` members, named so their sort order is known. */
  async function anOrganization(label: string, count: number) {
    const suffix = `${label}-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const organization = await payload.create({
      collection: "organizations",
      data: { name: `Org ${suffix}` },
    });

    const members = [];
    for (let index = 0; index < count; index += 1) {
      const name = `${suffix}-member-${index}`;
      members.push(
        await payload.create({
          collection: "authors",
          data: { email: `${name}@example.com`, name, organization: organization.id },
        }),
      );
    }
    return { members, organization };
  }

  it("reads the children from the parent's side", async () => {
    const { members, organization } = await anOrganization("Read", 2);

    const reread = await payload.findByID({
      collection: "organizations",
      depth: 0,
      id: organization.id,
    });

    expect(reread.members?.docs).toEqual(members.map((member) => member.id));
  });

  it("reads only the children pointing at this parent", async () => {
    const { organization } = await anOrganization("Mine", 1);
    const other = await anOrganization("Theirs", 1);

    const reread = await payload.findByID({
      collection: "organizations",
      depth: 0,
      id: organization.id,
    });

    expect(reread.members?.docs).toHaveLength(1);
    expect(reread.members?.docs).not.toContain(other.members[0]?.id);
  });

  it("applies the field's `defaultSort`", async () => {
    const { members, organization } = await anOrganization("Sorted", 3);

    const reread = await payload.findByID({
      collection: "organizations",
      depth: 0,
      id: organization.id,
      joins: { members: { sort: "-name" } },
    });

    expect(reread.members?.docs).toEqual([...members].reverse().map((member) => member.id));
  });

  it("pages with the field's `defaultLimit` and reports another page", async () => {
    const { organization } = await anOrganization("Paged", 6);

    const first = await payload.findByID({
      collection: "organizations",
      depth: 0,
      id: organization.id,
    });
    expect(first.members?.docs).toHaveLength(5);
    expect(first.members?.hasNextPage).toBe(true);

    const second = await payload.findByID({
      collection: "organizations",
      depth: 0,
      id: organization.id,
      joins: { members: { page: 2 } },
    });
    expect(second.members?.docs).toHaveLength(1);
    expect(second.members?.hasNextPage).toBe(false);
  });

  it("filters and counts the children", async () => {
    const { members, organization } = await anOrganization("Filtered", 3);

    const reread = await payload.findByID({
      collection: "organizations",
      depth: 0,
      id: organization.id,
      joins: { members: { count: true, where: { name: { equals: members[0]?.name } } } },
    });

    expect(reread.members?.docs).toHaveLength(1);
    // The count is filtered too, or the total would not describe the page.
    expect(reread.members?.totalDocs).toBe(1);
  });

  it("gives each parent its own page on a list view", async () => {
    // The reason a join is a nested read rather than one flat query over every
    // parent: a flat query can only paginate the pile.
    const many = await anOrganization("ListMany", 6);
    const few = await anOrganization("ListFew", 1);

    const page = await payload.find({
      collection: "organizations",
      depth: 0,
      where: { id: { in: [many.organization.id, few.organization.id] } },
    });

    const byId = new Map(page.docs.map((doc) => [doc.id, doc]));
    expect(byId.get(many.organization.id)?.members?.docs).toHaveLength(5);
    expect(byId.get(few.organization.id)?.members?.docs).toHaveLength(1);
  });

  it("populates the joined documents at depth", async () => {
    const { members, organization } = await anOrganization("Populated", 1);

    const reread = await payload.findByID({
      collection: "organizations",
      depth: 1,
      id: organization.id,
    });

    // The adapter returns ids; Payload's own `afterRead` turns them into
    // documents, the same as for a relationship.
    expect(reread.members?.docs?.[0]).toMatchObject({ name: members[0]?.name });
  });
});

describe("an internal row pointing at a Prisma document", () => {
  it("locks a document without coercing its id", async () => {
    // The admin panel takes a lock the moment you touch the form of a saved
    // document, and the lock lives in the INTERNAL database. Its `document` is
    // a polymorphic relationship at a Prisma-backed collection, so a Mongo
    // internal adapter meets a cuid where it expects an ObjectId.
    const author = await anAuthor("Locking");
    const post = await aPost({ author: author.id });

    await expect(
      payload.db.create({
        collection: "payload-locked-documents",
        data: { document: { relationTo: "posts", value: post.id } },
        req: undefined as never,
      }),
    ).resolves.toBeTruthy();
  });
});

describe("array fields", () => {
  /** The rows in `post_sections` for one post, in the order the column says. */
  async function sectionsOf(postId: string) {
    const { rows } = await sql.query<{ id: string; heading: string; order: number }>(
      'SELECT id, heading, "order" FROM post_sections WHERE "postId" = $1 ORDER BY "order"',
      [postId],
    );
    return rows;
  }

  /** A post carrying the given sections. */
  async function aPostWithSections(headings: string[]) {
    const author = await anAuthor("Sections");
    return aPost({
      author: author.id,
      sections: headings.map((heading) => ({ heading })),
    });
  }

  it("writes the rows into the child table, not into a Json column", async () => {
    const post = await aPostWithSections(["Intro", "Body"]);

    expect(await sectionsOf(post.id)).toMatchObject([
      { heading: "Intro", order: 0 },
      { heading: "Body", order: 1 },
    ]);
  });

  it("reads the rows back in the column's order", async () => {
    const post = await aPostWithSections(["Intro", "Body", "Outro"]);

    const reread = await payload.findByID({ collection: "posts", id: post.id });

    expect(reread.sections?.map((section) => section.heading)).toEqual([
      "Intro",
      "Body",
      "Outro",
    ]);
  });

  it("edits a row in place, keeping its id", async () => {
    // The point of the whole thing. Delete-and-recreate would give the row a
    // new id on every save, and anything pointing at it would be broken.
    const post = await aPostWithSections(["Intro", "Body"]);
    const before = await sectionsOf(post.id);

    await payload.update({
      collection: "posts",
      id: post.id,
      data: {
        sections: [
          { id: before[0]?.id, heading: "Introduction" },
          { id: before[1]?.id, heading: "Body" },
        ],
      },
    });

    const after = await sectionsOf(post.id);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after[0]?.heading).toBe("Introduction");
  });

  it("deletes exactly the row the editor removed", async () => {
    const post = await aPostWithSections(["Intro", "Body", "Outro"]);
    const before = await sectionsOf(post.id);

    await payload.update({
      collection: "posts",
      id: post.id,
      data: {
        sections: [
          { id: before[0]?.id, heading: "Intro" },
          { id: before[2]?.id, heading: "Outro" },
        ],
      },
    });

    // `post_sections.postId` is NOT NULL, so this can only have been a delete.
    // A `relationship` would have tried to write NULL and the database would
    // have refused, which is why that combination is a startup error.
    const after = await sectionsOf(post.id);
    expect(after.map((row) => row.id)).toEqual([before[0]?.id, before[2]?.id]);
  });

  it("adds a row without touching the ones already there", async () => {
    const post = await aPostWithSections(["Intro"]);
    const before = await sectionsOf(post.id);

    await payload.update({
      collection: "posts",
      id: post.id,
      data: {
        sections: [{ id: before[0]?.id, heading: "Intro" }, { heading: "Body" }],
      },
    });

    const after = await sectionsOf(post.id);
    expect(after).toHaveLength(2);
    expect(after[0]?.id).toBe(before[0]?.id);
    // Payload fills a new row's `id` in before the adapter sees it, with a
    // client-side ObjectId that matches nothing. The row has to come back with
    // the cuid the database generated instead.
    expect(after[1]?.id).not.toMatch(/^[0-9a-f]{24}$/);
  });

  it("follows the array's order when the editor reorders rows", async () => {
    const post = await aPostWithSections(["Intro", "Body"]);
    const before = await sectionsOf(post.id);

    await payload.update({
      collection: "posts",
      id: post.id,
      data: {
        sections: [
          { id: before[1]?.id, heading: "Body" },
          { id: before[0]?.id, heading: "Intro" },
        ],
      },
    });

    expect(await sectionsOf(post.id)).toMatchObject([
      { id: before[1]?.id, order: 0 },
      { id: before[0]?.id, order: 1 },
    ]);
  });

  it("deletes every row when the array is emptied", async () => {
    const post = await aPostWithSections(["Intro", "Body"]);

    await payload.update({ collection: "posts", id: post.id, data: { sections: [] } });

    expect(await sectionsOf(post.id)).toHaveLength(0);
  });

  it("leaves the rows alone on an update that does not mention them", async () => {
    const post = await aPostWithSections(["Intro"]);

    await payload.update({ collection: "posts", id: post.id, data: { title: "Renamed" } });

    expect(await sectionsOf(post.id)).toHaveLength(1);
  });

  it("cascades the rows away with the post", async () => {
    const post = await aPostWithSections(["Intro", "Body"]);

    await payload.delete({ collection: "posts", id: post.id });

    // `onDelete: Cascade` in schema.prisma, not the adapter. Referential
    // integrity stays the schema's.
    expect(await sectionsOf(post.id)).toHaveLength(0);
  });
});

describe("an array inside an array", () => {
  /** The rows in `post_sections` for one post. */
  async function sectionsOf(postId: string) {
    const { rows } = await sql.query<{ id: string; heading: string }>(
      'SELECT id, heading FROM post_sections WHERE "postId" = $1 ORDER BY "order"',
      [postId],
    );
    return rows;
  }

  /** The rows in `section_links` for one section. */
  async function linksOf(sectionId: string) {
    const { rows } = await sql.query<{ id: string; label: string; order: number }>(
      'SELECT id, label, "order" FROM section_links WHERE "sectionId" = $1 ORDER BY "order"',
      [sectionId],
    );
    return rows;
  }

  /** A post with two sections, the first carrying two links. */
  async function aPostWithLinks() {
    const author = await anAuthor("Links");
    return aPost({
      author: author.id,
      sections: [
        {
          heading: "Intro",
          links: [
            { label: "Docs", url: "https://example.com/docs" },
            { label: "Repo", url: "https://example.com/repo" },
          ],
        },
        { heading: "Body", links: [{ label: "Spec", url: "https://example.com/spec" }] },
      ],
    });
  }

  it("writes both levels on one create", async () => {
    const post = await aPostWithLinks();
    const sections = await sectionsOf(post.id);

    expect(sections).toHaveLength(2);
    expect((await linksOf(sections[0]?.id ?? "")).map((link) => link.label)).toEqual([
      "Docs",
      "Repo",
    ]);
    expect((await linksOf(sections[1]?.id ?? "")).map((link) => link.label)).toEqual(["Spec"]);
  });

  it("reads the whole tree back on the post's own query", async () => {
    const post = await aPostWithLinks();

    const reread = await payload.findByID({ collection: "posts", id: post.id });

    expect(reread.sections?.[0]?.links?.map((link) => link.label)).toEqual(["Docs", "Repo"]);
    expect(reread.sections?.[1]?.links?.map((link) => link.label)).toEqual(["Spec"]);
  });

  it("edits a grandchild in place, keeping every id", async () => {
    const post = await aPostWithLinks();
    const before = await sectionsOf(post.id);
    const links = await linksOf(before[0]?.id ?? "");

    const reread = await payload.findByID({ collection: "posts", id: post.id });
    await payload.update({
      collection: "posts",
      id: post.id,
      data: {
        sections: (reread.sections ?? []).map((section, index) =>
          index === 0
            ? {
                ...section,
                links: (section.links ?? []).map((link, inner) =>
                  inner === 0 ? { ...link, label: "Documentation" } : link,
                ),
              }
            : section,
        ),
      },
    });

    const after = await linksOf(before[0]?.id ?? "");
    expect(after.map((link) => link.id)).toEqual(links.map((link) => link.id));
    expect(after[0]?.label).toBe("Documentation");
  });

  it("scopes an id to the section it is inside", async () => {
    // The reason `existing` is a tree rather than a flat set. `Docs` belongs to
    // the first section; sending its id under the SECOND has to read as a new
    // link there, not as an edit Prisma would refuse.
    const post = await aPostWithLinks();
    const sections = await sectionsOf(post.id);
    const docs = (await linksOf(sections[0]?.id ?? ""))[0];

    const reread = await payload.findByID({ collection: "posts", id: post.id });
    await payload.update({
      collection: "posts",
      id: post.id,
      data: {
        sections: (reread.sections ?? []).map((section, index) =>
          index === 1
            ? { ...section, links: [{ id: docs?.id, label: "Docs", url: "https://x.test" }] }
            : section,
        ),
      },
    });

    // The original is still the first section's, and the second section got a
    // brand new row rather than stealing it.
    expect((await linksOf(sections[0]?.id ?? "")).map((link) => link.id)).toContain(docs?.id);
    const moved = await linksOf(sections[1]?.id ?? "");
    expect(moved).toHaveLength(1);
    expect(moved[0]?.id).not.toBe(docs?.id);
  });

  it("creates the grandchildren of a brand new section", async () => {
    const post = await aPostWithLinks();

    const reread = await payload.findByID({ collection: "posts", id: post.id });
    await payload.update({
      collection: "posts",
      id: post.id,
      data: {
        sections: [
          ...(reread.sections ?? []),
          { heading: "Outro", links: [{ label: "Next", url: "https://example.com/next" }] },
        ],
      },
    });

    const sections = await sectionsOf(post.id);
    expect(sections).toHaveLength(3);
    expect((await linksOf(sections[2]?.id ?? "")).map((link) => link.label)).toEqual(["Next"]);
  });

  it("takes the grandchildren with a removed section", async () => {
    const post = await aPostWithLinks();
    const sections = await sectionsOf(post.id);

    const reread = await payload.findByID({ collection: "posts", id: post.id });
    await payload.update({
      collection: "posts",
      id: post.id,
      data: { sections: (reread.sections ?? []).slice(1) },
    });

    expect(await sectionsOf(post.id)).toHaveLength(1);
    // `SectionLink.section` is `onDelete: Cascade`, so the links went with it.
    expect(await linksOf(sections[0]?.id ?? "")).toHaveLength(0);
  });

  it("reorders the grandchildren from the array's order", async () => {
    const post = await aPostWithLinks();
    const sections = await sectionsOf(post.id);
    const before = await linksOf(sections[0]?.id ?? "");

    const reread = await payload.findByID({ collection: "posts", id: post.id });
    await payload.update({
      collection: "posts",
      id: post.id,
      data: {
        sections: (reread.sections ?? []).map((section, index) =>
          index === 0 ? { ...section, links: [...(section.links ?? [])].reverse() } : section,
        ),
      },
    });

    const after = await linksOf(sections[0]?.id ?? "");
    expect(after.map((link) => link.id)).toEqual([before[1]?.id, before[0]?.id]);
    expect(after.map((link) => link.order)).toEqual([0, 1]);
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
