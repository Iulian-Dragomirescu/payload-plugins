import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CollectionConfig } from "payload";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The media library, mapped onto `MediaAsset`. Files on disk, rows in Postgres.
 *
 * An upload collection is the one case where Payload adds a long list of fields
 * you did not write: `url`, `thumbnailURL`, `filename`, `mimeType`, `filesize`,
 * `width`, `height`, `focalX`, `focalY`, and a `sizes` group per configured
 * image size. None of them is virtual, so each needs a column in
 * `schema.prisma`. Miss one and the adapter says so at startup, naming it.
 *
 * Leaving off `custom.prisma` is the alternative, and a legitimate one: the
 * collection then behaves identically and its rows go to the internal database,
 * the way {@link ./Admins!Admins} does. The cost is that no mapped collection
 * can point at it, because a relationship across the two stores has no foreign
 * key to travel over.
 */
export const Media: CollectionConfig = {
	slug: "media",
	custom: { prisma: { model: "MediaAsset" } },
	admin: {
		description:
			"Mapped onto the MediaAsset model. The files live under apps/blog/media.",
	},
	upload: {
		// Used verbatim, so a relative path would resolve against `process.cwd()`
		// and land somewhere different under `next dev` than under the test runner.
		staticDir: path.resolve(dirname, "../../media"),
		mimeTypes: ["image/*"],
		// What fills the `sizes` column. Generating them needs `sharp`, which
		// `payload.config.ts` passes in.
		imageSizes: [
			{ name: "thumbnail", width: 400, height: 300, position: "centre" },
			{ name: "card", width: 768, height: 1024, position: "centre" },
		],
	},

	fields: [{ name: "alt", type: "text" }],
};
