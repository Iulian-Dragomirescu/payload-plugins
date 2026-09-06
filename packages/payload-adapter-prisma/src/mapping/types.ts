import type { DatamodelField, DatamodelModel } from "../schema/datamodel.js";

/**
 * The mapping that connects a Payload collection or global to a Prisma model.
 *
 * The schema is fixed and the config says which part of it a collection is a
 * view onto. Declared under `custom.prisma`, Payload's own extension slot, so a
 * config carrying it is still an ordinary Payload config.
 *
 * @example
 * ```ts
 * export const Posts: CollectionConfig = {
 *   slug: "posts",
 *   custom: { prisma: { model: "BlogPost" } },
 *   fields: [ … ],
 * };
 * ```
 */
export interface PrismaModelMapping {
  /**
   * The Prisma model backing this collection or global.
   *
   * Its presence is what opts the config in. A collection without
   * `custom.prisma` is stored by the internal adapter, which is how
   * `payload-preferences` and friends stay out of your database.
   */
  model: string;
  /**
   * The model's primary-key field, when it is not the one marked `@id`.
   *
   * For a model whose `@id` is not the column you address rows by, a legacy
   * surrogate key alongside a `@unique` business key, say.
   */
  id?: string;
}

/**
 * How a global's single row is found.
 *
 * **The first row, by primary key.** If the table is empty, the first save
 * creates it, so a global-backed table never has to be seeded. The adapter only
 * ever reads that one row; use {@link PrismaGlobalMapping.where} when "first"
 * is not the right one.
 */
export interface PrismaGlobalMapping extends PrismaModelMapping {
  /**
   * A Prisma `where` narrowing the table to this global's row.
   *
   * For one table holding several singletons told apart by a discriminator
   * column: `where: { key: "site" }`. Applied to reads and merged into creates,
   * so the row this finds is the row a first save makes.
   */
  where?: Record<string, unknown>;
}

/**
 * The mapping that connects one Payload field to one Prisma field.
 *
 * All three keys are optional. A field needs none of them when its Payload name
 * already matches its Prisma name.
 *
 * @example
 * ```ts
 * { name: "body", type: "textarea", custom: { prisma: { field: "content" } } }
 * ```
 */
export interface PrismaFieldMapping {
  /** The Prisma field backing this one. Defaults to the Payload field's name. */
  field?: string;
  /**
   * Which foreign key this relationship travels over.
   *
   * Only needed when the model holds two relations to the same target, a post
   * with both an `author` and a `reviewer` pointing at `Author`.
   */
  foreignKey?: string;
  /**
   * Read this column, never write it.
   *
   * For a column something else owns: a counter a trigger maintains, a value
   * another service writes. The field still renders and still reads, it is only
   * dropped from every `create` and `update` payload.
   */
  readOnly?: boolean;
}

/** What every field mapping carries, whatever its kind. */
interface FieldMappingBase {
  /** The Payload field's name, as the admin panel and the API use it. */
  path: string;
  /** The Prisma field's name, as the client uses it. */
  prismaField: string;
  /** Whether writes must skip this field. */
  readOnly: boolean;
}

/**
 * A field backed by a column.
 *
 * Covers everything that is not a relationship. The structured types (`group`,
 * `array`, `blocks`, `json`, `richText`) land in a `Json` column whole, because
 * spreading them across child tables the way Payload's relational adapters do
 * would mean creating tables.
 */
export interface ScalarFieldMapping extends FieldMappingBase {
  kind: "scalar";
  /** The Prisma field, as the schema declares it. */
  field: DatamodelField;
  /**
   * The Payload field's `type`.
   *
   * Needed on read: a NULL `Json` column means "no value", and for a `group`
   * Payload spells that absent rather than `null`. It fills an absent group
   * with `{}` and crashes on a literal `null`.
   */
  payloadType: string;
}

/**
 * A field backed by a Prisma relation.
 *
 * Three of these come from `schema.prisma`, because the Payload config cannot
 * know them:
 *
 * - `ownsForeignKey`: whether this side stores the key. An owning side may be
 *   written nested or as a plain scalar, a non-owning side only nested.
 * - `isList`: to-many, so an update replaces the set rather than adding to it.
 * - `targetIdField`: the type an id is coerced to. An admin form submits `"7"`,
 *   an `Int @id` needs `7`, and Prisma will not convert.
 */
export interface RelationFieldMapping extends FieldMappingBase {
  kind: "relation";
  /** The relation field, as the schema declares it. */
  field: DatamodelField;
  /** Whether this model stores the foreign key. */
  ownsForeignKey: boolean;
  /** The local scalar holding the foreign key, when this side owns it. */
  foreignKey?: string;
  /** The model on the other end. */
  targetModel: DatamodelModel;
  /** The other end's primary key, which incoming ids are coerced to. */
  targetIdField: DatamodelField;
  /** Whether the relation is to-many. */
  isList: boolean;
}

/** One field's mapping. */
export type FieldMapping = ScalarFieldMapping | RelationFieldMapping;

/**
 * Everything the adapter needs to talk to one collection's or global's model.
 *
 * Built once at startup by {@link ./build!buildModelMapping} and then only read,
 * so a mapping error surfaces at boot rather than on the first list view.
 */
export interface ModelMapping {
  /** The Payload collection's or global's slug. */
  slug: string;
  /** Which of the two it is, for error messages that name the right thing. */
  kind: "collection" | "global";
  /** The Prisma model's name. */
  model: string;
  /** The property to index a `PrismaClient` with: `BlogPost` is `blogPost`. */
  delegate: string;
  /** The model's primary key. */
  idField: DatamodelField;
  /** Field mappings by Payload field name. */
  fields: Map<string, FieldMapping>;
  /**
   * Relation mappings that must be `include`d to be read back.
   *
   * A to-one relation this model owns comes off its foreign-key column and
   * costs no join. To-many, and the non-owning half of a to-one, have to be
   * fetched.
   */
  includes: RelationFieldMapping[];
  /**
   * The Prisma `where` that narrows a global's table to its one row.
   *
   * Only ever set for `kind: "global"`. Absent means the first row by primary
   * key.
   */
  singleton?: Record<string, unknown>;
}
