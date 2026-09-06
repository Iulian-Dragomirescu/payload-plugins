import { coercePrimaryKey, coerceScalar } from "../schema/coerce.js";
import type { ModelMapping, RelationFieldMapping } from "../mapping/types.js";
import { PrismaAdapterQueryError } from "../query/where.js";

/**
 * Translates a Payload write payload into Prisma `data`.
 *
 * Which nested operation is correct depends on the relation's shape and on
 * whether the row already exists:
 *
 * | Relation | `create`         | `update`                            |
 * | -------- | ---------------- | ----------------------------------- |
 * | to-one   | `connect`        | `connect`, or `disconnect` for null |
 * | to-many  | `connect` (list) | `set`, replaces the whole set       |
 *
 * A multi-select submits the complete intended set, so `connect` on an update
 * would only ever add, and removing a tag would silently do nothing.
 */

/** Which nested operations a write may use. */
export type WriteMode = "create" | "update";

/** Reads an id out of the shapes a relationship value arrives in. */
function incomingId(value: unknown, relation: RelationFieldMapping): unknown {
  if (value === null || value === undefined) return null;
  // Payload sends a bare id, but a caller may send the whole document, and the
  // admin panel sends `{ relationTo, value }` for a polymorphic field.
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const inner = object[relation.targetIdField.name] ?? object.id ?? object.value;
    if (inner === undefined) return null;
    return coercePrimaryKey({ value: inner, field: relation.targetIdField });
  }
  return coercePrimaryKey({ value, field: relation.targetIdField });
}

/**
 * Builds the nested write for one relationship field.
 *
 * @param props - Input props.
 * @param props.relation - The relation's mapping.
 * @param props.value - What Payload submitted for it.
 * @param props.mode - Whether the row is being created or updated.
 * @returns The nested operation, or `undefined` when there is nothing to write.
 */
function relationWrite(props: {
  relation: RelationFieldMapping;
  value: unknown;
  mode: WriteMode;
}): unknown {
  const { relation, value, mode } = props;
  const idKey = relation.targetIdField.name;

  if (relation.isList) {
    if (value === null || value === undefined) {
      // Null for a list on an update means clearing it, which is what an admin
      // form that removed every entry submits.
      return mode === "update" ? { set: [] } : undefined;
    }
    if (!Array.isArray(value)) {
      throw new PrismaAdapterQueryError(
        `Field "${relation.path}" is a to-many relationship, so it takes a list of ids, ` +
          `but received ${JSON.stringify(value)}.`,
      );
    }
    const targets = value
      .map((entry) => incomingId(entry, relation))
      .filter((entry) => entry !== null)
      .map((entry) => ({ [idKey]: entry }));

    return mode === "create" ? { connect: targets } : { set: targets };
  }

  const id = incomingId(value, relation);
  if (id === null) {
    // On a create there is nothing to detach from; on an update, clearing the
    // field means breaking the existing link.
    return mode === "update" ? { disconnect: true } : undefined;
  }
  return { connect: { [idKey]: id } };
}

/**
 * Translates Payload's write data into a Prisma `data` object.
 *
 * Fields the config does not declare are dropped, as are read-only ones
 * (`@updatedAt`, `autoincrement()`, anything marked `readOnly`). What is left
 * is the set of columns this collection is allowed to write.
 *
 * @param props - Input props.
 * @param props.data - What Payload submitted.
 * @param props.mapping - The collection's mapping.
 * @param props.mode - Whether the row is being created or updated.
 * @returns The Prisma `data` object.
 *
 * @example
 * ```ts
 * buildData({ data: { title: "Hello", author: "a1", tags: [1, 2] }, mapping, mode: "create" });
 * // → { title: "Hello",
 * //     author: { connect: { id: "a1" } },
 * //     tags:   { connect: [{ id: 1 }, { id: 2 }] } }
 * ```
 */
export function buildData(props: {
  data: Record<string, unknown>;
  mapping: ModelMapping;
  mode: WriteMode;
}): Record<string, unknown> {
  const { data, mapping, mode } = props;
  const out: Record<string, unknown> = {};

  for (const [path, value] of Object.entries(data)) {
    const field = mapping.fields.get(path);
    if (field === undefined) continue;
    if (field.readOnly) continue;
    if (value === undefined) continue;

    // The primary key is writable only on a create, and only when the schema
    // does not generate it. Changing a row's id on update would rewrite every
    // foreign key pointing at it, which is a migration rather than an edit.
    if (path === "id") {
      if (mode === "create" && !mapping.idField.isGenerated && value !== null) {
        out[mapping.idField.name] = coercePrimaryKey({ value, field: mapping.idField });
      }
      continue;
    }

    if (field.kind === "relation") {
      const write = relationWrite({ relation: field, value, mode });
      if (write !== undefined) out[field.prismaField] = write;
      continue;
    }

    if (value === null && field.field.isRequired && !field.field.hasDefaultValue) {
      throw new PrismaAdapterQueryError(
        `Field "${path}" maps to "${mapping.model}.${field.prismaField}", which is ` +
          `non-nullable in schema.prisma, so it cannot be cleared.\n` +
          `Mark the field \`required: true\` in the collection so Payload rejects this ` +
          `before it reaches the database, or make the column optional.`,
      );
    }

    out[field.prismaField] = coerceScalar({ value, field: field.field });
  }

  return out;
}
