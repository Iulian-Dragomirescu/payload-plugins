import type {
  FlattenedField,
  SanitizedCollectionConfig,
  SanitizedGlobalConfig,
  Sort,
  Where,
} from "payload";

import type { Datamodel, DatamodelField, DatamodelModel } from "../schema/datamodel.js";
import { delegateKey } from "../schema/datamodel.js";
import type {
  FieldMapping,
  JoinFieldMapping,
  ModelMapping,
  PrismaFieldMapping,
  PrismaGlobalMapping,
  PrismaModelMapping,
  PrismaOrderByInput,
  RelationFieldMapping,
} from "./types.js";

/**
 * Raised at startup when a config cannot be resolved against `schema.prisma`.
 *
 * A mapping is a set of strings pointing at another file and nothing in the
 * type system checks them, so the message is the type check: it names what was
 * looked for, what is there, and the line of config that fixes it.
 */
export class PrismaAdapterMappingError extends Error {
  constructor(message: string) {
    super(`[prisma-adapter] ${message}`);
    this.name = "PrismaAdapterMappingError";
  }
}

/** Renders a list of names for an error message, truncated if it is long. */
function nameList(names: string[]): string {
  const shown = names.slice(0, 25);
  return shown.join(", ") + (names.length > shown.length ? ", …" : "");
}

/** What a config is, for messages that name the right thing. */
type Kind = "collection" | "global";

/** Renders a kind for the start of a sentence. */
function label(kind: Kind): string {
  return kind === "collection" ? "Collection" : "Global";
}

/**
 * Reads the adapter's mapping off a collection's or global's `custom` slot.
 *
 * The presence of this is the ONLY thing that decides which database a config
 * is stored in, so it is read in exactly one place and validated there.
 *
 * @param props - Input props.
 * @param props.slug - The config's slug, for errors.
 * @param props.kind - Whether it is a collection or a global.
 * @param props.custom - The config's `custom` object.
 * @returns The mapping, or `undefined` when it is not Prisma-backed.
 */
export function readAdapterMapping(props: {
  slug: string;
  kind: Kind;
  custom: unknown;
}): PrismaGlobalMapping | undefined {
  const custom = props.custom as { prisma?: unknown } | undefined;
  const mapping = custom?.prisma;
  if (mapping === undefined || mapping === null) return undefined;
  if (typeof mapping !== "object") {
    throw new PrismaAdapterMappingError(
      `${label(props.kind)} "${props.slug}" has a \`custom.prisma\` that is not an ` +
        `object. It should look like \`custom: { prisma: { model: "MyModel" } }\`.`,
    );
  }
  const model = (mapping as { model?: unknown }).model;
  if (typeof model !== "string" || model.length === 0) {
    throw new PrismaAdapterMappingError(
      `${label(props.kind)} "${props.slug}" has \`custom.prisma\` but no \`model\`. ` +
        `Name the Prisma model it maps onto: \`custom: { prisma: { model: "MyModel" } }\`.`,
    );
  }
  return mapping as PrismaGlobalMapping;
}

/**
 * Reads the adapter's mapping off a collection.
 *
 * @param props - Input props.
 * @param props.collection - The sanitized collection config.
 * @returns The mapping, or `undefined` when the collection is not Prisma-backed.
 */
export function readCollectionMapping(props: {
  collection: SanitizedCollectionConfig;
}): PrismaModelMapping | undefined {
  return readAdapterMapping({
    slug: props.collection.slug,
    kind: "collection",
    custom: props.collection.custom,
  });
}

/**
 * Reads the adapter's mapping off a global.
 *
 * @param props - Input props.
 * @param props.global - The sanitized global config.
 * @returns The mapping, or `undefined` when the global is not Prisma-backed.
 */
export function readGlobalMapping(props: {
  global: SanitizedGlobalConfig;
}): PrismaGlobalMapping | undefined {
  return readAdapterMapping({
    slug: props.global.slug,
    kind: "global",
    custom: props.global.custom,
  });
}

/** Reads the adapter's mapping off a field's `custom` slot. */
function readFieldMapping(field: FlattenedField): PrismaFieldMapping {
  const custom = (field as { custom?: { prisma?: unknown } }).custom;
  const mapping = custom?.prisma;
  if (mapping === undefined || mapping === null) return {};
  if (typeof mapping !== "object") return {};
  return mapping as PrismaFieldMapping;
}

/**
 * Whether a Payload field corresponds to a column on THIS model.
 *
 * `join` fields are reverse lookups, read from the child's foreign key by
 * {@link buildJoinMappings} rather than from a column here. `virtual` fields are
 * populated by hooks. Both would send the column mapper looking for something
 * that is not supposed to exist.
 */
function isStored(field: FlattenedField): boolean {
  if (field.type === "join") return false;
  if ((field as { virtual?: boolean | string }).virtual) return false;
  return true;
}

/** Whether a Payload field type holds a reference to another collection. */
function isRelationLike(field: FlattenedField): boolean {
  return field.type === "relationship" || field.type === "upload";
}

/**
 * Picks the Prisma relation field that backs a Payload relationship.
 *
 * A model with two relations to the same target is resolved by name, or by
 * `foreignKey` naming the column the relation travels over. Neither of those
 * failing is an error, not a guess: a guess writes to the wrong column.
 *
 * @param props - Input props.
 * @param props.model - The Prisma model the collection maps onto.
 * @param props.candidateName - The Prisma field name to try first.
 * @param props.foreignKey - The `db.foreignKey` override, when given.
 * @param props.slug - The collection slug, for errors.
 * @param props.path - The Payload field name, for errors.
 * @returns The relation field.
 */
function resolveRelationField(props: {
  model: DatamodelModel;
  candidateName: string;
  foreignKey: string | undefined;
  slug: string;
  kind: Kind;
  path: string;
}): DatamodelField {
  const { model, candidateName, foreignKey, slug, kind, path } = props;
  const relations = model.fields.filter((field) => field.kind === "object");

  if (foreignKey !== undefined) {
    const byKey = relations.find((relation) =>
      (relation.relationFromFields ?? []).includes(foreignKey),
    );
    if (byKey === undefined) {
      const available = relations
        .filter((relation) => (relation.relationFromFields ?? []).length > 0)
        .map((relation) => `${relation.name} (${(relation.relationFromFields ?? []).join(", ")})`);
      throw new PrismaAdapterMappingError(
        `${label(kind)} "${slug}" field "${path}" sets \`foreignKey: "${foreignKey}"\`, but no ` +
          `relation on "${model.name}" travels over that column.\n` +
          `Relations that own a foreign key on "${model.name}": ${nameList(available)}.`,
      );
    }
    return byKey;
  }

  const byName = relations.find((relation) => relation.name === candidateName);
  if (byName !== undefined) return byName;

  throw new PrismaAdapterMappingError(
    `${label(kind)} "${slug}" field "${path}" maps to "${model.name}.${candidateName}", which is ` +
      `not a relation on that model.\n` +
      `Relations on "${model.name}": ${nameList(relations.map((relation) => relation.name))}.\n` +
      `Set \`custom: { prisma: { field: "…" } }\` on the field to name the relation, or ` +
      `\`foreignKey: "…"\` to name the column it travels over.`,
  );
}

/**
 * Finds the other half of a relation, on the model it points at.
 *
 * Prisma pairs the two sides by `@relation` name, and requires one as soon as
 * two relations connect the same pair of models. So an unnamed relation has
 * exactly one counterpart, or none at all.
 *
 * @param props - Input props.
 * @param props.relation - The relation field, as this model declares it.
 * @param props.modelName - The model the relation is declared on.
 * @param props.targetModel - The model the relation points at.
 * @returns The field on the target that points back, when there is one.
 */
function findBackRelation(props: {
  relation: DatamodelField;
  modelName: string;
  targetModel: DatamodelModel;
}): DatamodelField | undefined {
  const { relation, modelName, targetModel } = props;
  const candidates = targetModel.fields.filter(
    // `entry !== relation` only matters for a self-relation, where the field
    // and its counterpart are both on this model and both would match.
    (entry) => entry.kind === "object" && entry.type === modelName && entry !== relation,
  );
  if (relation.relationName !== undefined) {
    return candidates.find((entry) => entry.relationName === relation.relationName);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Refuses a to-many whose rows cannot be removed from the set.
 *
 * A Payload update submits the complete intended set, which the write layer
 * spells `set`, and `set` disconnects everything the editor took out. On a
 * one-to-many that means writing NULL into the child's foreign key. When the
 * column is non-null Prisma refuses at the database, so the field works for as
 * long as nobody removes anything and then fails a long way from its cause.
 *
 * Everything needed to see that is in the datamodel at startup.
 *
 * @param props - Input props.
 * @throws {PrismaAdapterMappingError} When a removal could not be written.
 */
function assertRemovable(props: {
  relation: DatamodelField;
  model: DatamodelModel;
  targetModel: DatamodelModel;
  slug: string;
  kind: Kind;
  path: string;
}): void {
  const { relation, model, targetModel, slug, kind, path } = props;

  const back = findBackRelation({ relation, modelName: model.name, targetModel });
  const column = (back?.relationFromFields ?? [])[0];
  if (column === undefined) return;

  // No foreign key on the child means an implicit many-to-many, where a removal
  // is a row leaving the join table and nothing is ever set to NULL.
  const scalar = targetModel.fields.find((entry) => entry.name === column);
  if (scalar === undefined || !scalar.isRequired) return;

  throw new PrismaAdapterMappingError(
    `${label(kind)} "${slug}" field "${path}" is a to-many relationship over ` +
      `"${model.name}.${relation.name}", and a Payload update writes the whole set at once, ` +
      `which disconnects every row the editor removed.\n` +
      `That means writing NULL into "${targetModel.name}.${column}", which is non-null in ` +
      `schema.prisma, so the first removal fails at the database with "would violate the ` +
      `required relation". Adding works until then, which is why this is a startup error.\n` +
      `Pick one:\n` +
      `  • \`type: "join", collection: "…", on: "${back?.name ?? "…"}"\` instead of the ` +
      `relationship, which reads the children and never writes the set.\n` +
      `  • \`custom: { prisma: { readOnly: true } }\` on the field, to read the set and ` +
      `never write it.\n` +
      `  • make "${targetModel.name}.${column}" optional in schema.prisma.`,
  );
}

/**
 * Reads and checks a field's `orderBy`, which only a to-many can carry.
 *
 * @param props - Input props.
 * @returns The `orderBy`, or `undefined` when the field declares none.
 * @throws {PrismaAdapterMappingError} When it names a column the target has not
 *   got, or a direction Prisma does not take.
 */
function readOrderBy(props: {
  declared: PrismaFieldMapping;
  relation: DatamodelField;
  targetModel: DatamodelModel;
  slug: string;
  kind: Kind;
  path: string;
}): PrismaOrderByInput | undefined {
  const { declared, relation, targetModel, slug, kind, path } = props;
  if (declared.orderBy === undefined) return undefined;

  if (!relation.isList) {
    throw new PrismaAdapterMappingError(
      `${label(kind)} "${slug}" field "${path}" sets \`orderBy\`, but it is a to-one ` +
        `relationship and there is only ever one row to read.\nRemove \`orderBy\`.`,
    );
  }

  const entries = Array.isArray(declared.orderBy) ? declared.orderBy : [declared.orderBy];
  for (const entry of entries) {
    for (const [column, direction] of Object.entries(entry)) {
      if (!targetModel.fields.some((field) => field.name === column && field.kind !== "object")) {
        const scalars = targetModel.fields
          .filter((field) => field.kind !== "object")
          .map((field) => field.name);
        throw new PrismaAdapterMappingError(
          `${label(kind)} "${slug}" field "${path}" orders by "${targetModel.name}.${column}", ` +
            `which is not a column on that model.\n` +
            `Columns on "${targetModel.name}": ${nameList(scalars)}.`,
        );
      }
      if (direction !== "asc" && direction !== "desc") {
        throw new PrismaAdapterMappingError(
          `${label(kind)} "${slug}" field "${path}" orders by "${column}: ` +
            `${JSON.stringify(direction)}", which Prisma does not take. Use "asc" or "desc".`,
        );
      }
    }
  }

  return declared.orderBy;
}

/**
 * Builds the mapping for one relationship field.
 *
 * @param props - Input props.
 * @returns The relation mapping.
 */
function buildRelationMapping(props: {
  field: FlattenedField;
  model: DatamodelModel;
  datamodel: Datamodel;
  slug: string;
  kind: Kind;
}): RelationFieldMapping {
  const { field, model, datamodel, slug, kind } = props;
  const path = (field as { name: string }).name;
  const declared = readFieldMapping(field);

  const relationTo = (field as { relationTo?: string | string[] }).relationTo;
  if (Array.isArray(relationTo)) {
    throw new PrismaAdapterMappingError(
      `${label(kind)} "${slug}" field "${path}" is a polymorphic relationship ` +
        `(\`relationTo: [${relationTo.map((entry) => `"${entry}"`).join(", ")}]\`). ` +
        `A Prisma relation points at exactly one model, so there is no column this can ` +
        `be.\nEither split it into one field per target, or leave this collection ` +
        `unmapped so it is stored in the internal database.`,
    );
  }

  const relation = resolveRelationField({
    model,
    candidateName: declared.field ?? path,
    foreignKey: declared.foreignKey,
    slug,
    kind,
    path,
  });

  const targetModel = datamodel.models[relation.type];
  if (targetModel === undefined) {
    throw new PrismaAdapterMappingError(
      `${label(kind)} "${slug}" field "${path}" points at Prisma model "${relation.type}", which ` +
        `is not in the schema. Models: ${nameList(Object.keys(datamodel.models))}.`,
    );
  }

  const targetIdField = targetModel.fields.find((entry) => entry.isId);
  if (targetIdField === undefined) {
    throw new PrismaAdapterMappingError(
      `${label(kind)} "${slug}" field "${path}" points at "${targetModel.name}", which has no ` +
        `single-column \`@id\`. The adapter addresses related rows by one id, so a composite ` +
        `key has no representation here.`,
    );
  }

  const foreignKey = (relation.relationFromFields ?? [])[0];

  // A disagreement between `hasMany` and `isList` means the admin panel submits
  // a shape the write layer cannot translate: an array where Prisma wants one
  // id, or the reverse.
  const hasMany = (field as { hasMany?: boolean }).hasMany === true;
  if (hasMany !== relation.isList) {
    throw new PrismaAdapterMappingError(
      `${label(kind)} "${slug}" field "${path}" is \`hasMany: ${String(hasMany)}\`, but ` +
        `"${model.name}.${relation.name}" is ${relation.isList ? "a list" : "to-one"} in ` +
        `schema.prisma.\nThe two have to agree — ` +
        (relation.isList
          ? `add \`hasMany: true\` to the field.`
          : `remove \`hasMany\` from the field.`),
    );
  }

  const readOnly = declared.readOnly === true;

  // A read-only field is never written, so `set` never runs and the child's
  // foreign key is never at risk.
  if (relation.isList && !readOnly) {
    assertRemovable({ relation, model, targetModel, slug, kind, path });
  }

  const orderBy = readOrderBy({ declared, relation, targetModel, slug, kind, path });

  return {
    kind: "relation",
    path,
    prismaField: relation.name,
    readOnly,
    field: relation,
    ownsForeignKey: foreignKey !== undefined,
    ...(foreignKey !== undefined ? { foreignKey } : {}),
    targetModel,
    targetIdField,
    isList: relation.isList,
    ...(orderBy !== undefined ? { orderBy } : {}),
  };
}

/**
 * Builds the mapping for one scalar field.
 *
 * @param props - Input props.
 * @returns The scalar mapping.
 */
function buildScalarMapping(props: {
  field: FlattenedField;
  model: DatamodelModel;
  slug: string;
  kind: Kind;
}): FieldMapping {
  const { field, model, slug, kind } = props;
  const path = (field as { name: string }).name;
  const declared = readFieldMapping(field);
  const target = declared.field ?? path;

  const column = model.fields.find((entry) => entry.name === target);
  if (column === undefined) {
    const scalars = model.fields
      .filter((entry) => entry.kind !== "object")
      .map((entry) => entry.name);
    throw new PrismaAdapterMappingError(
      `${label(kind)} "${slug}" field "${path}" maps to "${model.name}.${target}", which does not ` +
        `exist.\nFields on "${model.name}": ${nameList(scalars)}.\n` +
        `Set \`custom: { prisma: { field: "…" } }\` on the field, or add the column to ` +
        `your schema.`,
    );
  }

  if (column.kind === "object") {
    throw new PrismaAdapterMappingError(
      `${label(kind)} "${slug}" field "${path}" maps to "${model.name}.${target}", which is a ` +
        `relation, but the field is a \`${field.type}\` rather than a \`relationship\`.\n` +
        `Change the field to \`type: "relationship"\`, or point it at a scalar column.`,
    );
  }

  return {
    kind: "scalar",
    path,
    prismaField: column.name,
    // A `@updatedAt` column is Prisma's to maintain and an `autoincrement()`
    // key is the database's. Writing either is an error, not a preference, so
    // it is not left to the config.
    readOnly: declared.readOnly === true || column.isUpdatedAt || column.isGenerated,
    field: column,
    payloadType: field.type,
  };
}

/**
 * Resolves one Payload collection or global against the Prisma datamodel.
 *
 * Runs at startup, once per mapped config, so every mapping error arrives with
 * the config in front of you rather than mid-request.
 *
 * `join` fields are left out. They are resolved against the OTHER collection's
 * mapping, which may not exist yet, so {@link buildMappings} fills them in with
 * a second pass. A mapping built through this function alone has none.
 *
 * @param props - Input props.
 * @param props.slug - The config's slug.
 * @param props.kind - Whether it is a collection or a global.
 * @param props.custom - The config's `custom` object, holding the mapping.
 * @param props.flattenedFields - The config's fields, already flattened by Payload.
 * @param props.datamodel - The parsed Prisma datamodel.
 * @returns The mapping.
 * @throws {PrismaAdapterMappingError} When the config cannot be resolved.
 */
export function buildModelMapping(props: {
  slug: string;
  kind: Kind;
  custom: unknown;
  flattenedFields: FlattenedField[];
  datamodel: Datamodel;
}): ModelMapping {
  const { slug, kind, custom, flattenedFields, datamodel } = props;

  const declared = readAdapterMapping({ slug, kind, custom });
  if (declared === undefined) {
    throw new PrismaAdapterMappingError(
      `${label(kind)} "${slug}" has no \`custom.prisma\`, so it is not Prisma-backed.`,
    );
  }

  const model = datamodel.models[declared.model];
  if (model === undefined) {
    throw new PrismaAdapterMappingError(
      `${label(kind)} "${slug}" maps to Prisma model "${declared.model}", which is not in the ` +
        `schema.\nModels: ${nameList(Object.keys(datamodel.models))}.`,
    );
  }

  const idField =
    declared.id !== undefined
      ? model.fields.find((entry) => entry.name === declared.id)
      : model.fields.find((entry) => entry.isId);

  if (idField === undefined) {
    if (declared.id !== undefined) {
      throw new PrismaAdapterMappingError(
        `${label(kind)} "${slug}" sets \`id: "${declared.id}"\`, which is not a field on ` +
          `"${model.name}".`,
      );
    }
    throw new PrismaAdapterMappingError(
      `${label(kind)} "${slug}" maps to "${model.name}", which has no single-column \`@id\`.\n` +
        (model.compositePrimaryKey !== undefined
          ? `It has a composite key (\`@@id([${model.compositePrimaryKey.join(", ")}])\`), and ` +
            `Payload addresses every document by one id — in URLs, in relationship values, in ` +
            `\`findByID\`. There is nothing to put there.\n` +
            `Add a surrogate \`@id\` column, or leave this ${kind} unmapped.`
          : `Add an \`@id\` to the model.`),
    );
  }

  const fields = new Map<string, FieldMapping>();
  const includes: RelationFieldMapping[] = [];

  /** Payload's own `id`, which is the primary key whatever the column is called. */
  const idMapping: FieldMapping = {
    kind: "scalar",
    path: "id",
    prismaField: idField.name,
    readOnly: idField.isGenerated,
    field: idField,
    payloadType: "text",
  };

  for (const field of flattenedFields) {
    if (!isStored(field)) continue;
    const path = (field as { name?: string }).name;
    if (typeof path !== "string") continue;

    if (path === "id") {
      fields.set("id", idMapping);
      continue;
    }

    // Payload adds `createdAt` and `updatedAt` to every global config, whether
    // or not the table has the columns, and a global has no `timestamps: false`
    // to turn that off. Dropping them is what lets a global map onto a table
    // that was not designed for a CMS. A collection has the option, so there
    // the mismatch stays an error.
    if (
      kind === "global" &&
      (path === "createdAt" || path === "updatedAt") &&
      !model.fields.some((entry) => entry.name === (readFieldMapping(field).field ?? path))
    ) {
      continue;
    }

    const mapping = isRelationLike(field)
      ? buildRelationMapping({ field, model, datamodel, slug, kind })
      : buildScalarMapping({ field, model, slug, kind });

    fields.set(path, mapping);
    if (mapping.kind === "relation" && (mapping.isList || !mapping.ownsForeignKey)) {
      includes.push(mapping);
    }
  }

  // `id` stays addressable even when the config does not list it, which is the
  // usual case: Payload only puts `id` in `fields` for a custom ID.
  if (!fields.has("id")) fields.set("id", idMapping);

  return {
    slug,
    kind,
    model: model.name,
    delegate: delegateKey({ model: model.name }),
    idField,
    fields,
    joins: new Map(),
    includes,
    uncreatable: findUncreatableColumns({
      model,
      fields,
      // A global's discriminator is merged into every create, so its columns
      // are written even though no field names them.
      also: kind === "global" && declared.where !== undefined ? Object.keys(declared.where) : [],
    }),
    ...(kind === "global" && declared.where !== undefined ? { singleton: declared.where } : {}),
  };
}

/**
 * Lists the columns that make a `create` impossible.
 *
 * Non-null, no default, and nothing in the config writes them. Reads are fine,
 * so this is reported rather than raised: a collection can legitimately be a
 * read-only view onto a table something else fills in.
 *
 * @param props - Input props.
 * @param props.model - The Prisma model.
 * @param props.fields - The field mappings built for it.
 * @param props.also - Columns something other than a field writes.
 * @returns The column names, empty when every create can succeed.
 */
function findUncreatableColumns(props: {
  model: DatamodelModel;
  fields: Map<string, FieldMapping>;
  also: string[];
}): string[] {
  const { model, fields, also } = props;

  const written = new Set<string>(also);
  for (const mapping of fields.values()) {
    if (mapping.readOnly) continue;
    written.add(mapping.prismaField);
    // A relationship writes the foreign key through its nested `connect`, so
    // the column is covered even though no field names it.
    if (mapping.kind === "relation" && mapping.foreignKey !== undefined) {
      written.add(mapping.foreignKey);
    }
  }

  return model.fields
    .filter(
      (column) =>
        column.kind !== "object" &&
        column.isRequired &&
        !column.hasDefaultValue &&
        !column.isUpdatedAt &&
        // A scalar list has no NULL to write: Prisma defaults it to `[]`.
        !column.isList &&
        !written.has(column.name),
    )
    .map((column) => column.name);
}

/**
 * Resolves one Payload collection against the Prisma datamodel.
 *
 * @param props - Input props.
 * @param props.collection - The sanitized Payload collection.
 * @param props.datamodel - The parsed Prisma datamodel.
 * @returns The collection's mapping.
 */
export function buildCollectionMapping(props: {
  collection: SanitizedCollectionConfig;
  datamodel: Datamodel;
}): ModelMapping {
  return buildModelMapping({
    slug: props.collection.slug,
    kind: "collection",
    custom: props.collection.custom,
    flattenedFields: props.collection.flattenedFields,
    datamodel: props.datamodel,
  });
}

/**
 * Resolves one Payload global against the Prisma datamodel.
 *
 * @param props - Input props.
 * @param props.global - The sanitized Payload global.
 * @param props.datamodel - The parsed Prisma datamodel.
 * @returns The global's mapping.
 */
export function buildGlobalMapping(props: {
  global: SanitizedGlobalConfig;
  datamodel: Datamodel;
}): ModelMapping {
  return buildModelMapping({
    slug: props.global.slug,
    kind: "global",
    custom: props.global.custom,
    flattenedFields: props.global.flattenedFields,
    datamodel: props.datamodel,
  });
}

/** The keys Payload puts on a `join` field. */
interface DeclaredJoin {
  collection?: string | string[];
  defaultLimit?: number;
  defaultSort?: Sort;
  on?: string;
  where?: Where;
}

/**
 * Builds the mapping for one `join` field.
 *
 * Nothing here reads the datamodel directly. A join is the reverse of a
 * relationship the CHILD declares, so it resolves against the child's own
 * mapping and inherits the child's `custom.prisma` renames.
 *
 * @param props - Input props.
 * @param props.field - The join field, as Payload flattened it.
 * @param props.path - The Payload field's name.
 * @param props.mapping - The parent's mapping, already built.
 * @param props.collections - Every Prisma-backed collection, by slug.
 * @returns The join mapping.
 * @throws {PrismaAdapterMappingError} When it cannot be resolved.
 */
function buildJoinMapping(props: {
  field: FlattenedField;
  path: string;
  mapping: ModelMapping;
  collections: Map<string, ModelMapping>;
}): JoinFieldMapping {
  const { field, path, mapping, collections } = props;
  const { slug } = mapping;
  const declared = field as DeclaredJoin;

  if (Array.isArray(declared.collection)) {
    throw new PrismaAdapterMappingError(
      `Collection "${slug}" field "${path}" is a polymorphic join ` +
        `(\`collection: [${declared.collection.map((entry) => `"${entry}"`).join(", ")}]\`). ` +
        `Each target keeps its foreign key on a different model, so there is no one query ` +
        `this can be.\nSplit it into one join per target collection.`,
    );
  }

  const collection = declared.collection;
  const on = declared.on;
  if (typeof collection !== "string" || typeof on !== "string") {
    throw new PrismaAdapterMappingError(
      `Collection "${slug}" field "${path}" is a \`join\` without \`collection\` and \`on\`. ` +
        `Both are Payload's own required keys: \`{ type: "join", collection: "…", on: "…" }\`.`,
    );
  }

  if (on.includes(".")) {
    throw new PrismaAdapterMappingError(
      `Collection "${slug}" field "${path}" joins on "${on}", a nested path. The adapter ` +
        `stores a group or an array in one \`Json\` column, so there is no column under ` +
        `"${on.split(".")[0]}" to match the parent against.\nMove the relationship to the ` +
        `top level of "${collection}".`,
    );
  }

  const target = collections.get(collection);
  if (target === undefined) {
    throw new PrismaAdapterMappingError(
      `Collection "${slug}" field "${path}" joins collection "${collection}", which is not ` +
        `Prisma-backed, so its rows are in the internal database and no Prisma query reaches ` +
        `them.\nPrisma-backed collections: ${nameList([...collections.keys()])}.\n` +
        `Add \`custom: { prisma: { model: "…" } }\` to "${collection}", or drop the join.`,
    );
  }

  const targetRelation = target.fields.get(on);
  if (targetRelation === undefined || targetRelation.kind !== "relation") {
    const relations = [...target.fields.values()]
      .filter((entry) => entry.kind === "relation")
      .map((entry) => entry.path);
    throw new PrismaAdapterMappingError(
      `Collection "${slug}" field "${path}" joins on "${collection}.${on}", which is ` +
        `${targetRelation === undefined ? "not a field on that collection" : "a scalar field"}. ` +
        `\`on\` names the relationship pointing BACK at "${slug}".\n` +
        `Relationships on "${collection}": ${nameList(relations)}.`,
    );
  }

  const parentModel = targetRelation.targetModel;
  if (parentModel.name !== mapping.model) {
    throw new PrismaAdapterMappingError(
      `Collection "${slug}" field "${path}" joins on "${collection}.${on}", but that ` +
        `relationship points at Prisma model "${parentModel.name}", not at ` +
        `"${mapping.model}" which "${slug}" maps onto.\n` +
        `\`on\` names the relationship pointing back at this collection.`,
    );
  }

  // The children ride on the parent's own read, so the query needs the name of
  // THIS side of the relation. Prisma requires both sides to be declared, so
  // the only way it is missing is an ambiguous unnamed relation.
  const back = findBackRelation({
    relation: targetRelation.field,
    modelName: target.model,
    targetModel: parentModel,
  });
  if (back === undefined) {
    throw new PrismaAdapterMappingError(
      `Collection "${slug}" field "${path}" joins on "${collection}.${on}", but ` +
        `"${parentModel.name}" declares no field for the other side of ` +
        `"${target.model}.${targetRelation.prismaField}", or declares more than one and none ` +
        `of them is named.\nName both sides with \`@relation("…")\` in schema.prisma.`,
    );
  }

  if (!back.isList) {
    throw new PrismaAdapterMappingError(
      `Collection "${slug}" field "${path}" joins on "${collection}.${on}", which is a ` +
        `one-to-one: "${parentModel.name}.${back.name}" holds a single row, not a list, so ` +
        `there is nothing to paginate or sort.\n` +
        `Use \`{ name: "${path}", type: "relationship", relationTo: "${collection}" }\` ` +
        `instead, which addresses that one row directly.`,
    );
  }

  const claimed = [...mapping.fields.values()].find(
    (entry) => entry.kind === "relation" && entry.prismaField === back.name,
  );
  if (claimed !== undefined) {
    throw new PrismaAdapterMappingError(
      `Collection "${slug}" field "${path}" joins over "${parentModel.name}.${back.name}", ` +
        `which field "${claimed.path}" already maps as a relationship. One Prisma relation ` +
        `cannot be read twice in one query with different pagination.\n` +
        `Keep the \`join\` for reading and sorting the children, or the \`relationship\` for ` +
        `picking them, not both.`,
    );
  }

  return {
    path,
    prismaField: back.name,
    target,
    targetRelation,
    // Payload leaves `defaultLimit` unresolved, so the adapter applies its
    // documented default rather than fetching every child row.
    defaultLimit: declared.defaultLimit ?? 10,
    ...(declared.defaultSort !== undefined ? { defaultSort: declared.defaultSort } : {}),
    ...(declared.where !== undefined ? { where: declared.where } : {}),
  };
}

/**
 * Resolves the `join` fields on one already-built mapping.
 *
 * A second pass, because a join names another collection which may not have
 * been mapped yet when this one was built.
 *
 * @param props - Input props.
 * @param props.mapping - The mapping to fill in, modified in place.
 * @param props.flattenedFields - The config's fields, as Payload flattened them.
 * @param props.collections - Every Prisma-backed collection, by slug.
 * @throws {PrismaAdapterMappingError} When a join cannot be resolved.
 */
export function buildJoinMappings(props: {
  mapping: ModelMapping;
  flattenedFields: FlattenedField[];
  collections: Map<string, ModelMapping>;
}): void {
  const { mapping, flattenedFields, collections } = props;

  for (const field of flattenedFields) {
    if (field.type !== "join") continue;
    const path = (field as { name?: string }).name;
    if (typeof path !== "string") continue;

    // `findGlobal` takes no join query and the globals operations never build
    // one, on any adapter, so the field would render empty forever.
    if (mapping.kind === "global") {
      throw new PrismaAdapterMappingError(
        `Global "${mapping.slug}" field "${path}" is a \`join\`, which Payload only populates ` +
          `on collections. Nothing would ever fill it in.\nMove the field to the collection on ` +
          `the other side, or drop it.`,
      );
    }

    mapping.joins.set(path, buildJoinMapping({ field, path, mapping, collections }));
  }
}

/**
 * Resolves every Prisma-backed collection and global in a Payload config.
 *
 * A config is Prisma-backed if, and only if, it carries `custom.prisma`.
 * Payload adds `payload-preferences`, `payload-locked-documents` and
 * `payload-migrations` to every config, and a name match must never be able to
 * route one of those into your database.
 *
 * @param props - Input props.
 * @param props.collections - `payload.config.collections`.
 * @param props.globals - `payload.config.globals`.
 * @param props.datamodel - The parsed Prisma datamodel.
 * @returns Mappings by slug, in two maps. Unmapped configs are absent from both.
 */
export function buildMappings(props: {
  collections: SanitizedCollectionConfig[];
  globals: SanitizedGlobalConfig[];
  datamodel: Datamodel;
}): { collections: Map<string, ModelMapping>; globals: Map<string, ModelMapping> } {
  const collections = new Map<string, ModelMapping>();
  for (const collection of props.collections) {
    if (readCollectionMapping({ collection }) === undefined) continue;
    collections.set(
      collection.slug,
      buildCollectionMapping({ collection, datamodel: props.datamodel }),
    );
  }

  const globals = new Map<string, ModelMapping>();
  for (const global of props.globals) {
    if (readGlobalMapping({ global }) === undefined) continue;
    globals.set(global.slug, buildGlobalMapping({ global, datamodel: props.datamodel }));
  }

  // Joins last: one names another collection, which the first pass may not have
  // reached yet.
  for (const collection of props.collections) {
    const mapping = collections.get(collection.slug);
    if (mapping === undefined) continue;
    buildJoinMappings({
      mapping,
      flattenedFields: collection.flattenedFields,
      collections,
    });
  }
  for (const global of props.globals) {
    const mapping = globals.get(global.slug);
    if (mapping === undefined) continue;
    buildJoinMappings({ mapping, flattenedFields: global.flattenedFields, collections });
  }

  return { collections, globals };
}
