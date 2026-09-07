import type { SanitizedCollectionConfig } from "payload";
import { describe, expect, it } from "vitest";

import { buildCollectionMapping } from "../mapping/build.js";
import { parsePrismaSchema } from "../schema/parseSchema.js";
import { buildInclude, toPayloadDoc } from "./read.js";
import type { ExistingArrays, ExistingRows } from "./write.js";
import { buildData } from "./write.js";

/**
 * An array's write is a three-way split against the rows the parent already
 * has: edit, insert, delete.
 *
 * The trap the whole thing turns on is in `existing`. Payload's admin panel
 * gives every new row a client-side ObjectId, so a row that has never been
 * saved arrives carrying an id that looks exactly like a real one. Trusting it
 * would key an insert on a placeholder, and against an `Int @id` it would not
 * even be a valid value.
 */

const datamodel = parsePrismaSchema({
  source: `
model Quiz {
  id      String       @id @default(cuid())
  title   String
  options QuizOption[]
}

model QuizOption {
  id       String  @id @default(cuid())
  label    String
  correct  Boolean @default(false)
  position Int     @default(0)
  quiz     Quiz    @relation(fields: [quizId], references: [id], onDelete: Cascade)
  quizId   String
  tag      Tag?    @relation(fields: [tagId], references: [id])
  tagId    String?
  hints    QuizHint[]
}

model Tag {
  id      Int          @id @default(autoincrement())
  label   String
  options QuizOption[]
}

model QuizHint {
  id       String     @id @default(cuid())
  text     String
  rank     Int        @default(0)
  option   QuizOption @relation(fields: [optionId], references: [id], onDelete: Cascade)
  optionId String
}

model Wheel {
  id       String    @id @default(cuid())
  name     String
  segments Segment[]
}

model Segment {
  id      Int    @id @default(autoincrement())
  label   String
  wheel   Wheel  @relation(fields: [wheelId], references: [id])
  wheelId String
}
`,
});

const mapping = buildCollectionMapping({
  datamodel,
  collection: {
    slug: "quizzes",
    custom: { prisma: { model: "Quiz" } },
    flattenedFields: [
      { name: "title", type: "text" },
      {
        name: "options",
        type: "array",
        custom: { prisma: { order: "position" } },
        flattenedFields: [
          { name: "label", type: "text" },
          { name: "correct", type: "checkbox" },
          { name: "tag", type: "relationship", relationTo: "tags" },
          { name: "id", type: "text" },
        ],
      },
    ],
  } as unknown as SanitizedCollectionConfig,
});

/** The rows one array holds, as the pre-read hands them over. */
const rows = (...ids: string[]): ExistingRows =>
  new Map(ids.map((id) => [id, new Map() as ExistingArrays]));

/** The child rows one quiz holds. */
const holding = (...ids: string[]): ExistingArrays => new Map([["options", rows(...ids)]]);

const create = (data: Record<string, unknown>) => buildData({ data, mapping, mode: "create" });
const update = (data: Record<string, unknown>, existing: ExistingArrays) =>
  buildData({ data, mapping, mode: "update", existing });

describe("reading an array", () => {
  it("includes the rows whole, ordered, with the id last", () => {
    // Whole rather than as ids, because the rows ARE the value. The primary key
    // ends the order so two rows sharing a position cannot swap between reads.
    expect(buildInclude({ mapping })?.options).toEqual({
      select: {
        id: true,
        label: true,
        correct: true,
        tagId: true,
      },
      orderBy: [{ position: "asc" }, { id: "asc" }],
    });
  });

  it("turns the rows into array entries, keeping their ids", () => {
    // The id has to survive the round trip or the next write cannot tell an
    // edit from an insert.
    const doc = toPayloadDoc({
      row: {
        id: "q1",
        title: "Colours",
        options: [
          { id: "o1", label: "Red", correct: true, tagId: 7 },
          { id: "o2", label: "Blue", correct: false, tagId: null },
        ],
      },
      mapping,
    });

    expect(doc.options).toEqual([
      { id: "o1", label: "Red", correct: true, tag: "7" },
      { id: "o2", label: "Blue", correct: false, tag: null },
    ]);
  });

  it("leaves the order column out of the document", () => {
    // Its value is the array's index. A second copy of that in the document
    // would be one more thing that can disagree.
    const doc = toPayloadDoc({
      row: { id: "q1", options: [{ id: "o1", label: "Red", position: 3 }] },
      mapping,
    });
    expect(doc.options).toEqual([{ id: "o1", label: "Red" }]);
  });

  it("drops the field when the read did not include the rows", () => {
    // A `select` that asked for columns only must not report an empty array,
    // which Payload would render as a quiz whose options were deleted.
    expect(toPayloadDoc({ row: { id: "q1", title: "Colours" }, mapping })).toEqual({
      id: "q1",
      title: "Colours",
    });
  });
});

describe("creating a parent with rows", () => {
  it("creates the rows with the parent, in one nested write", () => {
    expect(
      create({
        title: "Colours",
        options: [
          { id: "68f0…", label: "Red", correct: true },
          { id: "68f1…", label: "Blue" },
        ],
      }),
    ).toEqual({
      title: "Colours",
      options: {
        create: [
          { label: "Red", correct: true, position: 0 },
          { label: "Blue", position: 1 },
        ],
      },
    });
  });

  it("writes nothing for an empty array", () => {
    expect(create({ title: "Colours", options: [] })).toEqual({ title: "Colours" });
  });
});

describe("updating a parent's rows", () => {
  it("edits a row the parent already has, in place", () => {
    // In place rather than delete-and-recreate: anything pointing at the row
    // keeps pointing at it.
    expect(
      update({ options: [{ id: "o1", label: "Crimson" }] }, holding("o1", "o2")),
    ).toEqual({
      options: {
        deleteMany: { id: { notIn: ["o1"] } },
        update: [{ where: { id: "o1" }, data: { label: "Crimson", position: 0 } }],
      },
    });
  });

  it("drops the id the admin panel invented for a new row", () => {
    // `507f1f…` is a client-side ObjectId. Keying an insert on it would put a
    // placeholder in the primary key.
    expect(
      update(
        { options: [{ id: "o1", label: "Red" }, { id: "507f1f77bcf86cd799439011", label: "Green" }] },
        holding("o1"),
      ),
    ).toEqual({
      options: {
        deleteMany: { id: { notIn: ["o1"] } },
        update: [{ where: { id: "o1" }, data: { label: "Red", position: 0 } }],
        create: [{ label: "Green", position: 1 }],
      },
    });
  });

  it("deletes the rows the editor left out", () => {
    // A delete rather than a disconnect, so nothing is written into
    // `QuizOption.quizId`, which is non-null.
    const write = update({ options: [{ id: "o2", label: "Blue" }] }, holding("o1", "o2", "o3"));
    expect((write.options as { deleteMany: unknown }).deleteMany).toEqual({
      id: { notIn: ["o2"] },
    });
  });

  it("deletes every row when the array is emptied", () => {
    expect(update({ options: [] }, holding("o1", "o2"))).toEqual({
      options: { deleteMany: {} },
    });
  });

  it("reads null as an emptied array", () => {
    expect(update({ options: null }, holding("o1"))).toEqual({ options: { deleteMany: {} } });
  });

  it("refuses a value that is not a list", () => {
    // Reading it as empty would delete every row the parent has, on a payload
    // the adapter did not understand.
    expect(() => update({ options: "Red" }, holding("o1", "o2"))).toThrow(/takes a list of rows/);
  });

  it("assigns the position from the array's order, not from the row", () => {
    // The submitted order IS the order. A row carrying a stale position from a
    // previous read would otherwise undo the editor's drag.
    const write = update(
      {
        options: [
          { id: "o2", label: "Blue", position: 9 },
          { id: "o1", label: "Red", position: 4 },
        ],
      },
      holding("o1", "o2"),
    );
    expect((write.options as { update: { data: { position: number } }[] }).update).toEqual([
      { where: { id: "o2" }, data: { label: "Blue", position: 0 } },
      { where: { id: "o1" }, data: { label: "Red", position: 1 } },
    ]);
  });

  it("writes a relationship inside a row", () => {
    const write = update({ options: [{ id: "o1", label: "Red", tag: "7" }] }, holding("o1"));
    expect((write.options as { update: { data: unknown }[] }).update[0]?.data).toEqual({
      label: "Red",
      tag: { connect: { id: 7 } },
      position: 0,
    });
  });

  it("leaves an untouched array alone", () => {
    // A partial update must not read "absent" as "emptied".
    expect(update({ title: "Colours" }, holding("o1"))).toEqual({ title: "Colours" });
  });
});

describe("an array inside an array", () => {
  const nested = buildCollectionMapping({
    datamodel,
    collection: {
      slug: "quizzes",
      custom: { prisma: { model: "Quiz" } },
      flattenedFields: [
        { name: "title", type: "text" },
        {
          name: "options",
          type: "array",
          custom: { prisma: { order: "position" } },
          flattenedFields: [
            { name: "label", type: "text" },
            {
              name: "hints",
              type: "array",
              custom: { prisma: { order: "rank" } },
              flattenedFields: [{ name: "text", type: "text" }, { name: "id", type: "text" }],
            },
            { name: "id", type: "text" },
          ],
        },
      ],
    } as unknown as SanitizedCollectionConfig,
  });

  /** One option holding hints, as the pre-read hands it over. */
  const optionHolding = (option: string, ...hints: string[]): ExistingArrays =>
    new Map([["options", new Map([[option, new Map([["hints", rows(...hints)]])]])]]);

  it("reads the grandchildren on the same query", () => {
    // Prisma nests a `select` as far down as it is written, so depth costs no
    // extra round trip.
    const include = buildInclude({ mapping: nested })?.options as Record<string, unknown>;
    expect((include.select as Record<string, unknown>).hints).toEqual({
      select: { id: true, text: true },
      orderBy: [{ rank: "asc" }, { id: "asc" }],
    });
  });

  it("turns the grandchildren into nested array entries", () => {
    const doc = toPayloadDoc({
      row: {
        id: "q1",
        options: [{ id: "o1", label: "Red", hints: [{ id: "h1", text: "Warm" }] }],
      },
      mapping: nested,
    });
    expect(doc.options).toEqual([
      { id: "o1", label: "Red", hints: [{ id: "h1", text: "Warm" }] },
    ]);
  });

  it("scopes an existing id to the row it is inside", () => {
    // `h1` belongs to `o1`. Asking "does h1 exist" without saying where would
    // read a hint moved between options as an edit, and Prisma would refuse the
    // nested update because the row is not in that option's set.
    const write = buildData({
      data: {
        options: [
          { id: "o1", label: "Red", hints: [{ id: "h1", text: "Warmer" }] },
          { id: "o2", label: "Blue", hints: [{ id: "h1", text: "Cooler" }] },
        ],
      },
      mapping: nested,
      mode: "update",
      existing: new Map([
        [
          "options",
          new Map([
            ["o1", new Map([["hints", rows("h1")]])],
            ["o2", new Map([["hints", rows()]])],
          ]),
        ],
      ]),
    });

    const updates = (write.options as { update: { data: Record<string, unknown> }[] }).update;
    // Inside `o1`, `h1` is an edit.
    expect(updates[0]?.data.hints).toEqual({
      deleteMany: { id: { notIn: ["h1"] } },
      update: [{ where: { id: "h1" }, data: { text: "Warmer", rank: 0 } }],
    });
    // Inside `o2`, the same id is a stranger, so it is a new hint.
    expect(updates[1]?.data.hints).toEqual({
      deleteMany: {},
      create: [{ text: "Cooler", rank: 0 }],
    });
  });

  it("creates the grandchildren of a brand new row", () => {
    // A row that does not exist holds nothing, so everything under it is a
    // create however deep it goes.
    const write = buildData({
      data: { options: [{ label: "Green", hints: [{ text: "Leafy" }] }] },
      mapping: nested,
      mode: "update",
      existing: optionHolding("o1"),
    });

    expect((write.options as { create: unknown[] }).create).toEqual([
      { label: "Green", position: 0, hints: { create: [{ text: "Leafy", rank: 0 }] } },
    ]);
  });

  it("creates the whole tree with the parent", () => {
    expect(
      buildData({
        data: {
          title: "Colours",
          options: [{ label: "Red", hints: [{ text: "Warm" }, { text: "Fiery" }] }],
        },
        mapping: nested,
        mode: "create",
      }),
    ).toEqual({
      title: "Colours",
      options: {
        create: [
          {
            label: "Red",
            position: 0,
            hints: { create: [{ text: "Warm", rank: 0 }, { text: "Fiery", rank: 1 }] },
          },
        ],
      },
    });
  });

  it("deletes a grandchild the editor removed", () => {
    const write = buildData({
      data: { options: [{ id: "o1", label: "Red", hints: [] }] },
      mapping: nested,
      mode: "update",
      existing: optionHolding("o1", "h1", "h2"),
    });

    const updates = (write.options as { update: { data: Record<string, unknown> }[] }).update;
    expect(updates[0]?.data.hints).toEqual({ deleteMany: {} });
  });
});

describe("a child keyed on an Int", () => {
  const wheels = buildCollectionMapping({
    datamodel,
    collection: {
      slug: "wheels",
      custom: { prisma: { model: "Wheel" } },
      flattenedFields: [
        { name: "name", type: "text" },
        {
          name: "segments",
          type: "array",
          admin: { isSortable: false },
          flattenedFields: [{ name: "label", type: "text" }, { name: "id", type: "text" }],
        },
      ],
    } as unknown as SanitizedCollectionConfig,
  });

  it("coerces a kept id back to the column's type", () => {
    // Ids are strings above the adapter whatever the column is. Prisma will not
    // convert, so `"3"` would match no row.
    expect(
      buildData({
        data: { segments: [{ id: "3", label: "Win" }] },
        mapping: wheels,
        mode: "update",
        existing: new Map([["segments", rows("3")]]),
      }),
    ).toEqual({
      segments: {
        deleteMany: { id: { notIn: [3] } },
        update: [{ where: { id: 3 }, data: { label: "Win" } }],
      },
    });
  });

  it("writes no position when the field is not sortable", () => {
    expect(
      buildData({
        data: { segments: [{ label: "Win" }] },
        mapping: wheels,
        mode: "create",
      }),
    ).toEqual({ segments: { create: [{ label: "Win" }] } });
  });
});
