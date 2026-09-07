import type { ModelMapping } from "../mapping/types.js";

/** A row as the Prisma client returned it. */
export type PrismaRow = Record<string, unknown>;

/**
 * Payload field types whose value is a structure rather than a scalar.
 *
 * They live in a `Json` column, and Payload treats an absent structure and a
 * `null` one differently. Only the first is a shape it can handle.
 */
const STRUCTURED = new Set(["array", "blocks", "group", "richText", "tab"]);

/**
 * Turns a value Prisma returned into one Payload and JSON can both carry.
 *
 * Three Prisma types have no JSON representation:
 *
 * - `Date` becomes an ISO string. A live `Date` survives a read but not the
 *   deep copy Payload takes before an update, and the field then fails
 *   validation on a request that never touched it.
 * - `BigInt` becomes a string, because `JSON.stringify` throws on it.
 * - `Decimal` becomes a number, which is what Payload's `number` field expects.
 *   A column where the last digits matter should be read through Prisma.
 */
function toPayloadValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toPayloadValue);
  // Prisma's Decimal, duck-typed rather than imported: the client is a peer
  // dependency, and importing it would pin this package to a Prisma version.
  const decimal = value as { toNumber?: unknown; d?: unknown; s?: unknown };
  if (typeof decimal.toNumber === "function" && decimal.d !== undefined && decimal.s !== undefined) {
    return (decimal.toNumber as () => number)();
  }
  return value;
}

/**
 * Renders an id as Payload holds it.
 *
 * Ids are strings above this adapter whatever the column's type, because it
 * declares `defaultIDType: "text"`. The reverse conversion happens at the
 * database boundary, in {@link ../schema/coerce!coercePrimaryKey}.
 */
function toId(value: unknown): null | string {
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * Reads the id out of a related row, whatever shape it arrived in.
 *
 * Prisma returns related rows as objects, a foreign-key column returns the id
 * directly. Both reach Payload as a bare id, and Payload populates the full
 * document itself in its `afterRead` hooks.
 */
function relatedId(value: unknown, idKey: string): null | string {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    return toId((value as Record<string, unknown>)[idKey]);
  }
  return toId(value);
}

/**
 * A join field's value, as Payload reads it.
 *
 * Ids rather than documents, the same as a relationship: Payload populates them
 * through its own data loader in `afterRead`.
 */
export interface JoinPage {
  docs: (null | string)[];
  hasNextPage: boolean;
  totalDocs?: number;
}

/**
 * Builds the envelope Payload reads a join field as.
 *
 * @param props - Input props.
 * @param props.rows - The included child rows: one page, plus the extra row the
 *   query asked for so `hasNextPage` needs no second round trip.
 * @param props.idKey - The child's primary-key column.
 * @param props.limit - Rows per page. `0` is Payload's spelling of "all of them".
 * @param props.total - The counted total, absent unless the request asked to count.
 * @returns The join value.
 */
export function toJoinPage(props: {
  rows: unknown;
  idKey: string;
  limit: number;
  total?: unknown;
}): JoinPage {
  const { rows, idKey, limit, total } = props;
  const all = Array.isArray(rows) ? rows : [];
  const page = limit > 0 ? all.slice(0, limit) : all;

  return {
    docs: page.map((entry) => relatedId(entry, idKey)),
    hasNextPage: limit > 0 && all.length > limit,
    ...(typeof total === "number" ? { totalDocs: total } : {}),
  };
}

/**
 * Translates a Prisma row into a Payload document.
 *
 * Columns become field names, the primary key becomes `id`, and relations
 * become ids. A column with no field in the config is **dropped**, so a
 * `passwordHash` cannot reach an admin list just by being selected.
 *
 * @param props - Input props.
 * @param props.row - The row Prisma returned.
 * @param props.mapping - The collection's mapping.
 * @returns The Payload document.
 *
 * @example
 * ```ts
 * toPayloadDoc({ row: { id: 1, content: "hi", authorId: 7, tags: [{ id: 2 }] }, mapping });
 * // → { id: "1", body: "hi", author: "7", tags: ["2"] }
 * ```
 */
export function toPayloadDoc(props: {
  row: PrismaRow;
  mapping: ModelMapping;
}): Record<string, unknown> {
  const { row, mapping } = props;
  const doc: Record<string, unknown> = {};

  for (const [path, field] of mapping.fields) {
    if (field.kind === "scalar") {
      if (!(field.prismaField in row)) continue;
      const value = row[field.prismaField];

      // Payload fills an absent `group` with `{}` and crashes on a literal
      // `null`, so an empty `meta` column has to be dropped rather than
      // returned.
      if (value === null && STRUCTURED.has(field.payloadType)) continue;

      doc[path] = path === "id" ? toId(value) : toPayloadValue(value);
      continue;
    }

    const idKey = field.targetIdField.name;

    if (field.isList) {
      const related = row[field.prismaField];
      if (Array.isArray(related)) {
        doc[path] = related.map((entry) => relatedId(entry, idKey));
      }
      continue;
    }

    // A to-one this model owns reads off its foreign-key column, which costs
    // no join and is present on every plain `findMany`.
    if (field.ownsForeignKey && field.foreignKey !== undefined && field.foreignKey in row) {
      doc[path] = relatedId(row[field.foreignKey], idKey);
      continue;
    }
    if (field.prismaField in row) {
      doc[path] = relatedId(row[field.prismaField], idKey);
    }
  }

  return doc;
}

/**
 * Builds the `include` a read needs to return every mapped relation.
 *
 * Only relations that cannot be read off a local column are included: to-many
 * relations, and the non-owning half of a to-one. Each selects the target's id
 * and nothing else, because that is all a relationship field holds and Payload
 * populates the rest through its own data loader.
 *
 * @param props - Input props.
 * @param props.mapping - The collection's mapping.
 * @returns The `include` object, or `undefined` when nothing needs including.
 */
export function buildInclude(props: {
  mapping: ModelMapping;
}): Record<string, unknown> | undefined {
  const { mapping } = props;
  if (mapping.includes.length === 0) return undefined;

  const include: Record<string, unknown> = {};
  for (const relation of mapping.includes) {
    include[relation.prismaField] = {
      select: { [relation.targetIdField.name]: true },
      // Without one the database returns the rows in whatever order it chose,
      // which for a child table carrying its own `order` column is not the one
      // the editor arranged.
      ...(relation.orderBy !== undefined ? { orderBy: relation.orderBy } : {}),
    };
  }
  return include;
}
