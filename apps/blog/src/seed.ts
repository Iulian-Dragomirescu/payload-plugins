import "dotenv/config";

import { getPayload } from "payload";

import { describeStorage } from "payload-adapter-prisma";

import config from "./payload.config";

/**
 * Fills both databases with enough to click around, and narrates what lands
 * where on the way through.
 *
 * Every write goes through Payload's Local API with no mention of Prisma. The
 * adapter decides which database each call reaches.
 *
 * ```bash
 * pnpm seed
 * ```
 */
async function seed(): Promise<void> {
  const payload = await getPayload({ config });

  const storage = describeStorage({ payload });
  console.log("\n── Where each collection lives ──────────────────────────────");
  console.log("  Postgres, via Prisma :", storage.prisma.join(", "));
  console.log("  Internal (MongoDB)   :", storage.internal.join(", "));

  console.log("\n── An admin to log in with ──────────────────────────────────");
  const email = "admin@example.com";
  const password = "payload";
  const existing = await payload.find({
    collection: "admins",
    where: { email: { equals: email } },
    limit: 1,
  });
  if (existing.docs.length === 0) {
    await payload.create({
      collection: "admins",
      data: { email, name: "Example Admin", password, role: "admin" },
    });
    console.log(`  created ${email} / ${password}`);
  } else {
    console.log(`  ${email} already exists`);
  }
  console.log("  → stored in MongoDB. Your Postgres has no password hash in it.");

  console.log("\n── Organizations, authors, tags ─────────────────────────────");
  const org = await payload.create({
    collection: "organizations",
    data: { name: "Example Press" },
  });

  const ana = await payload.create({
    collection: "authors",
    data: {
      email: `ana+${Date.now()}@example.com`,
      name: "Ana",
      organization: org.id,
      role: "writer",
    },
  });
  const bogdan = await payload.create({
    collection: "authors",
    data: {
      email: `bogdan+${Date.now()}@example.com`,
      name: "Bogdan",
      organization: org.id,
      role: "editor",
    },
  });
  console.log(`  authors: ${ana.name} (${ana.id}), ${bogdan.name} (${bogdan.id})`);
  console.log("  → `organization` wrote a `connect` over the `organizationId` column.");

  const labels = ["news", "release", "deep-dive"];
  const tags = [];
  for (const label of labels) {
    const found = await payload.find({
      collection: "tags",
      where: { label: { equals: label } },
      limit: 1,
    });
    tags.push(found.docs[0] ?? (await payload.create({ collection: "tags", data: { label } })));
  }
  console.log(`  tags: ${tags.map((tag) => `${tag.label} (id ${tag.id})`).join(", ")}`);
  console.log("  → `Tag.id` is an `Int @default(autoincrement())`, read back as a string.");

  console.log("\n── A post, with three relations at once ─────────────────────");
  const post = await payload.create({
    collection: "posts",
    data: {
      author: ana.id,
      body: "Payload's admin panel, reading and writing an ordinary Prisma schema.",
      featured: true,
      publishedAt: new Date().toISOString(),
      reviewer: bogdan.id,
      slug: `hello-prisma-${Date.now()}`,
      tags: [tags[0]!.id, tags[1]!.id],
      title: "Hello Payload",
    },
  });
  console.log(`  created "${post.title}" (${post.id})`);
  console.log("  → author + reviewer are two relations to the SAME model, told apart");
  console.log("    by `authorId` and `reviewerId`; tags wrote a `connect` list.");

  console.log("\n── Updating a to-many replaces it ───────────────────────────");
  await payload.update({
    collection: "posts",
    id: post.id,
    data: { tags: [tags[2]!.id] },
  });
  const reread = await payload.findByID({ collection: "posts", depth: 0, id: post.id });
  console.log(`  tags after update: ${JSON.stringify(reread.tags)}`);
  console.log("  → `set`, not `connect`. Removing a tag in the panel actually removes it.");

  console.log("\n── An official Payload plugin, on a mapped collection ───────");
  await payload.update({
    collection: "posts",
    id: post.id,
    data: { meta: { description: "Payload CMS on your own Prisma schema.", title: "Hello" } },
  } as never);
  console.log("  `@payloadcms/plugin-seo` added a `meta` group to posts.");
  console.log("  → a group is one value, so it maps to one column: `BlogPost.meta Json?`,");
  console.log("    which schema.prisma declares and `prisma db push` created. Not us.");

  console.log("\n── Globals, one in each database ────────────────────────────");
  await payload.updateGlobal({
    slug: "siteSettings",
    data: { postsPerPage: 5, tagline: "Payload CMS on your own Prisma schema.", title: "Payload on Prisma" },
  });
  console.log("  siteSettings      → Postgres, as one row of `site_settings`.");
  console.log("    The table was empty; the save created the row. No seeding needed.");
  console.log("    `prisma.siteSetting.findFirst()` reads it with no CMS involved.");

  await payload.updateGlobal({
    slug: "editorialSettings",
    data: { lockMinutes: 15, showDraftBanner: true },
  });
  console.log("  editorialSettings → MongoDB. `pg_tables` did not change.");
  console.log("    Same API, different home. The only difference is one line of config.");

  console.log("\n── Done ────────────────────────────────────────────────────");
  console.log("  http://localhost:3000/admin");
  console.log(`  ${email} / ${password}\n`);

  process.exit(0);
}

seed().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
