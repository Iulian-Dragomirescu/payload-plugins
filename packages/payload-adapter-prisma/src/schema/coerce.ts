import type { DatamodelField } from "./datamodel.js";

/** What a Prisma primary key can be. */
export type PrimaryKey = bigint | number | string;

/**
 * Coerces an incoming primary-key value to the type the schema stores.
 *
 * Admin URLs, JSON bodies and relationship pickers all carry ids as strings,
 * and a model keyed on `Int` needs a number.
 *
 * @param props - Input props.
 * @param props.value - The incoming id.
 * @param props.field - The primary-key (or foreign-key) datamodel field.
 * @returns The coerced id.
 * @throws {TypeError} When the value cannot represent that key type.
 *
 * @example
 * ```ts
 * coercePrimaryKey({ value: "42", field: { type: "Int", … } }); // → 42
 * ```
 */
export function coercePrimaryKey(props: { value: unknown; field: DatamodelField }): PrimaryKey {
  const { value, field } = props;

  if (field.type === "Int" || field.type === "Float") {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      throw new TypeError(`[prisma-adapter] Cannot use ${JSON.stringify(value)} as a "${field.type}" id.`);
    }
    return numeric;
  }

  if (field.type === "BigInt") {
    try {
      return typeof value === "bigint" ? value : BigInt(value as number | string);
    } catch {
      throw new TypeError(`[prisma-adapter] Cannot use ${JSON.stringify(value)} as a "BigInt" id.`);
    }
  }

  if (typeof value === "string") return value;
  if (typeof value === "bigint" || typeof value === "number") return String(value);

  throw new TypeError(`[prisma-adapter] Cannot use ${JSON.stringify(value)} as a "${field.type}" id.`);
}

/**
 * Coerces a scalar value to what Prisma expects for its column type.
 *
 * Only the conversions a JSON request body needs: dates arrive as ISO strings
 * and Prisma wants `Date`, numeric columns arrive as strings from form
 * encodings. Everything else passes through, because guessing further would
 * reinterpret user data.
 *
 * @param props - Input props.
 * @param props.value - The incoming value.
 * @param props.field - The target column.
 * @returns The value in the shape Prisma accepts.
 */
export function coerceScalar(props: { value: unknown; field: DatamodelField }): unknown {
  const { value, field } = props;
  if (value === null || value === undefined) return value;

  if (field.isList && Array.isArray(value)) {
    return value.map((entry) => coerceScalar({ value: entry, field: { ...field, isList: false } }));
  }

  switch (field.type) {
    case "DateTime":
      return value instanceof Date ? value : new Date(value as number | string);
    case "Decimal":
    case "Float":
    case "Int":
      return typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    case "BigInt":
      return typeof value === "bigint" ? value : BigInt(value as number | string);
    case "Boolean":
      return typeof value === "string" ? value === "true" : value;
    default:
      return value;
  }
}
