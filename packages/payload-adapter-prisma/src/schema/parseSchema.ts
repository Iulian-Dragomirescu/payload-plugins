import type { Datamodel, DatamodelField, DatamodelModel } from "./datamodel";

/**
 * Parses `schema.prisma` into a {@link Datamodel}.
 *
 * The primary source, not a fallback. Prisma 7 removed relation metadata from
 * the generated client, so the schema text is the only place recording which
 * side of a relation owns the foreign key, and that decides whether a write is
 * a `connect` or a scalar assignment.
 *
 * A hand-written parser rather than `@prisma/internals`: model blocks and field
 * lines are the whole subset that matters, and the dependency would add tens of
 * megabytes and a version coupling. It does not handle `type` blocks (MongoDB
 * embedded documents) or `view` blocks, which the adapter does not map onto.
 */

/** Strips comments and trims, returning `""` for a line with nothing left. */
function meaningful(line: string): string {
  // A `//` inside a string literal would be mangled, but a Prisma field line
  // has none outside an attribute argument.
  const withoutComment = line.replace(/\/\/.*$/, "");
  return withoutComment.trim();
}

/**
 * Reads the value of a `@map("…")` or `@@map("…")` attribute.
 *
 * @param source - The line or block to search.
 * @param doubled - Whether to look for `@@map` rather than `@map`.
 * @returns The mapped name, or `undefined`.
 */
function readMap(source: string, doubled: boolean): string | undefined {
  const pattern = doubled ? /@@map\(\s*"([^"]+)"\s*\)/ : /(?<!@)@map\(\s*"([^"]+)"\s*\)/;
  return pattern.exec(source)?.[1];
}

/**
 * Reads a `@relation(...)` attribute's `fields:` and `references:` lists.
 *
 * These decide which side of a relation owns the foreign key, which decides how
 * a write to it is spelled.
 *
 * @param line - The field line.
 * @returns The relation name and its field lists, or `undefined` when the line
 *   carries no `@relation`.
 */
function readRelation(line: string): {
  name?: string;
  fields: string[];
  references: string[];
} | undefined {
  const attribute = /@relation\(([^)]*)\)/.exec(line);
  if (attribute === null) return undefined;
  const body = attribute[1] ?? "";

  /** Reads a `key: [a, b]` list out of the attribute body. */
  const list = (key: string): string[] => {
    const match = new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`).exec(body);
    if (match?.[1] === undefined) return [];
    return match[1]
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  };

  // The name is either `name: "X"` or a bare leading `"X"`.
  const named = /name\s*:\s*"([^"]+)"/.exec(body)?.[1];
  const positional = /^\s*"([^"]+)"/.exec(body)?.[1];

  return {
    ...(named ?? positional !== undefined ? { name: named ?? positional } : {}),
    fields: list("fields"),
    references: list("references"),
  };
}

/**
 * Parses one field line inside a model block.
 *
 * @param line - The line, already stripped of comments.
 * @param enums - Enum names declared in the schema, so an enum field is not
 *   mistaken for a relation.
 * @returns The field, or `undefined` when the line is not a field declaration.
 */
function parseField(line: string, enums: Set<string>): DatamodelField | undefined {
  // `name Type[]? @attrs`, the name and the type being the first two tokens.
  const match = /^(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/.exec(line);
  if (match === null) return undefined;

  const [, name, type, list, optional, rest = ""] = match;
  if (name === undefined || type === undefined) return undefined;

  const SCALARS = new Set([
    "String",
    "Boolean",
    "Int",
    "BigInt",
    "Float",
    "Decimal",
    "DateTime",
    "Json",
    "Bytes",
  ]);
  const isEnum = enums.has(type);
  // Neither a known scalar nor a declared enum means another model, so the
  // field is a relation.
  const kind = SCALARS.has(type) ? "scalar" : isEnum ? "enum" : "object";

  const relation = kind === "object" ? readRelation(rest) : undefined;
  const dbName = readMap(rest, false);
  const hasDefault = /@default\(/.test(rest);

  return {
    name,
    kind,
    type,
    isList: list === "[]",
    isRequired: optional !== "?",
    isId: /@id\b/.test(rest),
    isUnique: /@unique\b/.test(rest),
    hasDefaultValue: hasDefault,
    isUpdatedAt: /@updatedAt\b/.test(rest),
    isGenerated: /@default\(\s*autoincrement\(\)\s*\)/.test(rest),
    ...(dbName !== undefined ? { dbName } : {}),
    ...(relation?.name !== undefined ? { relationName: relation.name } : {}),
    ...(kind === "object"
      ? {
          relationFromFields: relation?.fields ?? [],
          relationToFields: relation?.references ?? [],
        }
      : {}),
  };
}

/**
 * Parses a `schema.prisma` file.
 *
 * @param props - Input props.
 * @param props.source - The file's contents.
 * @returns The datamodel.
 *
 * @example
 * ```ts
 * const datamodel = parsePrismaSchema({ source: readFileSync("schema.prisma", "utf8") });
 * datamodel.models.BlogPost.fields.find((f) => f.name === "author");
 * // → { kind: "object", type: "Author", relationFromFields: ["authorId"], … }
 * ```
 */
export function parsePrismaSchema(props: { source: string }): Datamodel {
  const lines = props.source.split("\n");

  // Enums first: a field's type cannot be classified without knowing whether
  // it names an enum or a model.
  const enums = new Set<string>();
  for (const line of lines) {
    const match = /^\s*enum\s+(\w+)\s*\{/.exec(line);
    if (match?.[1] !== undefined) enums.add(match[1]);
  }

  const models: Record<string, DatamodelModel> = {};
  let current: { name: string; fields: DatamodelField[]; block: string[] } | undefined;

  for (const raw of lines) {
    const line = meaningful(raw);

    if (current === undefined) {
      const opening = /^model\s+(\w+)\s*\{/.exec(line);
      if (opening?.[1] !== undefined) {
        current = { name: opening[1], fields: [], block: [] };
      }
      continue;
    }

    if (line === "}") {
      const block = current.block.join("\n");
      const dbName = readMap(block, true);
      const composite = /@@id\(\s*\[([^\]]*)\]/.exec(block)?.[1];
      const compositePrimaryKey = composite
        ?.split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

      models[current.name] = {
        name: current.name,
        fields: current.fields,
        ...(dbName !== undefined ? { dbName } : {}),
        ...(compositePrimaryKey !== undefined && compositePrimaryKey.length > 0
          ? { compositePrimaryKey }
          : {}),
      };
      current = undefined;
      continue;
    }

    current.block.push(line);
    // Block-level attributes are collected above but are not fields.
    if (line.startsWith("@@") || line === "") continue;

    const field = parseField(line, enums);
    if (field !== undefined) current.fields.push(field);
  }

  return { models };
}
