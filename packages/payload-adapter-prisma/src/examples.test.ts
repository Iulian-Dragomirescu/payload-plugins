import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SanitizedCollectionConfig, SanitizedGlobalConfig } from "payload";
import { describe, expect, it } from "vitest";

import { buildMappings } from "./mapping/build.js";
import { parsePrismaSchema } from "./schema/parseSchema.js";

/**
 * Every example resolves against its own `schema.prisma`.
 *
 * The examples are what people copy from, and nothing else compiles or runs
 * them. A field renamed in one file and not the other would be a page of
 * instructions that raises at startup.
 */

const EXAMPLES = fileURLToPath(new URL("../examples", import.meta.url));

/**
 * Which exports are globals.
 *
 * A `GlobalConfig` and a `CollectionConfig` are the same shape at runtime, and
 * only the `buildConfig` call that uses one says which it is. So this has to
 * say too.
 */
const GLOBALS = new Set(["EditorialSettings", "SeoDefaults", "SiteSettings", "SocialLinks"]);

/** Every example directory, and what shape its `config.ts` is. */
const examples = readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const directory = join(EXAMPLES, entry.name);
    return {
      name: entry.name,
      directory,
      // An example that calls `buildConfig` is a whole application rather than a
      // set of mappings. Importing it would RUN it, against an adapter and a
      // client neither of which exists here.
      whole: readFileSync(join(directory, "config.ts"), "utf8").includes("buildConfig("),
    };
  });

describe("examples", () => {
  it("accounts for every directory", () => {
    // A rename that quietly emptied the list would make every case below pass.
    expect(examples.map((example) => example.name)).toEqual(
      expect.arrayContaining(["globals", "joins", "minimal", "relationships"]),
    );
  });

  it.each(examples.filter((example) => !example.whole))(
    "$name resolves against its schema",
    async ({ directory }) => {
      const datamodel = parsePrismaSchema({
        source: readFileSync(join(directory, "schema.prisma"), "utf8"),
      });

      const module_ = (await import(join(directory, "config.ts"))) as Record<string, unknown>;

      const collections: SanitizedCollectionConfig[] = [];
      const globals: SanitizedGlobalConfig[] = [];
      for (const [exported, config] of Object.entries(module_)) {
        // The examples list fields flat, so Payload's flattening is the
        // identity and the mapper can read them as they are written.
        const sanitized = {
          ...(config as object),
          flattenedFields: (config as { fields: unknown[] }).fields,
        };
        (GLOBALS.has(exported) ? globals : collections).push(sanitized as never);
      }

      expect(collections.length + globals.length).toBeGreaterThan(0);
      expect(() => buildMappings({ collections, datamodel, globals })).not.toThrow();
    },
  );
});
