/**
 * A Payload CMS database adapter backed by your existing Prisma schema.
 *
 * Collections and globals carrying `custom.prisma` are translated into Prisma
 * queries; everything else, including Payload's preferences, locks, versions,
 * drafts, migrations and job queue, is routed to a second adapter. The adapter
 * issues no DDL, so `prisma migrate` stays the only thing that changes your
 * schema.
 *
 * @packageDocumentation
 */

export { describeStorage, PrismaAdapterIdTypeError, prismaAdapter } from "./adapter.js";
export type { PrismaAdapterArgs } from "./adapter.js";

export {
  buildCollectionMapping,
  buildGlobalMapping,
  buildJoinMappings,
  buildMappings,
  buildModelMapping,
  PrismaAdapterMappingError,
} from "./mapping/build.js";
export type {
  FieldMapping,
  JoinFieldMapping,
  ModelMapping,
  PrismaFieldMapping,
  PrismaGlobalMapping,
  PrismaModelMapping,
  PrismaOrderByInput,
  RelationFieldMapping,
  ScalarFieldMapping,
} from "./mapping/types.js";

export { loadDatamodel, PrismaAdapterSchemaError } from "./schema/load.js";
export type { SchemaSource } from "./schema/load.js";
export { parsePrismaSchema } from "./schema/parseSchema.js";
export type { Datamodel, DatamodelField, DatamodelModel } from "./schema/datamodel.js";

export { PrismaAdapterQueryError } from "./query/where.js";
export type { PrismaClientLike } from "./operations.js";

declare module "payload" {
  /**
   * Types the `custom.prisma` slot. Augmenting Payload's open `*Custom`
   * interfaces keeps a mapped config an ordinary Payload config while making a
   * typo in `model` a compile error.
   */
  export interface CollectionCustom {
    prisma?: import("./mapping/types.js").PrismaModelMapping;
  }

  export interface GlobalCustom {
    prisma?: import("./mapping/types.js").PrismaGlobalMapping;
  }

  export interface FieldCustom {
    prisma?: import("./mapping/types.js").PrismaFieldMapping;
  }
}
