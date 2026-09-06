import config from "@payload-config";
import { getPayload } from "payload";
import Link from "next/link";

/**
 * The front end, reading through Payload's Local API.
 *
 * It never imports `prisma` and does not know that `posts` is stored in
 * Postgres while `siteSettings` is stored in Mongo. The adapter routes each
 * call.
 */
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const payload = await getPayload({ config });

  const [settings, posts] = await Promise.all([
    payload.findGlobal({ slug: "siteSettings" }),
    payload.find({
      collection: "posts",
      depth: 1,
      limit: 10,
      sort: "-publishedAt",
    }),
  ]);

  return (
    <main style={{ margin: "0 auto", maxWidth: 760, padding: "4rem 1.5rem" }}>
      <p style={{ color: "#7d8794", fontSize: 13, letterSpacing: ".08em", textTransform: "uppercase" }}>
        The adapter example
      </p>
      <h1 style={{ fontSize: 40, lineHeight: 1.1, margin: "0.4rem 0 0.6rem" }}>
        {settings.title ?? "Payload on Prisma"}
      </h1>
      <p style={{ color: "#9aa4b2", fontSize: 18, marginTop: 0 }}>
        {settings.tagline ?? "Payload CMS on an ordinary Prisma schema."}
      </p>

      <p style={{ marginTop: "2rem" }}>
        <Link
          href="/admin"
          style={{
            background: "#e7eaee",
            borderRadius: 6,
            color: "#0b0d10",
            display: "inline-block",
            fontWeight: 600,
            padding: ".6rem 1rem",
            textDecoration: "none",
          }}
        >
          Open the admin panel →
        </Link>
      </p>

      <h2 style={{ borderTop: "1px solid #1e242c", fontSize: 14, letterSpacing: ".08em", marginTop: "3rem", paddingTop: "2rem", textTransform: "uppercase" }}>
        Posts, from Postgres
      </h2>
      {posts.docs.length === 0 ? (
        <p style={{ color: "#7d8794" }}>
          Nothing yet. Run <code>pnpm seed</code>, or create one in the admin panel.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {posts.docs.map((post) => (
            <li key={post.id} style={{ borderBottom: "1px solid #1e242c", padding: "1rem 0" }}>
              <strong style={{ fontSize: 18 }}>{post.title}</strong>
              <div style={{ color: "#7d8794", fontSize: 14, marginTop: 4 }}>
                {typeof post.author === "object" && post.author !== null
                  ? post.author.name
                  : "Unknown author"}
                {post.tags !== undefined && post.tags !== null && post.tags.length > 0
                  ? ` · ${post.tags
                      .map((tag) => (typeof tag === "object" && tag !== null ? tag.label : tag))
                      .join(", ")}`
                  : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
