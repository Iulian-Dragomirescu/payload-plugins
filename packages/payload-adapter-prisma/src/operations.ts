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

import type { ArrayFieldMapping, JoinFieldMapping, ModelMapping } from "./mapping/types.js";
import type { PrismaOrderBy } from "./query/sort.js";
import { buildOrderBy } from "./query/sort.js";
import type { PrismaWhere } from "./query/where.js";
import { buildWhere, mergeWhere } from "./query/where.js";
import { coercePrimaryKey } from "./schema/coerce.js";
import { buildInclude, toJoinPage, toPayloadDoc } from "./transform/read.js";
import type { PrismaRow } from "./transform/read.js";
import type { ExistingArrays, ExistingRows } from "./transform/write.js";
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

/**
 * Refuses a create the schema has already made impossible.
 *
 * A non-null column with no default and no field pointing at it means every
 * `create` fails. Prisma's own error names the column but neither the config nor
 * the missing mapping, and the adapter knew this at startup, where it logs a
 * warning. This is the same fact, raised where a save can show it.
 *
 * @param mapping - The collection's or global's mapping.
 * @throws {APIError} When a column cannot be filled in.
 */
function assertCreatable(mapping: ModelMapping): void {
  const missing = mapping.uncreatable;
  if (missing.length === 0) return;

  const one = missing.length === 1;
  throw new APIError(
    `[prisma-adapter] ${mapping.kind === "global" ? "Global" : "Collection"} ` +
      `"${mapping.slug}" cannot create a row. ` +
      `${missing.map((column) => `"${mapping.model}.${column}"`).join(", ")} ` +
      `${one ? "is" : "are"} non-null in schema.prisma with no default, and no field in the ` +
      `${mapping.kind} writes ${one ? "it" : "them"}.\n` +
      `Add a field for each, give the column a default, or make it optional. The adapter ` +
      `issues no DDL, so it cannot fill one in.`,
    500,
  );
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

/**
 * One join field's query, as Payload's `joins` argument carries it.
 *
 * Restated because `payload` types `JoinQuery` as a mapped type over the
 * generated collection slugs, which resolves to `never` in a package that has
 * no generated types.
 */
interface JoinFieldQuery {
  count?: boolean;
  limit?: number;
  page?: number;
  sort?: Sort;
  where?: Where;
}

/** A join mapping resolved against one request: the page it asked for. */
interface RequestedJoin {
  join: JoinFieldMapping;
  /** Rows per page. `0` is Payload's spelling of "every row". */
  limit: number;
  page: number;
  /** Whether the caller asked for `totalDocs`, which costs a count. */
  count: boolean;
  where: PrismaWhere | undefined;
  orderBy: PrismaOrderBy[];
}

/**
 * Resolves Payload's `joins` argument against a collection's join mappings.
 *
 * @param props - Input props.
 * @param props.context - The Prisma context.
 * @param props.mapping - The collection being read.
 * @param props.joins - Payload's `joins` argument, unnarrowed.
 * @returns One entry per join the caller asked for, empty when it asked for none.
 */
function requestedJoins(props: {
  context: PrismaContext;
  mapping: ModelMapping;
  joins: unknown;
}): RequestedJoin[] {
  const { context, mapping, joins } = props;
  if (mapping.joins.size === 0) return [];
  // `false` rather than an object turns every join off, which is what a GraphQL
  // request sends.
  if (joins === false || joins === null || typeof joins !== "object") return [];

  const requested: RequestedJoin[] = [];
  for (const [path, query] of Object.entries(joins as Record<string, unknown>)) {
    const join = mapping.joins.get(path);
    // `false` for one path is how access control says this caller may not read it.
    if (join === undefined || query === false || query === null || query === undefined) continue;
    const asked = (typeof query === "object" ? query : {}) as JoinFieldQuery;

    requested.push({
      join,
      limit: asked.limit ?? join.defaultLimit,
      page: asked.page ?? 1,
      count: asked.count === true,
      // Payload merges the field's own `where` in before the adapter sees it,
      // but `payload.db.find` can be called directly. ANDing it with itself
      // changes nothing, so it is applied rather than trusted.
      where: mergeWhere(
        buildWhere({ where: join.where, mapping: join.target, byModel: context.byModel }),
        buildWhere({ where: asked.where, mapping: join.target, byModel: context.byModel }),
      ),
      orderBy: buildOrderBy({
        sort: asked.sort ?? join.defaultSort,
        mapping: join.target,
        byModel: context.byModel,
      }),
    });
  }
  return requested;
}

/**
 * The read arguments every query shares.
 *
 * Joins ride along on the parent's own read rather than becoming one query per
 * row: a nested `include` takes `where`, `orderBy`, `skip` and `take`, so each
 * parent gets its own correctly paginated page out of a single round trip.
 *
 * @param mapping - The collection's mapping.
 * @param joins - The joins this request asked for.
 * @returns The `include`, or nothing when there is neither a relation nor a join.
 */
function readArgs(
  mapping: ModelMapping,
  joins: RequestedJoin[] = [],
): { include?: Record<string, unknown> } {
  const include: Record<string, unknown> = { ...buildInclude({ mapping }) };
  const counted: Record<string, unknown> = {};

  for (const { count, join, limit, orderBy, page, where } of joins) {
    include[join.prismaField] = {
      select: { [join.target.idField.name]: true },
      orderBy,
      ...(where !== undefined ? { where } : {}),
      // One row more than the page, so `hasNextPage` needs no second query.
      ...(limit > 0 ? { skip: (page - 1) * limit, take: limit + 1 } : {}),
    };
    // Filtered the same way the page is, or the total would not describe it.
    if (count) counted[join.prismaField] = where !== undefined ? { where } : true;
  }

  if (Object.keys(counted).length > 0) include._count = { select: counted };
  return Object.keys(include).length === 0 ? {} : { include };
}

/**
 * Moves the joined rows off a Prisma row and onto the Payload document.
 *
 * @param props - Input props.
 * @param props.row - The row Prisma returned, carrying the included children.
 * @param props.doc - The document to fill in, modified in place.
 * @param props.joins - The joins this request asked for.
 * @returns The same document.
 */
function withJoins(props: {
  row: PrismaRow;
  doc: Record<string, unknown>;
  joins: RequestedJoin[];
}): Record<string, unknown> {
  const { row, doc, joins } = props;
  if (joins.length === 0) return doc;

  const counts = (row._count ?? {}) as Record<string, unknown>;
  for (const { join, limit, count } of joins) {
    doc[join.path] = toJoinPage({
      rows: row[join.prismaField],
      idKey: join.target.idField.name,
      limit,
      ...(count ? { total: counts[join.prismaField] } : {}),
    });
  }
  return doc;
}

/** The nested select that reads one array's row ids, and its rows' rows. */
function arrayIdSelect(array: ArrayFieldMapping): Record<string, unknown> {
  const select: Record<string, unknown> = { [array.target.idField.name]: true };
  for (const nested of array.target.arrays.values()) {
    select[nested.prismaField] = arrayIdSelect(nested);
  }
  return { select };
}

/** Turns the pre-read's row into the ids each array holds, at every depth. */
function readArrayIds(props: { row: unknown; mapping: ModelMapping }): ExistingArrays {
  const { row, mapping } = props;
  const arrays: ExistingArrays = new Map();
  const source = (row ?? {}) as Record<string, unknown>;

  for (const [path, array] of mapping.arrays) {
    const rows = source[array.prismaField];
    // Absent rather than empty for an array the write did not touch, which must
    // not read as "this parent holds nothing".
    if (!Array.isArray(rows)) continue;

    const held: ExistingRows = new Map();
    for (const entry of rows as Record<string, unknown>[]) {
      held.set(
        String(entry[array.target.idField.name]),
        readArrayIds({ row: entry, mapping: array.target }),
      );
    }
    arrays.set(path, held);
  }
  return arrays;
}

/**
 * Reads the rows each array on this document currently holds.
 *
 * A write has to tell an edit from an insert, and the incoming id cannot: the
 * admin panel invents one for every new row. The rows the parent actually has
 * are the only thing that can, so they are read first.
 *
 * One query however deep the arrays nest, and ids only: the whole tree comes
 * back as nested selects on the parent's own row.
 *
 * @param props - Input props.
 * @param props.mapping - The collection's or global's mapping.
 * @param props.id - The parent row's primary key, already coerced.
 * @param props.data - What Payload submitted, so an array it left out is not read.
 * @returns The rows by array field name, empty when the write touches no array.
 */
async function currentArrayRows(props: {
  context: PrismaContext;
  mapping: ModelMapping;
  id: unknown;
  data: Record<string, unknown>;
}): Promise<ExistingArrays> {
  const { context, mapping, id, data } = props;

  const select: Record<string, unknown> = {};
  for (const [path, array] of mapping.arrays) {
    if (!(path in data)) continue;
    select[array.prismaField] = arrayIdSelect(array);
  }
  if (Object.keys(select).length === 0) return new Map();

  const row = await delegate(context, mapping).findFirst({
    where: { [mapping.idField.name]: id },
    select,
  });
  return readArrayIds({ row, mapping });
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
  const joins = requestedJoins({ context, mapping, joins: args.joins });

  const limit = args.limit ?? 10;
  const page = args.page ?? 1;
  // `pagination: false` and `limit: 0` both mean "everything", and Payload uses
  // them interchangeably depending on the caller.
  const unpaginated = args.pagination === false || limit === 0;

  const query: Record<string, unknown> = {
    ...readArgs(mapping, joins),
    orderBy,
    ...(filter !== undefined ? { where: filter } : {}),
    ...(unpaginated ? {} : { skip: (page - 1) * limit, take: limit }),
  };

  try {
    const rows = await model.findMany(query);
    const docs = rows.map((row) => withJoins({ row, doc: toPayloadDoc({ row, mapping }), joins }));

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
  const joins = requestedJoins({ context, mapping, joins: args.joins });

  try {
    const row = await model.findFirst({
      ...readArgs(mapping, joins),
      ...(filter !== undefined ? { where: filter } : {}),
    });
    return row === null ? null : withJoins({ row, doc: toPayloadDoc({ row, mapping }), joins });
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
  assertCreatable(mapping);

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
  const joins = requestedJoins({ context, mapping, joins: args.joins });

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

    const data = buildData({
      data: args.data,
      mapping,
      mode: "update",
      existing: await currentArrayRows({ context, mapping, id, data: args.data }),
    });

    const row = await model.update({
      ...readArgs(mapping, joins),
      where: { [mapping.idField.name]: id },
      data,
    });
    return withJoins({ row, doc: toPayloadDoc({ row, mapping }), joins });
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
  const joins = requestedJoins({ context, mapping, joins: args.joins });
  // An array's write depends on which rows the parent already has, so a mapping
  // with one has to build its data per document rather than once.
  const shared =
    mapping.arrays.size === 0
      ? buildData({ data: args.data, mapping, mode: "update" })
      : undefined;

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
      const id = row[mapping.idField.name];
      const result = await model.update({
        ...readArgs(mapping, joins),
        where: { [mapping.idField.name]: id },
        data:
          shared ??
          buildData({
            data: args.data,
            mapping,
            mode: "update",
            existing: await currentArrayRows({ context, mapping, id, data: args.data }),
          }),
      });
      if (args.returning !== false) {
        updated.push(withJoins({ row: result, doc: toPayloadDoc({ row: result, mapping }), joins }));
      }
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
      ...(args.joins !== undefined ? { joins: args.joins } : {}),
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
  assertCreatable(mapping);

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

    const id = existing[mapping.idField.name];
    const row = await model.update({
      ...readArgs(mapping),
      where: { [mapping.idField.name]: id },
      data: buildData({
        data: args.data,
        mapping,
        mode: "update",
        existing: await currentArrayRows({ context, mapping, id, data: args.data }),
      }),
    });
    return { ...toPayloadDoc({ row, mapping }), globalType: mapping.slug };
  } catch (error) {
    return rethrow(error, mapping);
  }
}
