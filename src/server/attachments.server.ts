import { basename, extname, join } from "node:path";
import type { SessionAttachment } from "~/shared/shelleport";
import { ApiError } from "~/server/api-error.server";
import { createId } from "~/server/id.server";

/** Maximum number of attachments per message. */
export const MAX_ATTACHMENT_COUNT = 10;

/** Maximum size of a single attachment in bytes (25 MB). */
export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

/** Maximum total size of all attachments in a single message in bytes (50 MB). */
export const MAX_TOTAL_ATTACHMENT_SIZE = 50 * 1024 * 1024;

function sanitizeFilename(name: string) {
	const trimmed = basename(name).trim();
	const safeName = trimmed.replace(/[^A-Za-z0-9._-]/g, "-");
	return safeName.length > 0 ? safeName : "file";
}

function extensionForImageContentType(contentType: string) {
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

function detectImageContentType(bytes: Uint8Array): string | null {
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

	return null;
}

function resolveContentType(file: File, bytes: Uint8Array): string {
	const detected = detectImageContentType(bytes);
	if (detected) {
		return detected;
	}

	if (file.type && file.type.length > 0) {
		return file.type;
	}

	return "application/octet-stream";
}

function resolveExtension(contentType: string, originalName: string): string {
	const imageExt = extensionForImageContentType(contentType);
	if (imageExt) {
		return imageExt;
	}

	const ext = extname(originalName);
	if (ext.length > 0) {
		return ext;
	}

	return "";
}

function validateAttachmentFile(entry: FormDataEntryValue) {
	if (!(entry instanceof File)) {
		throw new ApiError(400, "invalid_attachment", "attachments must be files");
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

	if (entries.length > MAX_ATTACHMENT_COUNT) {
		throw new ApiError(
			400,
			"too_many_attachments",
			`Too many attachments: maximum is ${MAX_ATTACHMENT_COUNT} files per message`,
		);
	}

	const files = entries.map(validateAttachmentFile);
	const totalSize = files.reduce((sum, file) => sum + file.size, 0);

	for (const file of files) {
		if (file.size > MAX_ATTACHMENT_SIZE) {
			throw new ApiError(
				400,
				"attachment_too_large",
				`Attachment "${file.name}" exceeds the ${MAX_ATTACHMENT_SIZE / (1024 * 1024)} MB size limit`,
			);
		}
	}

	if (totalSize > MAX_TOTAL_ATTACHMENT_SIZE) {
		throw new ApiError(
			400,
			"attachments_total_too_large",
			`Total attachment size exceeds the ${MAX_TOTAL_ATTACHMENT_SIZE / (1024 * 1024)} MB limit`,
		);
	}

	const uploadDir = join(cwd, ".shelleport", "uploads", sessionId);
	await Bun.$`mkdir -p ${uploadDir}`.quiet();

	return Promise.all(
		files.map(async (file) => {
			const bytes = new Uint8Array(await file.arrayBuffer());
			const contentType = resolveContentType(file, bytes);
			const safeName = sanitizeFilename(file.name);
			const extension = resolveExtension(contentType, file.name);
			const baseName = extension.length > 0 ? safeName.slice(0, -extension.length) : safeName;
			const filename = `${baseName || "file"}-${createId()}${extension}`;
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
