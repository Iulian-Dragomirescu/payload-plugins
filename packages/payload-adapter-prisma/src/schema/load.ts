import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { Datamodel, DatamodelSource } from "./datamodel.js";
import { isDatamodelThin, resolveDatamodel } from "./datamodel.js";
import { parsePrismaSchema } from "./parseSchema.js";

/**
 * Where the datamodel comes from.
 *
 * `schema.prisma` is the default and the primary source, not a fallback.
 * Prisma 7's generated client carries no `@id` markers and no
 * `relationFromFields`, so it cannot say which side of a relation owns the
 * foreign key, and therefore cannot say whether a write is a `connect`.
 */
export interface SchemaSource {
  /**
   * Path to `schema.prisma`, absolute or relative to `process.cwd()`.
   *
   * @defaultValue `"./prisma/schema.prisma"`
   */
  path?: string;
  /**
   * An already-parsed datamodel, or a Prisma 5/6 client to read one from.
   *
   * The escape hatch for a setup where the schema file is not on disk at
   * runtime, a bundled deployment say. A Prisma 5 or 6 client carries enough
   * metadata, a 7 client does not, and this throws rather than building a
   * mapping that would be confidently wrong.
   */
  datamodel?: Datamodel | DatamodelSource;
}

/** Raised when no usable datamodel could be loaded. */
export class PrismaAdapterSchemaError extends Error {
  constructor(message: string) {
    super(`[prisma-adapter] ${message}`);
    this.name = "PrismaAdapterSchemaError";
  }
}

/**
 * Loads the Prisma datamodel the mapping will be resolved against.
 *
 * @param props - Input props.
 * @param props.schema - Where to read the schema from.
 * @returns The parsed datamodel.
 * @throws {PrismaAdapterSchemaError} When the file is unreadable, or when the
 *   supplied `datamodel` is too thin to map against.
 */
export function loadDatamodel(props: { schema?: SchemaSource }): Datamodel {
  const schema = props.schema ?? {};

  if (schema.datamodel !== undefined) {
    const datamodel = resolveDatamodel(schema.datamodel);
    if (isDatamodelThin({ datamodel })) {
      throw new PrismaAdapterSchemaError(
        "The value passed as `schema.datamodel` exposes no primary keys and no relation\n" +
          "metadata. Prisma 7 removed both from the generated client, so a client is no\n" +
          "longer something a mapping can be built from.\n\n" +
          "Point the adapter at the schema file instead:\n\n" +
          "  prismaAdapter({\n" +
          "    prisma,\n" +
          '    schema: { path: "./prisma/schema.prisma" },\n' +
          "    internal: mongooseAdapter({ url: process.env.PAYLOAD_INTERNAL_URL }),\n" +
          "  })",
      );
    }
    return datamodel;
  }

  const relative = schema.path ?? "./prisma/schema.prisma";
  const path = isAbsolute(relative) ? relative : resolve(process.cwd(), relative);

  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    throw new PrismaAdapterSchemaError(
      `Could not read the Prisma schema at "${path}".\n` +
        "The adapter reads `schema.prisma` directly — it is the only place relation\n" +
        "ownership is recorded, and Prisma 7's generated client no longer carries it.\n\n" +
        'Set `schema: { path: "…" }` if your schema lives elsewhere.',
    );
  }

  const datamodel = parsePrismaSchema({ source });
  if (Object.keys(datamodel.models).length === 0) {
    throw new PrismaAdapterSchemaError(
      `The Prisma schema at "${path}" declares no models. Nothing can be mapped onto it.`,
    );
  }
  return datamodel;
}
