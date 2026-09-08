import type { SanitizedCollectionConfig } from "payload";
import { describe, expect, it } from "vitest";

import { parsePrismaSchema } from "../schema/parseSchema.js";
import { buildCollectionMapping, PrismaAdapterMappingError } from "./build.js";

/**
 * An `array` maps onto a child table that already exists.
 *
 * The gate is the whole compatibility story: an array reaching a COLUMN keeps
 * its `Json` value, an array reaching a RELATION becomes rows. So every case
 * here also says which side of that line it is on.
 *
 * The failures worth catching at startup are the ones that would otherwise
 * arrive on a save the editor is halfway through: an order the schema has
 * nowhere to keep, a child column no row could ever fill in, a column two
 * writers both claim.
 */

const SCHEMA = `
model Quiz {
  id       String       @id @default(cuid())
  title    String
  options  QuizOption[]
  editor   Editor?      @relation(fields: [editorId], references: [id])
  editorId String?
  meta     Json?
}

model QuizOption {
  id       String  @id @default(cuid())
  label    String
  correct  Boolean @default(false)
  position Int     @default(0)
  hint     String?
  quiz     Quiz    @relation(fields: [quizId], references: [id], onDelete: Cascade)
  quizId   String
  tag      Tag?    @relation(fields: [tagId], references: [id])
  tagId    String?
  hints    QuizHint[]
}

model QuizHint {
  id       String     @id @default(cuid())
  text     String
  rank     Int        @default(0)
  option   QuizOption @relation(fields: [optionId], references: [id], onDelete: Cascade)
  optionId String
}

model Tag {
  id      String       @id @default(cuid())
  label   String
  options QuizOption[]
}

model Editor {
  id      String @id @default(cuid())
  name    String
  quizzes Quiz[]
}

model Sticker {
  id      String @id @default(cuid())
  label   String
  albums  Album[]
}

model Album {
  id       String    @id @default(cuid())
  name     String
  stickers Sticker[]
}

model Ledger {
  id      String       @id @default(cuid())
  name    String
  entries LedgerEntry[]
}

model LedgerEntry {
  id       String @id @default(cuid())
  amount   Int
  audited  Boolean
  ledger   Ledger @relation(fields: [ledgerId], references: [id])
  ledgerId String
}

model Vault {
  id    String      @id @default(cuid())
  name  String
  slots VaultSlot[]
}

model VaultSlot {
  id      String @id
  label   String
  vault   Vault  @relation(fields: [vaultId], references: [id])
  vaultId String
}
`;

const datamodel = parsePrismaSchema({ source: SCHEMA });

/** Resolves one collection, with the array's subfields already flattened. */
function map(props: { model?: string; slug?: string; fields: unknown[] }) {
  return buildCollectionMapping({
    datamodel,
    collection: {
      slug: props.slug ?? "quizzes",
      custom: { prisma: { model: props.model ?? "Quiz" } },
      flattenedFields: props.fields,
    } as unknown as SanitizedCollectionConfig,
  });
}

/** Payload appends an `id` subfield to every array, so the cases below do too. */
const ID = { name: "id", type: "text" };

describe("an array that resolves onto a child table", () => {
  const mapping = map({
    fields: [
      { name: "title", type: "text" },
      {
        name: "options",
        type: "array",
        custom: { prisma: { order: "position" } },
        flattenedFields: [
          { name: "label", type: "text" },
          { name: "correct", type: "checkbox" },
          ID,
        ],
      },
    ],
  });
  const array = mapping.arrays.get("options");

  it("resolves the relation, the child model and its primary key", () => {
    expect(array?.prismaField).toBe("options");
    expect(array?.target.model).toBe("QuizOption");
    expect(array?.target.idField.name).toBe("id");
  });

  it("finds the child's foreign key back at the parent", () => {
    // Nothing writes it directly: the nested `create` fills it in. It is here
    // because a field claiming it would be a second writer, and because its
    // absence would mean a many-to-many rather than a child.
    expect(array?.foreignKey).toBe("quizId");
  });

  it("carries the order column, which the write assigns from the index", () => {
    expect(array?.orderColumn).toBe("position");
  });

  it("maps the array's own subfields against the child model", () => {
    expect(array?.target.fields.get("label")?.prismaField).toBe("label");
    expect(array?.target.fields.get("correct")?.prismaField).toBe("correct");
  });

  it("keeps the array out of `fields`, so nothing treats it as a column", () => {
    // In `fields` it would be reachable by `buildWhere` and `buildOrderBy`,
    // neither of which has a column to work with.
    expect(mapping.fields.has("options")).toBe(false);
  });

  it("keeps the order column out of the document", () => {
    // Its value is the array's index, and Payload has nothing to do with a
    // second copy of that.
    expect(array?.target.fields.has("position")).toBe(false);
  });

  it("resolves a renamed relation through `custom.prisma.field`", () => {
    const renamed = map({
      fields: [
        {
          name: "answers",
          type: "array",
          custom: { prisma: { field: "options", order: "position" } },
          flattenedFields: [{ name: "label", type: "text" }, ID],
        },
      ],
    });
    expect(renamed.arrays.get("answers")?.prismaField).toBe("options");
  });

  it("takes a relationship inside a row", () => {
    const withRelation = map({
      fields: [
        {
          name: "options",
          type: "array",
          custom: { prisma: { order: "position" } },
          flattenedFields: [
            { name: "label", type: "text" },
            { name: "tag", type: "relationship", relationTo: "tags" },
            ID,
          ],
        },
      ],
    });
    const tag = withRelation.arrays.get("options")?.target.fields.get("tag");
    expect(tag?.kind === "relation" && tag.foreignKey).toBe("tagId");
  });
});

describe("an array inside an array", () => {
  const mapping = map({
    fields: [
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
            flattenedFields: [{ name: "text", type: "text" }, ID],
          },
          ID,
        ],
      },
    ],
  });
  const hints = mapping.arrays.get("options")?.target.arrays.get("hints");

  it("resolves against the grandchild model", () => {
    expect(hints?.target.model).toBe("QuizHint");
    expect(hints?.foreignKey).toBe("optionId");
    expect(hints?.orderColumn).toBe("rank");
  });

  it("hangs off the child's mapping, not the parent's", () => {
    // Which rows exist depends on WHICH option you are inside, so the nesting
    // has to survive into the mapping rather than being flattened by path.
    expect(mapping.arrays.has("hints")).toBe(false);
    expect(hints?.target.fields.get("text")?.prismaField).toBe("text");
  });
});

describe("an array that is not a child table", () => {
  it("keeps its `Json` column when the field names a column", () => {
    // The compatibility rule. An array that works today points at a column, and
    // must go on pointing at it.
    const mapping = map({
      fields: [
        {
          name: "meta",
          type: "array",
          flattenedFields: [{ name: "note", type: "text" }, ID],
        },
      ],
    });
    expect(mapping.arrays.size).toBe(0);
    expect(mapping.fields.get("meta")?.prismaField).toBe("meta");
  });

  it("refuses `order` on one, which has no column to keep it in", () => {
    expect(() =>
      map({
        fields: [
          {
            name: "meta",
            type: "array",
            custom: { prisma: { order: "position" } },
            flattenedFields: [{ name: "note", type: "text" }, ID],
          },
        ],
      }),
    ).toThrow(/a Json column[\s\S]*relations on "Quiz": options, editor/);
  });
});

describe("an array that does not resolve", () => {
  it("refuses a to-one relation, which holds one row rather than a list", () => {
    expect(() =>
      map({
        fields: [
          {
            name: "editor",
            type: "array",
            custom: { prisma: { order: "position" } },
            flattenedFields: [{ name: "name", type: "text" }, ID],
          },
        ],
      }),
    ).toThrow(/to-one relation[\s\S]*Use a `group`/);
  });

  it("names both fixes when nothing says where the order lives", () => {
    expect(() =>
      map({
        fields: [
          {
            name: "options",
            type: "array",
            flattenedFields: [{ name: "label", type: "text" }, ID],
          },
        ],
      }),
    ).toThrow(/names no column to keep the order in[\s\S]*position[\s\S]*isSortable: false/);
  });

  it("takes `admin.isSortable: false` as the other fix", () => {
    const mapping = map({
      fields: [
        {
          name: "options",
          type: "array",
          admin: { isSortable: false },
          flattenedFields: [{ name: "label", type: "text" }, ID],
        },
      ],
    });
    expect(mapping.arrays.get("options")?.orderColumn).toBeUndefined();
  });

  it("names the child's columns when `order` is not one of them", () => {
    expect(() =>
      map({
        fields: [
          {
            name: "options",
            type: "array",
            custom: { prisma: { order: "rank" } },
            flattenedFields: [{ name: "label", type: "text" }, ID],
          },
        ],
      }),
    ).toThrow(/not a column on "QuizOption"[\s\S]*label, correct, position/);
  });

  it("refuses an order column the index cannot be written into", () => {
    expect(() =>
      map({
        fields: [
          {
            name: "options",
            type: "array",
            custom: { prisma: { order: "label" } },
            flattenedFields: [{ name: "correct", type: "checkbox" }, ID],
          },
        ],
      }),
    ).toThrow(/which is a `String`[\s\S]*has to be numeric/);
  });

  it("refuses a many-to-many, whose rows other documents share", () => {
    // `deleteMany` on a row reached through a join table deletes the row, not
    // the link. A `relationship` disconnects instead, which is what is wanted.
    expect(() =>
      map({
        model: "Album",
        slug: "albums",
        fields: [
          {
            name: "stickers",
            type: "array",
            admin: { isSortable: false },
            flattenedFields: [{ name: "label", type: "text" }, ID],
          },
        ],
      }),
    ).toThrow(/many-to-many[\s\S]*hasMany: true/);
  });

  it("refuses a child whose id a nested create cannot supply", () => {
    // The parent's save is the only thing creating the row, and the id the
    // admin panel sends with it is a client-side placeholder.
    expect(() =>
      map({
        model: "Vault",
        slug: "vaults",
        fields: [
          {
            name: "slots",
            type: "array",
            admin: { isSortable: false },
            flattenedFields: [{ name: "label", type: "text" }, ID],
          },
        ],
      }),
    ).toThrow(/has no default[\s\S]*@default\(cuid\(\)\)/);
  });

  it("refuses a child column no row could fill in", () => {
    // A collection can be a read-only view, so there this is a warning. An
    // array is editable by definition, so here it is an error.
    expect(() =>
      map({
        model: "Ledger",
        slug: "ledgers",
        fields: [
          {
            name: "entries",
            type: "array",
            admin: { isSortable: false },
            flattenedFields: [{ name: "amount", type: "number" }, ID],
          },
        ],
      }),
    ).toThrow(/cannot add a row to "LedgerEntry"[\s\S]*"LedgerEntry.audited"/);
  });

  it("refuses a subfield that writes the foreign key", () => {
    expect(() =>
      map({
        fields: [
          {
            name: "options",
            type: "array",
            custom: { prisma: { order: "position" } },
            flattenedFields: [
              { name: "label", type: "text" },
              { name: "owner", type: "text", custom: { prisma: { field: "quizId" } } },
              ID,
            ],
          },
        ],
      }),
    ).toThrow(/"QuizOption.quizId", which the adapter writes itself/);
  });

  it("refuses a subfield that writes the order column", () => {
    expect(() =>
      map({
        fields: [
          {
            name: "options",
            type: "array",
            custom: { prisma: { order: "position" } },
            flattenedFields: [
              { name: "label", type: "text" },
              { name: "position", type: "number" },
              ID,
            ],
          },
        ],
      }),
    ).toThrow(/"QuizOption.position", which the adapter writes itself/);
  });

  it("takes a read-only subfield on the order column", () => {
    const mapping = map({
      fields: [
        {
          name: "options",
          type: "array",
          custom: { prisma: { order: "position" } },
          flattenedFields: [
            { name: "label", type: "text" },
            { name: "position", type: "number", custom: { prisma: { readOnly: true } } },
            ID,
          ],
        },
      ],
    });
    expect(mapping.arrays.get("options")?.target.fields.get("position")?.readOnly).toBe(true);
  });

  it("names the array in a subfield's own error", () => {
    expect(() =>
      map({
        fields: [
          {
            name: "options",
            type: "array",
            custom: { prisma: { order: "position" } },
            flattenedFields: [{ name: "caption", type: "text" }, ID],
          },
        ],
      }),
    ).toThrow(/field "options\.caption" maps to "QuizOption\.caption"/);
  });

  it("refuses an array over a to-one, at any depth", () => {
    // The nested case goes through the same builder, so the same checks run and
    // the message names the full path.
    expect(() =>
      map({
        fields: [
          {
            name: "options",
            type: "array",
            custom: { prisma: { order: "position" } },
            flattenedFields: [
              { name: "label", type: "text" },
              {
                name: "tags",
                type: "array",
                custom: { prisma: { field: "tag" } },
                flattenedFields: [{ name: "label", type: "text" }, ID],
              },
              ID,
            ],
          },
        ],
      }),
    ).toThrow(/field "options\.tags" is an `array`[\s\S]*to-one relation/);
  });

  it("raises a mapping error rather than any other kind", () => {
    expect(() =>
      map({
        fields: [
          {
            name: "options",
            type: "array",
            flattenedFields: [{ name: "label", type: "text" }, ID],
          },
        ],
      }),
    ).toThrow(PrismaAdapterMappingError);
  });
});
