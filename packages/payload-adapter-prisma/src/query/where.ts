import type { Operator, Where, WhereField } from "payload";
import { createArrayFromCommaDelineated } from "payload";

import { coercePrimaryKey, coerceScalar } from "../schema/coerce.js";
import type { DatamodelField } from "../schema/datamodel.js";
import type { ModelMapping, RelationFieldMapping } from "../mapping/types.js";

/**
 * Translates Payload's `Where` into a Prisma `where`.
 *
 * Anything this cannot express is refused rather than dropped. A filter that
 * silently disappears returns rows the caller believed were excluded, and in an
 * access-control `where` that is a data leak.
 */

/** A Prisma `where` clause, as far as this module needs to build one. */
export type PrismaWhere = Record<string, unknown>;

/** Raised when a Payload query has no Prisma equivalent. */
export class PrismaAdapterQueryError extends Error {
  constructor(message: string) {
    super(`[prisma-adapter] ${message}`);
    this.name = "PrismaAdapterQueryError";
  }
}

/** Payload comparison operators that map straight onto a Prisma filter key. */
const DIRECT: Partial<Record<Operator, string>> = {
  equals: "equals",
  greater_than: "gt",
  greater_than_equal: "gte",
  less_than: "lt",
  less_than_equal: "lte",
  not_equals: "not",
};

/** Whether a Prisma type supports case-insensitive matching. */
function isText(field: DatamodelField): boolean {
  return field.type === "String";
}

/** Operators whose operand is a list, so a query string may comma-delineate it. */
const LIST_OPERATORS = new Set<Operator>(["all", "in", "not_in"]);

/**
 * Widens one operator's operand to the list of operands it stands for.
 *
 * Payload hands the adapter what the transport gave it, so `?where[id][in]=a,b`
 * arrives as the string `"a,b"` and splitting it is each adapter's own job.
 * Only the list operators split: a comma is ordinary text to `equals` or `like`.
 *
 * @param props - Input props.
 * @param props.operator - The Payload operator.
 * @param props.value - The operand, already an array or not.
 * @returns The operands, uncoerced.
 */
function operands(props: { operator: Operator; value: unknown }): unknown[] {
  const { operator, value } = props;
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && LIST_OPERATORS.has(operator)) {
    return createArrayFromCommaDelineated(value);
  }
  return [value];
}

/**
 * Builds a Prisma filter for one condition on one scalar column.
 *
 * @param props - Input props.
 * @param props.operator - The Payload operator.
 * @param props.value - The operand.
 * @param props.field - The column being filtered.
 * @returns The Prisma filter object for that column.
 */
function scalarCondition(props: {
  operator: Operator;
  value: unknown;
  field: DatamodelField;
}): unknown {
  const { operator, value, field } = props;
  const one = (input: unknown): unknown =>
    coerceScalar({ value: input, field: { ...field, isList: false } });
  const many = (input: unknown): unknown[] => operands({ operator, value: input }).map(one);

  // `equals` on a Prisma scalar list means "is exactly this list", which is
  // never what a CMS filter means, so lists use membership operators.
  if (field.isList) {
    switch (operator) {
      case "all":
        return { hasEvery: many(value) };
      case "contains":
      case "equals":
        return { has: one(value) };
      case "exists":
        return value === true || value === "true" ? { isEmpty: false } : { isEmpty: true };
      case "in":
        return { hasSome: many(value) };
      case "not_equals":
        return { NOT: { has: one(value) } };
      case "not_in":
        return { NOT: { hasSome: many(value) } };
      default:
        throw new PrismaAdapterQueryError(
          `Operator "${operator}" has no meaning on the list column "${field.name}".`,
        );
    }
  }

  switch (operator) {
    case "contains":
    case "like":
      return isText(field)
        ? { contains: String(value), mode: "insensitive" }
        : { contains: String(value) };
    case "exists":
      return value === true || value === "true" ? { not: null } : { equals: null };
    case "in":
      return { in: many(value) };
    case "not_in":
      return { notIn: many(value) };
    case "not_like":
      return isText(field)
        ? { NOT: { contains: String(value), mode: "insensitive" } }
        : { NOT: { contains: String(value) } };
    default: {
      const key = DIRECT[operator];
      if (key === undefined) {
        throw new PrismaAdapterQueryError(
          `Operator "${operator}" is not supported on Prisma-backed collections. ` +
            (operator === "near" || operator === "within" || operator === "intersects"
              ? "It is geospatial, and a `point` field has no Prisma column type here."
              : "Use one of: equals, not_equals, in, not_in, greater_than, " +
                "greater_than_equal, less_than, less_than_equal, like, not_like, " +
                "contains, exists, all."),
        );
      }
      // Left uncoerced: `new Date(null)` is a real date.
      if (value === null) return operator === "not_equals" ? { not: null } : { equals: null };
      return { [key]: one(value) };
    }
  }
}

/**
 * Builds a Prisma filter for one condition on a relationship.
 *
 * @param props - Input props.
 * @param props.operator - The Payload operator.
 * @param props.value - The operand: an id, or a list of them.
 * @param props.relation - The relation's mapping.
 * @returns A whole `where` fragment, because an owning to-one relation is
 *   filtered on its foreign-key column rather than on the relation itself.
 */
function relationCondition(props: {
  operator: Operator;
  value: unknown;
  relation: RelationFieldMapping;
}): PrismaWhere {
  const { operator, value, relation } = props;
  const id = (input: unknown): unknown =>
    input === null || input === undefined
      ? null
      : coercePrimaryKey({ value: input, field: relation.targetIdField });
  const ids = (input: unknown): unknown[] => operands({ operator, value: input }).map(id);

  if (relation.isList) {
    switch (operator) {
      case "all":
        // Every listed id must be present: an AND of separate `some` clauses.
        // `some: { id: { in: [...] } }` would only require one of them.
        return {
          AND: ids(value).map((entry) => ({
            [relation.prismaField]: { some: { [relation.targetIdField.name]: entry } },
          })),
        };
      case "contains":
      case "equals":
      case "in":
        return {
          [relation.prismaField]: { some: { [relation.targetIdField.name]: { in: ids(value) } } },
        };
      case "exists":
        return value === true || value === "true"
          ? { [relation.prismaField]: { some: {} } }
          : { [relation.prismaField]: { none: {} } };
      case "not_equals":
      case "not_in":
        return {
          [relation.prismaField]: { none: { [relation.targetIdField.name]: { in: ids(value) } } },
        };
      default:
        throw new PrismaAdapterQueryError(
          `Operator "${operator}" is not supported on the to-many relationship ` +
            `"${relation.path}".`,
        );
    }
  }

  // A to-one whose foreign key lives on this model is filtered on the column:
  // one table instead of two, and the foreign key's own index applies.
  if (relation.ownsForeignKey && relation.foreignKey !== undefined) {
    const column = relation.foreignKey;
    switch (operator) {
      case "equals":
        return value === null
          ? { [column]: { equals: null } }
          : { [column]: { equals: id(value) } };
      case "exists":
        return value === true || value === "true"
          ? { [column]: { not: null } }
          : { [column]: { equals: null } };
      case "in":
        return { [column]: { in: ids(value) } };
      case "not_equals":
        return value === null ? { [column]: { not: null } } : { [column]: { not: id(value) } };
      case "not_in":
        return { [column]: { notIn: ids(value) } };
      default:
        throw new PrismaAdapterQueryError(
          `Operator "${operator}" is not supported on the relationship "${relation.path}". ` +
            `A relationship is filtered by id.`,
        );
    }
  }

  // The other side owns the key, so there is no local column to compare.
  switch (operator) {
    case "equals":
    case "in":
      return {
        [relation.prismaField]: { is: { [relation.targetIdField.name]: { in: ids(value) } } },
      };
    case "exists":
      return value === true || value === "true"
        ? { [relation.prismaField]: { isNot: null } }
        : { [relation.prismaField]: { is: null } };
    case "not_equals":
    case "not_in":
      return {
        [relation.prismaField]: { isNot: { [relation.targetIdField.name]: { in: ids(value) } } },
      };
    default:
      throw new PrismaAdapterQueryError(
        `Operator "${operator}" is not supported on the relationship "${relation.path}".`,
      );
  }
}

/**
 * Builds the filter for one `path: { operator: value }` entry.
 *
 * @param props - Input props.
 * @param props.path - The Payload field path, possibly dotted.
 * @param props.condition - The operator/value pairs for that path.
 * @param props.mapping - The collection's mapping.
 * @param props.byModel - Mappings indexed by Prisma model, so a dotted path can
 *   be resolved against the target collection's field names.
 * @returns A Prisma `where` fragment.
 */
function pathCondition(props: {
  path: string;
  condition: WhereField;
  mapping: ModelMapping;
  byModel: Map<string, ModelMapping>;
}): PrismaWhere {
  const { path, condition, mapping, byModel } = props;

  const [head, ...rest] = path.split(".");
  if (head === undefined) return {};

  const field = mapping.fields.get(head);
  if (field === undefined) {
    throw new PrismaAdapterQueryError(
      `Cannot query "${path}" on collection "${mapping.slug}": "${head}" is not a field that ` +
        `maps to a Prisma column.\nQueryable fields: ` +
        `${[...mapping.fields.keys()].join(", ")}.`,
    );
  }

  // The remainder of a dotted path resolves against the TARGET collection's
  // mapping, so `author.name` honours that author's own `db.field` overrides.
  if (rest.length > 0) {
    if (field.kind !== "relation") {
      throw new PrismaAdapterQueryError(
        `Cannot query "${path}" on collection "${mapping.slug}": "${head}" is a scalar column, ` +
          `so there is nothing beyond it to traverse.`,
      );
    }
    const target = byModel.get(field.targetModel.name);
    if (target === undefined) {
      throw new PrismaAdapterQueryError(
        `Cannot query "${path}" on collection "${mapping.slug}": "${head}" points at Prisma ` +
          `model "${field.targetModel.name}", which no collection maps onto, so its field ` +
          `names are unknown here.\nQuery by id instead — \`${head}: { equals: … }\` — or add ` +
          `a collection for "${field.targetModel.name}".`,
      );
    }
    const inner = pathCondition({
      path: rest.join("."),
      condition,
      mapping: target,
      byModel,
    });
    return { [field.prismaField]: field.isList ? { some: inner } : { is: inner } };
  }

  const entries = Object.entries(condition) as [Operator, unknown][];
  const fragments = entries.map(([operator, value]) =>
    field.kind === "relation"
      ? relationCondition({ operator, value, relation: field })
      : { [field.prismaField]: scalarCondition({ operator, value, field: field.field }) },
  );

  if (fragments.length === 0) return {};
  if (fragments.length === 1) return fragments[0] as PrismaWhere;
  // Several operators on one path are an implicit AND: `{ gt: 1, lt: 10 }`.
  return { AND: fragments };
}

/**
 * Translates a Payload `Where` into a Prisma `where`.
 *
 * @param props - Input props.
 * @param props.where - The Payload query, or `undefined` for no filter.
 * @param props.mapping - The collection's mapping.
 * @param props.byModel - Mappings indexed by Prisma model name, for dotted paths.
 * @returns The Prisma `where`, or `undefined` when there is nothing to filter on.
 *
 * @example
 * ```ts
 * buildWhere({ where: { "author.name": { like: "ana" } }, mapping, byModel });
 * // → { author: { is: { name: { contains: "ana", mode: "insensitive" } } } }
 * ```
 */
export function buildWhere(props: {
  where: undefined | Where;
  mapping: ModelMapping;
  byModel: Map<string, ModelMapping>;
}): PrismaWhere | undefined {
  const { where, mapping, byModel } = props;
  if (where === undefined || where === null) return undefined;

  const clauses: PrismaWhere[] = [];

  for (const [key, value] of Object.entries(where)) {
    if (value === undefined || value === null) continue;

    if (key === "and" || key === "AND") {
      const nested = (value as Where[])
        .map((entry) => buildWhere({ where: entry, mapping, byModel }))
        .filter((entry): entry is PrismaWhere => entry !== undefined);
      if (nested.length > 0) clauses.push({ AND: nested });
      continue;
    }

    if (key === "or" || key === "OR") {
      const nested = (value as Where[])
        .map((entry) => buildWhere({ where: entry, mapping, byModel }))
        .filter((entry): entry is PrismaWhere => entry !== undefined);
      // An empty `or` matches nothing in both languages, so it is passed
      // through rather than dropped. Dropping it would widen the result set,
      // which for an access-control filter means leaking rows.
      clauses.push({ OR: nested });
      continue;
    }

    clauses.push(
      pathCondition({ path: key, condition: value as WhereField, mapping, byModel }),
    );
  }

  const meaningful = clauses.filter((clause) => Object.keys(clause).length > 0);
  if (meaningful.length === 0) return undefined;
  if (meaningful.length === 1) return meaningful[0];
  return { AND: meaningful };
}

/**
 * Combines Prisma `where` clauses with AND, dropping the empty ones.
 *
 * @param clauses - The clauses to combine.
 * @returns The combined clause, or `undefined` when nothing was left.
 */
export function mergeWhere(...clauses: (PrismaWhere | undefined)[]): PrismaWhere | undefined {
  const present = clauses.filter(
    (clause): clause is PrismaWhere => clause !== undefined && Object.keys(clause).length > 0,
  );
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return { AND: present };
}
