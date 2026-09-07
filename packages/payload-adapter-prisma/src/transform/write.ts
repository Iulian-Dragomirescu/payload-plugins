import { coercePrimaryKey, coerceScalar } from "../schema/coerce.js";
import type { ArrayFieldMapping, ModelMapping, RelationFieldMapping } from "../mapping/types.js";
import { PrismaAdapterQueryError } from "../query/where.js";

/**
 * Translates a Payload write payload into Prisma `data`.
 *
 * Which nested operation is correct depends on the relation's shape and on
 * whether the row already exists:
 *
 * | Relation      | `create`         | `update`                            |
 * | ------------- | ---------------- | ----------------------------------- |
 * | to-one        | `connect`        | `connect`, or `disconnect` for null |
 * | to-many       | `connect` (list) | `set`, replaces the whole set       |
 * | array to-many | `create`         | `deleteMany` + `update` + `create`  |
 *
 * A multi-select submits the complete intended set, so `connect` on an update
 * would only ever add, and removing a tag would silently do nothing.
 *
 * An array owns its rows rather than pointing at them, so a removal deletes the
 * row instead of clearing its foreign key. That is why an array can be written
 * over a non-null foreign key where a `relationship` cannot.
 */

/** Which nested operations a write may use. */
export type WriteMode = "create" | "update";

/**
 * What one array currently holds: each row's id, and that row's own arrays.
 *
 * Recursive because an array can hold arrays, and which rows exist depends on
 * WHICH row you are inside: two sections have different links. A flat set keyed
 * by field name would answer "does this id exist anywhere", which is not the
 * question a nested write asks.
 */
export type ExistingRows = Map<string, ExistingArrays>;

/** Every array on one document or row, by Payload field name. */
export type ExistingArrays = Map<string, ExistingRows>;

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
 * Builds the nested write for one array field.
 *
 * The submitted rows are the complete intended list, so the write is a
 * three-way split: rows this parent already has are updated in place, rows it
 * does not are created, and rows the editor left out are deleted.
 *
 * **An incoming id is a claim, never a key.** Payload's admin panel gives every
 * new row a client-side ObjectId, so a row that has never been saved arrives
 * carrying an id that looks real and matches nothing. Acting on it would insert
 * a row keyed by that placeholder, or fail outright against an `Int @id`. Only
 * an id `existing` confirms is treated as an edit.
 *
 * @param props - Input props.
 * @param props.array - The array's mapping.
 * @param props.value - What Payload submitted for it.
 * @param props.mode - Whether the parent is being created or updated.
 * @param props.existing - The rows this parent currently holds. Always passed on
 *   an update: without it every row reads as new, and the save would delete and
 *   recreate rows the editor only edited.
 * @returns The nested operation, or `undefined` when there is nothing to write.
 */
function arrayWrite(props: {
  array: ArrayFieldMapping;
  value: unknown;
  mode: WriteMode;
  existing: ExistingRows | undefined;
}): unknown {
  const { array, value, mode, existing } = props;
  const idKey = array.target.idField.name;

  const kept: unknown[] = [];
  const update: unknown[] = [];
  const create: Record<string, unknown>[] = [];

  // Null is an emptied array, which is what a form that removed every row
  // submits. Anything else is a payload this cannot read, and reading it as
  // empty would delete every row the parent has.
  if (value !== null && value !== undefined && !Array.isArray(value)) {
    throw new PrismaAdapterQueryError(
      `Field "${array.path}" is an array, so it takes a list of rows, but received ` +
        `${JSON.stringify(value)}.`,
    );
  }

  const rows = Array.isArray(value) ? value : [];
  rows.forEach((entry, index) => {
    const { id, ...rest } = (entry ?? {}) as Record<string, unknown>;
    const held =
      existing !== undefined && id !== null && id !== undefined
        ? existing.get(String(id))
        : undefined;
    const edited = held !== undefined;

    const row = buildData({
      data: rest,
      mapping: array.target,
      mode: edited ? "update" : "create",
      // A row's own arrays are scoped to that row. A new row holds nothing yet,
      // so everything under it is a create.
      ...(held !== undefined ? { existing: held } : {}),
    });
    // The submitted order IS the order, so the column follows the index rather
    // than whatever the row was carrying.
    if (array.orderColumn !== undefined) row[array.orderColumn] = index;

    if (!edited) {
      create.push(row);
      return;
    }
    const key = coercePrimaryKey({ value: id, field: array.target.idField });
    kept.push(key);
    update.push({ where: { [idKey]: key }, data: row });
  });

  if (mode === "create") return create.length > 0 ? { create } : undefined;

  return {
    // Scoped to this parent's rows by the relation it is nested in. Nothing is
    // set to NULL here, which is the whole reason an array works over a non-null
    // foreign key.
    deleteMany: kept.length > 0 ? { [idKey]: { notIn: kept } } : {},
    ...(update.length > 0 ? { update } : {}),
    ...(create.length > 0 ? { create } : {}),
  };
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
 * @param props.existing - The rows each array currently holds, by field name.
 *   Required on an update of a mapping that has arrays.
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
  existing?: ExistingArrays;
}): Record<string, unknown> {
  const { data, mapping, mode, existing } = props;
  const out: Record<string, unknown> = {};

  for (const [path, value] of Object.entries(data)) {
    const array = mapping.arrays.get(path);
    if (array !== undefined) {
      if (value === undefined) continue;
      const write = arrayWrite({ array, value, mode, existing: existing?.get(path) });
      if (write !== undefined) out[array.prismaField] = write;
      continue;
    }

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
