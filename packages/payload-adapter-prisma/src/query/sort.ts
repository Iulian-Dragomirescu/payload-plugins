import type { Sort } from "payload";

import type { ModelMapping } from "../mapping/types.js";
import { PrismaAdapterQueryError } from "./where.js";

/** A Prisma `orderBy` entry. */
export type PrismaOrderBy = Record<string, unknown>;

/**
 * Translates one sort token into a Prisma `orderBy` entry.
 *
 * @param props - Input props.
 * @param props.token - A field path, optionally prefixed with `-` for descending.
 * @param props.mapping - The collection's mapping.
 * @param props.byModel - Mappings by Prisma model, for dotted paths.
 * @returns The `orderBy` entry.
 */
function sortToken(props: {
  token: string;
  mapping: ModelMapping;
  byModel: Map<string, ModelMapping>;
}): PrismaOrderBy {
  const { token, mapping, byModel } = props;
  const descending = token.startsWith("-");
  const path = descending ? token.slice(1) : token;
  const direction = descending ? "desc" : "asc";

  const [head, ...rest] = path.split(".");
  if (head === undefined) return {};

  const field = mapping.fields.get(head);
  if (field === undefined) {
    throw new PrismaAdapterQueryError(
      `Cannot sort collection "${mapping.slug}" by "${path}": it is not a field that maps to ` +
        `a Prisma column.\nSortable fields: ${[...mapping.fields.keys()].join(", ")}.`,
    );
  }

  if (rest.length > 0) {
    if (field.kind !== "relation") {
      throw new PrismaAdapterQueryError(
        `Cannot sort collection "${mapping.slug}" by "${path}": "${head}" is a scalar column.`,
      );
    }
    if (field.isList) {
      throw new PrismaAdapterQueryError(
        `Cannot sort collection "${mapping.slug}" by "${path}": "${head}" is to-many, and a ` +
          `row has many values for it, so there is no single one to order by.`,
      );
    }
    const target = byModel.get(field.targetModel.name);
    if (target === undefined) {
      throw new PrismaAdapterQueryError(
        `Cannot sort collection "${mapping.slug}" by "${path}": no collection maps onto ` +
          `"${field.targetModel.name}", so its field names are unknown here.`,
      );
    }
    return {
      [field.prismaField]: sortToken({ token: `${descending ? "-" : ""}${rest.join(".")}`, mapping: target, byModel }),
    };
  }

  if (field.kind === "relation") {
    // A relation has no scalar to order by except its own foreign key.
    if (field.ownsForeignKey && field.foreignKey !== undefined) {
      return { [field.foreignKey]: direction };
    }
    throw new PrismaAdapterQueryError(
      `Cannot sort collection "${mapping.slug}" by "${path}": it is a relationship whose key ` +
        `lives on the other model.\nSort by a property of it instead — "${path}.someField".`,
    );
  }

  return { [field.prismaField]: direction };
}

/**
 * Translates Payload's `sort` into a Prisma `orderBy`.
 *
 * Always ends with the primary key. Without a unique tiebreaker, two rows with
 * the same `publishedAt` can come back in either order on either request, and
 * page two of a list view then repeats or skips whatever fell on the boundary.
 *
 * @param props - Input props.
 * @param props.sort - Payload's sort, one token or several.
 * @param props.mapping - The collection's mapping.
 * @param props.byModel - Mappings by Prisma model, for dotted paths.
 * @returns The `orderBy` array.
 *
 * @example
 * ```ts
 * buildOrderBy({ sort: "-publishedAt", mapping, byModel });
 * // → [{ publishedAt: "desc" }, { id: "asc" }]
 * ```
 */
export function buildOrderBy(props: {
  sort: Sort | undefined;
  mapping: ModelMapping;
  byModel: Map<string, ModelMapping>;
}): PrismaOrderBy[] {
  const { sort, mapping, byModel } = props;
  const tokens = sort === undefined ? [] : Array.isArray(sort) ? sort : [sort];

  const entries = tokens
    .filter((token) => typeof token === "string" && token.length > 0)
    .map((token) => sortToken({ token, mapping, byModel }))
    .filter((entry) => Object.keys(entry).length > 0);

  const idKey = mapping.idField.name;
  const alreadyDeterministic = entries.some((entry) => Object.keys(entry)[0] === idKey);
  return alreadyDeterministic ? entries : [...entries, { [idKey]: "asc" }];
}
