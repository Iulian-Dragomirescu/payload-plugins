import type {
  FlattenedField,
  SanitizedCollectionConfig,
  SanitizedGlobalConfig,
} from "payload";

import type { Datamodel, DatamodelField, DatamodelModel } from "../schema/datamodel.js";
import { delegateKey } from "../schema/datamodel.js";
import type {
  FieldMapping,
  ModelMapping,
  PrismaFieldMapping,
  PrismaGlobalMapping,
  PrismaModelMapping,
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
 * Whether a Payload field corresponds to stored data at all.
 *
 * `join` fields are Payload's reverse lookups, computed from the other side and
 * never stored. `virtual` fields are populated by hooks. Both would send the
 * mapper looking for a column that is not supposed to exist.
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

  return {
    kind: "relation",
    path,
    prismaField: relation.name,
    readOnly: declared.readOnly === true,
    field: relation,
    ownsForeignKey: foreignKey !== undefined,
    ...(foreignKey !== undefined ? { foreignKey } : {}),
    targetModel,
    targetIdField,
    isList: relation.isList,
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
    includes,
    ...(kind === "global" && declared.where !== undefined ? { singleton: declared.where } : {}),
  };
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

  return { collections, globals };
}
