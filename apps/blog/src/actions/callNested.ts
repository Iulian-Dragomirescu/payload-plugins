"use server";

import config from "@payload-config";
import { getPayload } from "payload";

/**
 * Creates one author.
 *
 * `email` is `@unique`, so it carries a stamp. A fixed one would work on the
 * first click and hit the constraint on every one after it.
 */
export async function callNested(): Promise<void> {
  const payload = await getPayload({ config });

  const author = await payload.create({
    collection: "authors",
    data: {
      name: "Ada Lovelace",
      email: `ada-${Date.now()}@example.com`,
      role: "editor",
    },
  });

  console.log("[call nested] created author", author.id, author.name);
}
