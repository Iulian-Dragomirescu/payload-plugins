import type {
  CountArgs,
  CreateArgs,
  DeleteManyArgs,
  DeleteOneArgs,
  Document,
  FindArgs,
  FindOneArgs,
  PaginatedDistinctDocs,
  PaginatedDocs,
  Sort,
  UpdateManyArgs,
  UpdateOneArgs,
  UpsertArgs,
  Where,
} from "payload";
import { APIError, ValidationError } from "payload";

import type { ModelMapping } from "./mapping/types.js";
import { buildOrderBy } from "./query/sort.js";
import type { PrismaWhere } from "./query/where.js";
import { buildWhere, mergeWhere } from "./query/where.js";
import { coercePrimaryKey } from "./schema/coerce.js";
import { buildInclude, toPayloadDoc } from "./transform/read.js";
import type { PrismaRow } from "./transform/read.js";
import { buildData } from "./transform/write.js";

/**
 * The Prisma half of the adapter: one function per Payload database method.
 * Nothing here opens a connection or issues DDL.
 */

/**
 * Payload's `findDistinct` arguments. Restated because `payload` exports the
 * `FindDistinct` function type but not its argument object.
 */
export interface FindDistinctArgs {
  collection: string;
  field: string;
  limit?: number;
  page?: number;
  sort?: Sort;
  where?: Where;
}

/** The delegate methods this adapter calls on a `PrismaClient`. */
interface PrismaDelegate {
  count: (args: unknown) => Promise<number>;
  create: (args: unknown) => Promise<PrismaRow>;
  delete: (args: unknown) => Promise<PrismaRow>;
  deleteMany: (args: unknown) => Promise<{ count: number }>;
  findFirst: (args: unknown) => Promise<null | PrismaRow>;
  findMany: (args: unknown) => Promise<PrismaRow[]>;
  update: (args: unknown) => Promise<PrismaRow>;
}

/**
 * A generated Prisma client. Not narrowed: the constraint worth having, "has a
 * delegate for every mapped model", needs the schema to express. Delegates are
 * looked up by name instead, and a missing one is a clear error.
 */
export type PrismaClientLike = object;

/** Everything the operations need, resolved once at startup. */
export interface PrismaContext {
  /** The app's Prisma client. */
  prisma: PrismaClientLike;
  /** Mappings by Payload collection slug. */
  mappings: Map<string, ModelMapping>;
  /** Mappings by Payload global slug. */
  globals: Map<string, ModelMapping>;
  /** Collection mappings by Prisma model name, for dotted query paths. */
  byModel: Map<string, ModelMapping>;
}

/** Resolves the mapping for a collection, or fails loudly. */
function require_(context: PrismaContext, slug: string): ModelMapping {
  const mapping = context.mappings.get(slug);
  if (mapping === undefined) {
    throw new APIError(
      `[prisma-adapter] Collection "${slug}" is not backed by Prisma, so it should not have ` +
        `reached the Prisma half of the adapter. This is a bug in payload-adapter-prisma.`,
      500,
    );
  }
  return mapping;
}

/** Resolves the mapping for a global, or fails loudly. */
function requireGlobal(context: PrismaContext, slug: string): ModelMapping {
  const mapping = context.globals.get(slug);
  if (mapping === undefined) {
    throw new APIError(
      `[prisma-adapter] Global "${slug}" is not backed by Prisma, so it should not have ` +
        `reached the Prisma half of the adapter. This is a bug in payload-adapter-prisma.`,
      500,
    );
  }
  return mapping;
}

/** Resolves the delegate for a mapping, or explains why it is missing. */
function delegate(context: PrismaContext, mapping: ModelMapping): PrismaDelegate {
  const found = (context.prisma as Record<string, unknown>)[mapping.delegate];
  if (found === undefined || typeof found !== "object") {
    throw new APIError(
      `[prisma-adapter] The Prisma client has no \`${mapping.delegate}\` delegate for model ` +
        `"${mapping.model}", which collection "${mapping.slug}" maps onto.\n` +
        `Run \`prisma generate\` — the schema and the generated client have drifted.`,
      500,
    );
  }
  return found as unknown as PrismaDelegate;
}

/** The read arguments every query shares. */
function readArgs(mapping: ModelMapping): { include?: Record<string, unknown> } {
  const include = buildInclude({ mapping });
  return include === undefined ? {} : { include };
}

/**
 * Turns a Prisma error into one Payload can present.
 *
 * A unique violation becomes a `ValidationError` so the admin panel marks the
 * offending field instead of showing a stack trace.
 *
 * @param error - Whatever Prisma threw.
 * @param mapping - The collection it was thrown for.
 * @returns Never, it always throws.
 */
function rethrow(error: unknown, mapping: ModelMapping): never {
  const code = (error as { code?: string }).code;
  const meta = (error as { meta?: Record<string, unknown> }).meta;

  if (code === "P2002") {
    const columns = Array.isArray(meta?.target) ? (meta.target as string[]) : [];
    const paths = columns.map((column) => {
      for (const [path, field] of mapping.fields) {
        if (field.prismaField === column) return path;
      }
      return column;
    });
    throw new ValidationError({
      collection: mapping.slug,
      errors: (paths.length > 0 ? paths : ["id"]).map((path) => ({
        message: "A document with this value already exists.",
        path,
      })),
    });
  }

  if (code === "P2003") {
    throw new APIError(
      `[prisma-adapter] The database refused this write because of a foreign key on ` +
        `"${mapping.model}"${typeof meta?.field_name === "string" ? ` (${meta.field_name})` : ""}.\n` +
        `Referential integrity is your schema's, not the adapter's — a row another table ` +
        `points at cannot be deleted unless the relation declares \`onDelete: Cascade\`.`,
      400,
    );
  }

  if (code === "P2025") {
    throw new APIError(`[prisma-adapter] No "${mapping.slug}" document matched.`, 404);
  }

  throw error;
}

/** Builds the Prisma `where` for a Payload query, failing loudly if it cannot. */
function where(
  context: PrismaContext,
  mapping: ModelMapping,
  input: Parameters<typeof buildWhere>[0]["where"],
): PrismaWhere | undefined {
  return buildWhere({ where: input, mapping, byModel: context.byModel });
}

/**
 * Finds a page of documents.
 *
 * @param context - The Prisma context.
 * @param args - Payload's find arguments.
 * @returns A page of documents, in Payload's pagination envelope.
 */
export async function find(context: PrismaContext, args: FindArgs): Promise<PaginatedDocs> {
  const mapping = require_(context, args.collection);
  const model = delegate(context, mapping);

  const filter = where(context, mapping, args.where);
  const orderBy = buildOrderBy({ sort: args.sort, mapping, byModel: context.byModel });

  const limit = args.limit ?? 10;
  const page = args.page ?? 1;
  // `pagination: false` and `limit: 0` both mean "everything", and Payload uses
  // them interchangeably depending on the caller.
  const unpaginated = args.pagination === false || limit === 0;

  const query: Record<string, unknown> = {
    ...readArgs(mapping),
    orderBy,
    ...(filter !== undefined ? { where: filter } : {}),
    ...(unpaginated ? {} : { skip: (page - 1) * limit, take: limit }),
  };

  try {
    const rows = await model.findMany(query);
    const docs = rows.map((row) => toPayloadDoc({ row, mapping }));

    if (unpaginated) {
      return {
        docs,
        hasNextPage: false,
        hasPrevPage: false,
        limit: docs.length,
        nextPage: null,
        page: 1,
        pagingCounter: 1,
        prevPage: null,
        totalDocs: docs.length,
        totalPages: 1,
      };
    }

    const totalDocs = await model.count(filter !== undefined ? { where: filter } : {});
    const totalPages = limit > 0 ? Math.ceil(totalDocs / limit) : 1;

    return {
      docs,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
      limit,
      nextPage: page < totalPages ? page + 1 : null,
      page,
      pagingCounter: (page - 1) * limit + 1,
      prevPage: page > 1 ? page - 1 : null,
      totalDocs,
      totalPages,
    };
  } catch (error) {
    return rethrow(error, mapping);
  }
}

/**
 * Finds one document.
 *
 * @param context - The Prisma context.
 * @param args - Payload's findOne arguments.
 * @returns The document, or `null`.
 */
export async function findOne(
  context: PrismaContext,
  args: FindOneArgs,
): Promise<Document | null> {
  const mapping = require_(context, args.collection);
  const model = delegate(context, mapping);
  const filter = where(context, mapping, args.where);

  try {
    const row = await model.findFirst({
      ...readArgs(mapping),
      ...(filter !== undefined ? { where: filter } : {}),
    });
    return row === null ? null : toPayloadDoc({ row, mapping });
  } catch (error) {
    return rethrow(error, mapping);
  }
}

/**
 * Counts documents.
 *
 * @param context - The Prisma context.
 * @param args - Payload's count arguments.
 * @returns The total.
 */
export async function count(
  context: PrismaContext,
  args: CountArgs,
): Promise<{ totalDocs: number }> {
  const mapping = require_(context, args.collection);
  const model = delegate(context, mapping);
  const filter = where(context, mapping, args.where);

  try {
    return { totalDocs: await model.count(filter !== undefined ? { where: filter } : {}) };
  } catch (error) {
    return rethrow(error, mapping);
  }
}

/**
 * Lists the distinct values of one field, for the admin panel's filter
 * dropdowns.
 *
 * @param context - The Prisma context.
 * @param args - Payload's findDistinct arguments.
 * @returns The distinct values, in Payload's pagination envelope.
 */
export async function findDistinct(
  context: PrismaContext,
  args: FindDistinctArgs,
): Promise<PaginatedDistinctDocs<Record<string, unknown>>> {
  const mapping = require_(context, args.collection);
  const model = delegate(context, mapping);

  const field = mapping.fields.get(args.field);
  if (field === undefined || field.kind !== "scalar") {
    throw new APIError(
      `[prisma-adapter] Cannot list distinct values of "${args.field}" on "${args.collection}": ` +
        `it is ${field === undefined ? "not a mapped field" : "a relationship"}.`,
      400,
    );
  }

  const filter = where(context, mapping, args.where);
  const limit = args.limit ?? 0;
  const page = args.page ?? 1;

  try {
    const rows = await model.findMany({
      distinct: [field.prismaField],
      select: { [field.prismaField]: true },
      orderBy: buildOrderBy({ sort: args.sort ?? args.field, mapping, byModel: context.byModel })
        // Ordering by the primary key would defeat `distinct`, since every row
        // has a different one. The field itself is the only stable order here.
        .filter((entry) => Object.keys(entry)[0] === field.prismaField),
      ...(filter !== undefined ? { where: filter } : {}),
    });

    const values = rows.map((row) => ({ [args.field]: row[field.prismaField] }));
    const paged = limit > 0 ? values.slice((page - 1) * limit, page * limit) : values;
    const totalPages = limit > 0 ? Math.ceil(values.length / limit) : 1;

    return {
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
      limit,
      nextPage: page < totalPages ? page + 1 : null,
      page,
      pagingCounter: limit > 0 ? (page - 1) * limit + 1 : 1,
      prevPage: page > 1 ? page - 1 : null,
      totalDocs: values.length,
      totalPages,
      values: paged,
    };
  } catch (error) {
    return rethrow(error, mapping);
  }
}

/**
 * Creates a document.
 *
 * @param context - The Prisma context.
 * @param args - Payload's create arguments.
 * @returns The created document.
 */
export async function create(context: PrismaContext, args: CreateArgs): Promise<Document> {
  const mapping = require_(context, args.collection);
  const model = delegate(context, mapping);

  const data = buildData({
    data: args.customID === undefined ? args.data : { ...args.data, id: args.customID },
    mapping,
    mode: "create",
  });

  try {
    const row = await model.create({ ...readArgs(mapping), data });
    return toPayloadDoc({ row, mapping });
  } catch (error) {
    return rethrow(error, mapping);
  }
}

/**
 * Updates one document, by id or by query.
 *
 * @param context - The Prisma context.
 * @param args - Payload's updateOne arguments.
 * @returns The updated document.
 */
export async function updateOne(context: PrismaContext, args: UpdateOneArgs): Promise<Document> {
  const mapping = require_(context, args.collection);
  const model = delegate(context, mapping);
  const data = buildData({ data: args.data, mapping, mode: "update" });

  try {
    // Prisma's `update` takes a unique `where`, so a query-shaped update has to
    // find the row first. Two round trips, not one.
    const id =
      args.id !== undefined
        ? coercePrimaryKey({ value: args.id, field: mapping.idField })
        : await (async (): Promise<unknown> => {
            const filter = where(context, mapping, args.where);
            const row = await model.findFirst({
              select: { [mapping.idField.name]: true },
              ...(filter !== undefined ? { where: filter } : {}),
            });
            if (row === null) {
              throw new APIError(`[prisma-adapter] No "${mapping.slug}" document matched.`, 404);
            }
            return row[mapping.idField.name];
          })();

    const row = await model.update({
      ...readArgs(mapping),
      where: { [mapping.idField.name]: id },
      data,
    });
    return toPayloadDoc({ row, mapping });
  } catch (error) {
    return rethrow(error, mapping);
  }
}

/**
 * Updates every document matching a query.
 *
 * @param context - The Prisma context.
 * @param args - Payload's updateMany arguments.
 * @returns The updated documents, or `null` when the caller does not want them.
 */
export async function updateMany(
  context: PrismaContext,
  args: UpdateManyArgs,
): Promise<Document[] | null> {
  const mapping = require_(context, args.collection);
  const model = delegate(context, mapping);
  const filter = where(context, mapping, args.where);
  const data = buildData({ data: args.data, mapping, mode: "update" });

  try {
    // Prisma's `updateMany` takes no nested relation writes, so the rows are
    // resolved first and updated one at a time. The alternative is silently
    // dropping the relation from a bulk edit.
    const rows = await model.findMany({
      select: { [mapping.idField.name]: true },
      ...(filter !== undefined ? { where: filter } : {}),
      ...(args.limit !== undefined && args.limit > 0 ? { take: args.limit } : {}),
      orderBy: buildOrderBy({ sort: args.sort, mapping, byModel: context.byModel }),
    });

    const updated: Document[] = [];
    for (const row of rows) {
      const result = await model.update({
        ...readArgs(mapping),
        where: { [mapping.idField.name]: row[mapping.idField.name] },
        data,
      });
      if (args.returning !== false) updated.push(toPayloadDoc({ row: result, mapping }));
    }
    return args.returning === false ? null : updated;
  } catch (error) {
    return rethrow(error, mapping);
  }
}

/**
 * Creates a document, or updates the one matching a query.
 *
 * @param context - The Prisma context.
 * @param args - Payload's upsert arguments.
 * @returns The written document.
 */
export async function upsert(context: PrismaContext, args: UpsertArgs): Promise<Document> {
  const mapping = require_(context, args.collection);
  const model = delegate(context, mapping);
  const filter = where(context, mapping, args.where);

  try {
    const existing = await model.findFirst({
      select: { [mapping.idField.name]: true },
      ...(filter !== undefined ? { where: filter } : {}),
    });

    if (existing === null) {
      return await create(context, { collection: args.collection, data: args.data });
    }
    return await updateOne(context, {
      collection: args.collection,
      data: args.data,
      id: existing[mapping.idField.name] as number | string,
    });
  } catch (error) {
    return rethrow(error, mapping);
  }
}

/**
 * Deletes one document.
 *
 * @param context - The Prisma context.
 * @param args - Payload's deleteOne arguments.
 * @returns The document as it was before deletion.
 */
export async function deleteOne(context: PrismaContext, args: DeleteOneArgs): Promise<Document> {
  const mapping = require_(context, args.collection);
  const model = delegate(context, mapping);
  const filter = where(context, mapping, args.where);

  try {
    // Read it first: Payload's delete returns the deleted document, and once
    // the row is gone its relations cannot be read back.
    const row = await model.findFirst({
      ...readArgs(mapping),
      ...(filter !== undefined ? { where: filter } : {}),
    });
    if (row === null) {
      throw new APIError(`[prisma-adapter] No "${mapping.slug}" document matched.`, 404);
    }
    const doc = toPayloadDoc({ row, mapping });
    await model.delete({ where: { [mapping.idField.name]: row[mapping.idField.name] } });
    return doc;
  } catch (error) {
    return rethrow(error, mapping);
  }
}

/**
 * Deletes every document matching a query.
 *
 * @param context - The Prisma context.
 * @param args - Payload's deleteMany arguments.
 */
export async function deleteMany(context: PrismaContext, args: DeleteManyArgs): Promise<void> {
  const mapping = require_(context, args.collection);
  const model = delegate(context, mapping);
  const filter = where(context, mapping, args.where);

  try {
    await model.deleteMany(filter !== undefined ? { where: filter } : {});
  } catch (error) {
    rethrow(error, mapping);
  }
}

/**
 * Reads a global's row: the first row by primary key, narrowed by
 * `custom.prisma.where` when one table holds several singletons.
 *
 * `null` for an empty table is not an error: Payload reads it as "not saved
 * yet" and calls {@link createGlobal} on the first save.
 *
 * @param context - The Prisma context.
 * @param args - Payload's findGlobal arguments.
 * @returns The document, or `null` when the table has no row yet.
 */
export async function findGlobal(
  context: PrismaContext,
  args: { slug: string; where?: Where },
): Promise<Document | null> {
  const mapping = requireGlobal(context, args.slug);
  const model = delegate(context, mapping);

  // Payload passes `where` here for access control, so it is ANDed with the
  // singleton's own filter rather than ignored.
  const access = buildWhere({ where: args.where, mapping, byModel: context.byModel });
  const filter = mergeWhere(mapping.singleton, access);

  try {
    const row = await model.findFirst({
      ...readArgs(mapping),
      orderBy: [{ [mapping.idField.name]: "asc" }],
      ...(filter !== undefined ? { where: filter } : {}),
    });
    if (row === null) return null;
    return { ...toPayloadDoc({ row, mapping }), globalType: mapping.slug };
  } catch (error) {
    return rethrow(error, mapping);
  }
}

/**
 * Creates a global's row, on the first save of a global that had none.
 *
 * @param context - The Prisma context.
 * @param args - Payload's createGlobal arguments.
 * @returns The created document.
 */
export async function createGlobal(
  context: PrismaContext,
  args: { slug: string; data: Record<string, unknown> },
): Promise<Document> {
  const mapping = requireGlobal(context, args.slug);
  const model = delegate(context, mapping);

  const data = buildData({ data: args.data, mapping, mode: "create" });

  try {
    const row = await model.create({
      ...readArgs(mapping),
      // The discriminator has to be written, or the row created here is not the
      // row the next read finds.
      data: { ...data, ...(mapping.singleton ?? {}) },
    });
    return { ...toPayloadDoc({ row, mapping }), globalType: mapping.slug };
  } catch (error) {
    return rethrow(error, mapping);
  }
}

/**
 * Updates a global's row, creating it if the table is still empty.
 *
 * Payload only calls this after a read said the row exists, but between that
 * read and this write the row can be gone, so it falls back to creating rather
 * than failing the save.
 *
 * @param context - The Prisma context.
 * @param args - Payload's updateGlobal arguments.
 * @returns The written document.
 */
export async function updateGlobal(
  context: PrismaContext,
  args: { slug: string; data: Record<string, unknown> },
): Promise<Document> {
  const mapping = requireGlobal(context, args.slug);
  const model = delegate(context, mapping);

  try {
    const existing = await model.findFirst({
      select: { [mapping.idField.name]: true },
      orderBy: [{ [mapping.idField.name]: "asc" }],
      ...(mapping.singleton !== undefined ? { where: mapping.singleton } : {}),
    });

    if (existing === null) return await createGlobal(context, args);

    const row = await model.update({
      ...readArgs(mapping),
      where: { [mapping.idField.name]: existing[mapping.idField.name] },
      data: buildData({ data: args.data, mapping, mode: "update" }),
    });
    return { ...toPayloadDoc({ row, mapping }), globalType: mapping.slug };
  } catch (error) {
    return rethrow(error, mapping);
  }
}
