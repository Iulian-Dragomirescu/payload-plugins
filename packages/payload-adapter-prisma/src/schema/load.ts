import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

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
   * Where the schema is, absolute or relative to `process.cwd()`.
   *
   * A file, a directory, or a list of either. A directory is read recursively
   * for `.prisma` files and concatenated, which is the `prismaSchemaFolder`
   * layout Prisma 7 gives new projects.
   *
   * @defaultValue `"./prisma/schema.prisma"`, then `"./prisma/schema"`
   */
  path?: string | string[];
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
 * Where the adapter looks when `schema.path` is not set.
 *
 * The single file first, because a project that has one means it. The folder
 * second, because `prismaSchemaFolder` is the default for projects generated
 * by Prisma 7 and the schema then lives in `prisma/schema/`.
 */
const DEFAULT_PATHS = ["./prisma/schema.prisma", "./prisma/schema"];

/** Whether a path exists, and whether it is a directory. */
function inspect(path: string): "directory" | "file" | "missing" {
  try {
    return statSync(path).isDirectory() ? "directory" : "file";
  } catch {
    return "missing";
  }
}

/**
 * Lists every `.prisma` file under a directory, recursively.
 *
 * Sorted by name at each level so the concatenation is the same on every
 * machine. Order does not change what the parser produces, but a stable one
 * makes an error message reproducible.
 *
 * @param directory - The directory to walk.
 * @returns Absolute paths, deepest-last within each level.
 */
function collectPrismaFiles(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  const files: string[] = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectPrismaFiles(full));
    } else if (entry.name.endsWith(".prisma")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Resolves `schema.path` into the list of files to read.
 *
 * @param props - Input props.
 * @param props.path - What the config asked for, or `undefined` for the defaults.
 * @returns The absolute file paths, in read order.
 * @throws {PrismaAdapterSchemaError} When nothing readable is there.
 */
function resolveSchemaFiles(props: { path: string | string[] | undefined }): string[] {
  const declared = props.path;
  const absolute = (entry: string): string =>
    isAbsolute(entry) ? entry : resolve(process.cwd(), entry);

  if (declared === undefined) {
    for (const candidate of DEFAULT_PATHS) {
      const path = absolute(candidate);
      const kind = inspect(path);
      if (kind === "file") return [path];
      if (kind === "directory") {
        const files = collectPrismaFiles(path);
        if (files.length > 0) return files;
      }
    }
    throw new PrismaAdapterSchemaError(
      `Could not find a Prisma schema. Looked for ` +
        `${DEFAULT_PATHS.map((entry) => `"${absolute(entry)}"`).join(" and ")}.\n` +
        "The adapter reads the schema directly — it is the only place relation ownership\n" +
        "is recorded, and Prisma 7's generated client no longer carries it.\n\n" +
        'Set `schema: { path: "…" }` to the file or the folder your schema lives in.',
    );
  }

  const declaredList = Array.isArray(declared) ? declared : [declared];
  const files: string[] = [];

  for (const entry of declaredList) {
    const path = absolute(entry);
    const kind = inspect(path);

    if (kind === "missing") {
      throw new PrismaAdapterSchemaError(
        `Could not read the Prisma schema at "${path}".\n` +
          "The adapter reads the schema directly — it is the only place relation ownership\n" +
          "is recorded, and Prisma 7's generated client no longer carries it.\n\n" +
          '`schema.path` takes a file, a folder of `.prisma` files, or a list of either.',
      );
    }

    if (kind === "file") {
      files.push(path);
      continue;
    }

    const found = collectPrismaFiles(path);
    if (found.length === 0) {
      throw new PrismaAdapterSchemaError(
        `The folder "${path}" holds no \`.prisma\` files.\n` +
          "A folder is read recursively for them, which is the `prismaSchemaFolder` layout.\n" +
          "Point `schema.path` at the folder your models are in, or at the file itself.",
      );
    }
    files.push(...found);
  }

  return files;
}

/**
 * Loads the Prisma datamodel the mapping will be resolved against.
 *
 * @param props - Input props.
 * @param props.schema - Where to read the schema from.
 * @returns The parsed datamodel.
 * @throws {PrismaAdapterSchemaError} When the schema is unreadable, declares no
 *   models, or when the supplied `datamodel` is too thin to map against.
 *
 * @example
 * ```ts
 * loadDatamodel({ schema: { path: "./prisma/schema" } }); // a `prismaSchemaFolder`
 * ```
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

  const files = resolveSchemaFiles({ path: schema.path });

  // Concatenated before parsing rather than parsed and merged: a `prismaSchemaFolder`
  // splits one schema across files, and an enum declared in one of them types a
  // field in another, which the parser can only see in a single pass.
  const source = files
    .map((file) => {
      try {
        return readFileSync(file, "utf8");
      } catch {
        throw new PrismaAdapterSchemaError(`Could not read the Prisma schema file "${file}".`);
      }
    })
    .join("\n");

  const datamodel = parsePrismaSchema({ source });
  if (Object.keys(datamodel.models).length === 0) {
    throw new PrismaAdapterSchemaError(
      `${files.length === 1 ? `The Prisma schema at "${files[0]}"` : `The ${files.length} Prisma schema files under "${schema.path ?? DEFAULT_PATHS[1]}"`} ` +
        "declares no models. Nothing can be mapped onto it.",
    );
  }
  return datamodel;
}
