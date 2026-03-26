import { basename, extname, join } from "node:path";
import type { SessionAttachment } from "~/lib/shelleport";
import { ApiError } from "~/server/api-error.server";
import { createId } from "~/server/id.server";

function sanitizeFilename(name: string) {
	const trimmed = basename(name).trim();
	const safeName = trimmed.replace(/[^A-Za-z0-9._-]/g, "-");
	return safeName.length > 0 ? safeName : "image";
}

function extensionForContentType(contentType: string) {
	switch (contentType) {
		case "image/jpeg":
			return ".jpg";
		case "image/png":
			return ".png";
		case "image/gif":
			return ".gif";
		case "image/webp":
			return ".webp";
		case "image/heic":
			return ".heic";
		default:
			return "";
	}
}

function validateImageFile(entry: FormDataEntryValue) {
	if (!(entry instanceof File)) {
		throw new ApiError(400, "invalid_image", "images must be files");
	}

	if (!entry.type.startsWith("image/")) {
		throw new ApiError(400, "invalid_image", "images must be image files");
	}

	return entry;
}

export async function storeSessionAttachments(
	sessionId: string,
	cwd: string,
	entries: FormDataEntryValue[],
): Promise<SessionAttachment[]> {
	if (entries.length === 0) {
		return [];
	}

	const uploadDir = join(cwd, ".shelleport", "uploads", sessionId);
	await Bun.$`mkdir -p ${uploadDir}`.quiet();

	return Promise.all(
		entries.map(async (entry) => {
			const file = validateImageFile(entry);
			const safeName = sanitizeFilename(file.name);
			const extension = extname(safeName) || extensionForContentType(file.type);
			const baseName = extension.length > 0 ? safeName.slice(0, -extension.length) : safeName;
			const filename = `${baseName || "image"}-${createId()}${extension}`;
			const path = join(uploadDir, filename);
			await Bun.write(path, file);
			return {
				name: file.name || filename,
				path,
				contentType: file.type,
			};
		}),
	);
}
