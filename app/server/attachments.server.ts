import { basename, join } from "node:path";
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
		default:
			return "";
	}
}

function isPng(bytes: Uint8Array) {
	return (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	);
}

function isJpeg(bytes: Uint8Array) {
	return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isGif(bytes: Uint8Array) {
	return (
		bytes.length >= 6 &&
		bytes[0] === 0x47 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x38 &&
		(bytes[4] === 0x37 || bytes[4] === 0x39) &&
		bytes[5] === 0x61
	);
}

function isWebp(bytes: Uint8Array) {
	return (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	);
}

function detectImageContentType(bytes: Uint8Array) {
	if (isJpeg(bytes)) {
		return "image/jpeg";
	}

	if (isPng(bytes)) {
		return "image/png";
	}

	if (isGif(bytes)) {
		return "image/gif";
	}

	if (isWebp(bytes)) {
		return "image/webp";
	}

	throw new ApiError(400, "unsupported_image_format", "Images must be JPEG, PNG, GIF, or WebP");
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
			const bytes = new Uint8Array(await file.arrayBuffer());
			const contentType = detectImageContentType(bytes);
			const safeName = sanitizeFilename(file.name);
			const extension = extensionForContentType(contentType);
			const baseName = extension.length > 0 ? safeName.slice(0, -extension.length) : safeName;
			const filename = `${baseName || "image"}-${createId()}${extension}`;
			const path = join(uploadDir, filename);
			await Bun.write(path, bytes);
			return {
				name: file.name || filename,
				path,
				contentType,
			};
		}),
	);
}
