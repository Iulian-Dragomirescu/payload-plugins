/**
 * The adapter's normalized view of a Prisma datamodel.
 *
 * Prisma exposes it in two shapes depending on version and generator, and
 * neither is stable API. {@link resolveDatamodel} normalizes both into the
 * types below, so the rest of the adapter sees one shape.
 */

/** How a Prisma field stores its value. */
export type FieldKind = "scalar" | "object" | "enum" | "unsupported";

/**
 * One field on a Prisma model, normalized.
 *
 * The relation triple decides how a write to it is spelled:
 *
 * - `relationFromFields` non-empty: this side OWNS the foreign key. Writable
 *   as `{ author: { connect: { id } } }` or as `{ authorId: id }`.
 * - `relationFromFields` empty: the OTHER side owns it. Only the nested
 *   `connect` / `set` / `disconnect` form works; assigning a scalar is a Prisma
 *   validation error.
 * - `isList`: to-many, so an update replaces the set with `set`.
 */
export interface DatamodelField {
  /** Field name as written in `schema.prisma`. */
  name: string;
  /** How the value is stored. */
  kind: FieldKind;
  /** Prisma type name: `String`, `Int`, `DateTime`, an enum name, or a model name. */
  type: string;
  /** Whether the field holds a list. */
  isList: boolean;
  /** Whether the field is non-nullable. */
  isRequired: boolean;
  /** Whether the field is the model's single-column primary key. */
  isId: boolean;
  /** Whether the field carries a `@unique` attribute. */
  isUnique: boolean;
  /** Whether the schema supplies a default, so a create may omit it. */
  hasDefaultValue: boolean;
  /** Whether the field is `@updatedAt`, so writes must not set it. */
  isUpdatedAt: boolean;
  /** Whether the field is `@default(autoincrement())` or otherwise DB-generated. */
  isGenerated: boolean;
  /** `@map`ped column name, when it differs from `name`. */
  dbName?: string;
  /** Relation identifier shared by both sides, for `kind: "object"` fields. */
  relationName?: string;
  /** Local scalar fields holding the foreign key. Empty on the non-owning side. */
  relationFromFields?: string[];
  /** Fields on the target model the foreign key points at. */
  relationToFields?: string[];
}

/** One model in the Prisma datamodel, normalized. */
export interface DatamodelModel {
  /** Model name as written in `schema.prisma`. */
  name: string;
  /** `@@map`ped table name, when it differs from `name`. */
  dbName?: string;
  /** Every field on the model, in declaration order. */
  fields: DatamodelField[];
  /** Field names forming a composite `@@id`, when the model has one. */
  compositePrimaryKey?: string[];
}

/** The normalized datamodel. */
export interface Datamodel {
  /** Models keyed by their Prisma model name. */
  models: Record<string, DatamodelModel>;
}

/**
 * Something the adapter can read a datamodel out of: a generated
 * `PrismaClient`, the `Prisma` namespace object, an already-normalized
 * {@link Datamodel}, or a raw DMMF-shaped object.
 */
export type DatamodelSource = unknown;

/** Reads a property off an unknown value without widening the whole thing to `any`. */
function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** Coerces an unknown to a string array, dropping non-strings. */
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Normalizes one raw DMMF field entry.
 *
 * @param raw - The entry as Prisma exposes it.
 * @returns The normalized field, or `undefined` when the entry has no usable name.
 */
function normalizeField(raw: unknown): DatamodelField | undefined {
  const name = prop(raw, "name");
  if (typeof name !== "string") return undefined;

  const kindRaw = prop(raw, "kind");
  const kind: FieldKind =
    kindRaw === "object" || kindRaw === "enum" || kindRaw === "unsupported"
      ? kindRaw
      : "scalar";

  const dbName = prop(raw, "dbName");
  const relationName = prop(raw, "relationName");
  const defaultValue = prop(raw, "default");

  return {
    name,
    kind,
    type: typeof prop(raw, "type") === "string" ? (prop(raw, "type") as string) : "String",
    isList: prop(raw, "isList") === true,
    isRequired: prop(raw, "isRequired") === true,
    isId: prop(raw, "isId") === true,
    isUnique: prop(raw, "isUnique") === true,
    // `_runtimeDataModel` omits `hasDefaultValue` but keeps `default`, so the
    // presence of either answers "may a create leave this out?".
    hasDefaultValue: prop(raw, "hasDefaultValue") === true || defaultValue !== undefined,
    isUpdatedAt: prop(raw, "isUpdatedAt") === true,
    isGenerated:
      prop(raw, "isGenerated") === true ||
      (typeof defaultValue === "object" &&
        defaultValue !== null &&
        prop(defaultValue, "name") === "autoincrement"),
    ...(typeof dbName === "string" ? { dbName } : {}),
    ...(typeof relationName === "string" ? { relationName } : {}),
    ...(kind === "object"
      ? {
          // `[]` rather than undefined: "no local foreign key" means the other
          // side owns the relation, which must not read as "unknown".
          relationFromFields: stringArray(prop(raw, "relationFromFields")) ?? [],
          relationToFields: stringArray(prop(raw, "relationToFields")) ?? [],
        }
      : {}),
  };
}

/**
 * Normalizes one raw DMMF model entry.
 *
 * @param raw - The entry as Prisma exposes it.
 * @param fallbackName - Model name to use when the entry carries none, as in
 *   `_runtimeDataModel`, where the name is the record KEY rather than a property.
 * @returns The normalized model, or `undefined` when it has no usable name.
 */
function normalizeModel(raw: unknown, fallbackName?: string): DatamodelModel | undefined {
  const rawName = prop(raw, "name");
  const name = typeof rawName === "string" ? rawName : fallbackName;
  if (name === undefined) return undefined;

  const rawFields = prop(raw, "fields");
  if (!Array.isArray(rawFields)) return undefined;

  const dbName = prop(raw, "dbName");
  const compositePrimaryKey = stringArray(prop(prop(raw, "primaryKey"), "fields"));

  return {
    name,
    ...(typeof dbName === "string" ? { dbName } : {}),
    fields: rawFields
      .map(normalizeField)
      .filter((field): field is DatamodelField => field !== undefined),
    ...(compositePrimaryKey !== undefined && compositePrimaryKey.length > 0
      ? { compositePrimaryKey }
      : {}),
  };
}

/** True when `value` is already a normalized {@link Datamodel}. */
function isNormalized(value: unknown): value is Datamodel {
  const models = prop(value, "models");
  if (typeof models !== "object" || models === null || Array.isArray(models)) return false;
  const first = Object.values(models as Record<string, unknown>)[0];
  // A raw `_runtimeDataModel` entry also carries a `fields` array, so the
  // discriminator is `name` on the value rather than only on the key.
  return first === undefined || typeof prop(first, "name") === "string";
}

/**
 * Reads a normalized {@link Datamodel} out of whatever Prisma made available.
 *
 * Tries, in order:
 * 1. An already-normalized `Datamodel`, which is what the CLI passes after
 *    parsing `schema.prisma` directly.
 * 2. `client._runtimeDataModel`, present from Prisma 5 on, including the ESM
 *    `prisma-client` generator where `Prisma.dmmf` is absent. Models are a
 *    RECORD keyed by name.
 * 3. `Prisma.dmmf.datamodel` / `.datamodel` / `.models`, the classic shape,
 *    where models are an ARRAY carrying their own `name`.
 *
 * None of these is documented API, which is why all three are tried.
 *
 * @param source - A `PrismaClient`, the `Prisma` namespace, a `Datamodel`, or
 *   a raw DMMF object.
 * @returns The normalized datamodel.
 * @throws {Error} When no recognizable datamodel is reachable from `source`.
 *
 * @example
 * ```ts
 * import { PrismaClient } from "@prisma/client";
 * const datamodel = resolveDatamodel(new PrismaClient());
 * ```
 */
export function resolveDatamodel(source: DatamodelSource): Datamodel {
  if (isNormalized(source)) return source;

  // `_runtimeDataModel.models`: a record keyed by model name.
  const runtime = prop(prop(source, "_runtimeDataModel"), "models");
  if (typeof runtime === "object" && runtime !== null && !Array.isArray(runtime)) {
    const models: Record<string, DatamodelModel> = {};
    for (const [key, raw] of Object.entries(runtime as Record<string, unknown>)) {
      const model = normalizeModel(raw, key);
      if (model !== undefined) models[model.name] = model;
    }
    if (Object.keys(models).length > 0) return { models };
  }

  // `Prisma.dmmf.datamodel.models`: an array of models carrying their own name.
  const candidates = [
    prop(prop(prop(source, "dmmf"), "datamodel"), "models"),
    prop(prop(source, "datamodel"), "models"),
    prop(source, "models"),
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const models: Record<string, DatamodelModel> = {};
    for (const raw of candidate) {
      const model = normalizeModel(raw);
      if (model !== undefined) models[model.name] = model;
    }
    if (Object.keys(models).length > 0) return { models };
  }

  throw new Error(
    "[prisma-adapter] Could not read a Prisma datamodel from the value passed as\n" +
      "`schema.datamodel`. It accepts an already-parsed datamodel, a Prisma 5 or 6\n" +
      "client, or the `Prisma` namespace from '@prisma/client'.\n\n" +
      "On Prisma 7 the client carries no relation metadata at all, so drop\n" +
      "`schema.datamodel` and point the adapter at the schema file instead:\n\n" +
      '  prismaAdapter({ prisma, internal, schema: { path: "./prisma/schema.prisma" } })',
  );
}

/**
 * Whether a datamodel is too thin to map against.
 *
 * Prisma 7's generated client carries only `{ name, kind, type, relationName }`
 * per field, and a mapping built from that is confidently wrong: every relation
 * looks non-owning, and with no `@id` no collection can be addressed. Detected
 * by the absence of any primary key across every model.
 *
 * @param props - Input props.
 * @param props.datamodel - The datamodel to inspect.
 * @returns `true` when the datamodel lacks the metadata the adapter needs.
 *
 * @see {@link ./parseSchema!parsePrismaSchema} for the source that always has it
 */
export function isDatamodelThin(props: { datamodel: Datamodel }): boolean {
  const models = Object.values(props.datamodel.models);
  if (models.length === 0) return true;
  return !models.some((model) => model.fields.some((field) => field.isId));
}

/** Raised when the only datamodel available cannot support a mapping. */
export class PrismaAdapterThinDatamodelError extends Error {
  constructor() {
    super(
      "[prisma-adapter] The Prisma client exposes a datamodel with no primary keys and no\n" +
        "relation metadata. Prisma 7 removed both from the generated client, so there is\n" +
        "nothing there to map against.\n\n" +
        "Point the adapter at your schema instead. It is the source of truth anyway:\n\n" +
        "  prismaAdapter({\n" +
        "    prisma,\n" +
        "    internal,\n" +
        '    schema: { path: "./prisma/schema.prisma" },\n' +
        "  });\n\n" +
        "`schema.path` defaults to `./prisma/schema.prisma`, so you can usually drop\n" +
        "`schema` entirely.",
    );
    this.name = "PrismaAdapterThinDatamodelError";
  }
}

/**
 * Looks a model up by name.
 *
 * @param props - Input props.
 * @param props.datamodel - The normalized datamodel.
 * @param props.model - The Prisma model name.
 * @returns The model, or `undefined` when it is not in the schema.
 */
export function getModel(props: {
  datamodel: Datamodel;
  model: string;
}): DatamodelModel | undefined {
  return props.datamodel.models[props.model];
}

/**
 * Looks a field up on a model by name.
 *
 * @param props - Input props.
 * @param props.model - The model to search.
 * @param props.field - The Prisma field name.
 * @returns The field, or `undefined` when the model has no such field.
 */
export function getField(props: {
  model: DatamodelModel;
  field: string;
}): DatamodelField | undefined {
  return props.model.fields.find((field) => field.name === props.field);
}

/**
 * Finds a model's single-column primary key.
 *
 * Returns `undefined` for a model with a composite `@@id`. The adapter
 * addresses rows by a single id everywhere, so a composite key has no
 * representation and the mapping layer rejects the model rather than picking
 * one of its columns.
 *
 * @param props - Input props.
 * @param props.model - The model to inspect.
 * @returns The primary key field, or `undefined`.
 */
export function getPrimaryKeyField(props: { model: DatamodelModel }): DatamodelField | undefined {
  return props.model.fields.find((field) => field.isId);
}

/**
 * The delegate key for a model on a `PrismaClient`.
 *
 * Prisma lower-cases the first character and leaves the rest alone, so `Post`
 * is `prisma.post` and `BlogPost` is `prisma.blogPost`. A model already
 * starting lowercase keeps its name.
 *
 * @param props - Input props.
 * @param props.model - The Prisma model name.
 * @returns The property name to index the client with.
 *
 * @example
 * ```ts
 * delegateKey({ model: "BlogPost" }); // → "blogPost"
 * ```
 */
export function delegateKey(props: { model: string }): string {
  const { model } = props;
  if (model.length === 0) return model;
  return model.charAt(0).toLowerCase() + model.slice(1);
}
