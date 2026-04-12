/**
 * Image resizing utilities.
 *
 * Uses Photon (Rust/WASM) for cross-platform image processing.
 * Handles automatic resizing to fit within LLM context limits and
 * applies EXIF orientation corrections.
 */

import type { ImageContent } from "@my-agent/ai";

/**
 * Options for image resizing.
 */
export interface ImageResizeOptions {
	/** Maximum width in pixels. Default: 2000 */
	maxWidth?: number;
	/** Maximum height in pixels. Default: 2000 */
	maxHeight?: number;
	/** Maximum base64 payload size in bytes. Default: 4.5MB (below Anthropic's 5MB limit) */
	maxBytes?: number;
	/** JPEG quality (1-100). Default: 80 */
	jpegQuality?: number;
}

/**
 * Result of image resizing.
 */
export interface ResizedImage {
	/** Base64 encoded image data */
	data: string;
	/** MIME type (image/png or image/jpeg) */
	mimeType: string;
	/** Original image width */
	originalWidth: number;
	/** Original image height */
	originalHeight: number;
	/** Resized image width */
	width: number;
	/** Resized image height */
	height: number;
	/** Whether the image was resized */
	wasResized: boolean;
}

// Default: 4.5MB provides headroom below Anthropic's 5MB limit
const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;

const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: DEFAULT_MAX_BYTES,
	jpegQuality: 80,
};

// Lazy-loaded photon module
let photonModule: typeof import("@silvia-odwyer/photon-node") | null = null;
let loadPromise: Promise<typeof import("@silvia-odwyer/photon-node") | null> | null = null;

/**
 * Load the Photon WASM module.
 */
async function loadPhoton(): Promise<typeof import("@silvia-odwyer/photon-node") | null> {
	if (photonModule) return photonModule;
	if (loadPromise) return loadPromise;

	loadPromise = (async () => {
		try {
			photonModule = await import("@silvia-odwyer/photon-node");
			return photonModule;
		} catch {
			photonModule = null;
			return null;
		}
	})();

	return loadPromise;
}

interface EncodedCandidate {
	data: string;
	encodedSize: number;
	mimeType: string;
}

function encodeCandidate(buffer: Uint8Array, mimeType: string): EncodedCandidate {
	const data = Buffer.from(buffer).toString("base64");
	return {
		data,
		encodedSize: Buffer.byteLength(data, "utf-8"),
		mimeType,
	};
}

/**
 * Read EXIF orientation from JPEG or WebP image.
 */
function getExifOrientation(bytes: Uint8Array): number {
	// JPEG: starts with FF D8
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		return readJpegOrientation(bytes);
	}

	// WebP: starts with RIFF....WEBP
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return readWebpOrientation(bytes);
	}

	return 1;
}

function readJpegOrientation(bytes: Uint8Array): number {
	let offset = 2;
	while (offset < bytes.length - 1) {
		if (bytes[offset] !== 0xff) return 1;
		const marker = bytes[offset + 1];
		if (marker === 0xff) {
			offset++;
			continue;
		}

		// Stop at SOS (Start of Scan) - no more metadata after this
		if (marker === 0xda) return 1;

		if (offset + 4 > bytes.length) return 1;
		const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];

		if (marker === 0xe1) {
			const segmentStart = offset + 4;
			if (segmentStart + 6 <= bytes.length) {
				// Check for "Exif\0\0"
				if (
					bytes[segmentStart] === 0x45 &&
					bytes[segmentStart + 1] === 0x78 &&
					bytes[segmentStart + 2] === 0x69 &&
					bytes[segmentStart + 3] === 0x66 &&
					bytes[segmentStart + 4] === 0x00 &&
					bytes[segmentStart + 5] === 0x00
				) {
					return readTiffOrientation(bytes, segmentStart + 6);
				}
			}
			// Not EXIF APP1, continue looking for more APP1 segments
		}

		offset += 2 + segmentLength;
	}

	return 1;
}

function readWebpOrientation(bytes: Uint8Array): number {
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		const chunkId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
		const chunkSize =
			bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
		const dataStart = offset + 8;

		if (chunkId === "EXIF") {
			if (dataStart + chunkSize > bytes.length) return 1;
			// Some WebP files have "Exif\0\0" prefix
			const hasExifHeader =
				bytes[dataStart] === 0x45 &&
				bytes[dataStart + 1] === 0x78 &&
				bytes[dataStart + 2] === 0x69 &&
				bytes[dataStart + 3] === 0x66;
			const tiffStart = hasExifHeader ? dataStart + 6 : dataStart;
			return readTiffOrientation(bytes, tiffStart);
		}

		offset = dataStart + chunkSize + (chunkSize % 2);
	}

	return 1;
}

function readTiffOrientation(bytes: Uint8Array, tiffStart: number): number {
	if (tiffStart + 8 > bytes.length) return 1;

	const byteOrder = (bytes[tiffStart] << 8) | bytes[tiffStart + 1];
	const le = byteOrder === 0x4949;

	const read16 = (pos: number): number => {
		if (le) return bytes[pos] | (bytes[pos + 1] << 8);
		return (bytes[pos] << 8) | bytes[pos + 1];
	};

	const read32 = (pos: number): number => {
		if (le) return bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24);
		return ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
	};

	const ifdOffset = read32(tiffStart + 4);
	const ifdStart = tiffStart + ifdOffset;
	if (ifdStart + 2 > bytes.length) return 1;

	const entryCount = read16(ifdStart);
	for (let i = 0; i < entryCount; i++) {
		const entryPos = ifdStart + 2 + i * 12;
		if (entryPos + 12 > bytes.length) return 1;

		if (read16(entryPos) === 0x0112) {
			const value = read16(entryPos + 8);
			return value >= 1 && value <= 8 ? value : 1;
		}
	}

	return 1;
}

type PhotonImage = ReturnType<typeof import("@silvia-odwyer/photon-node").PhotonImage.new_from_byteslice>;

/**
 * Apply EXIF orientation to a PhotonImage.
 */
function applyExifOrientation(
	photon: typeof import("@silvia-odwyer/photon-node"),
	image: PhotonImage,
	originalBytes: Uint8Array,
): PhotonImage {
	const orientation = getExifOrientation(originalBytes);
	if (orientation === 1) return image;

	const rotate90 = (
		dstIndex: (x: number, y: number, w: number, h: number) => number,
	): PhotonImage => {
		const w = image.get_width();
		const h = image.get_height();
		const src = image.get_raw_pixels();
		const dst = new Uint8Array(src.length);

		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const srcIdx = (y * w + x) * 4;
				const dstIdx = dstIndex(x, y, w, h) * 4;
				dst[dstIdx] = src[srcIdx];
				dst[dstIdx + 1] = src[srcIdx + 1];
				dst[dstIdx + 2] = src[srcIdx + 2];
				dst[dstIdx + 3] = src[srcIdx + 3];
			}
		}

		return new photon.PhotonImage(dst, h, w);
	};

	switch (orientation) {
		case 2:
			photon.fliph(image);
			return image;
		case 3:
			photon.fliph(image);
			photon.flipv(image);
			return image;
		case 4:
			photon.flipv(image);
			return image;
		case 5: {
			const rotated = rotate90((x, y, _w, h) => x * h + (h - 1 - y));
			photon.fliph(rotated);
			return rotated;
		}
		case 6:
			return rotate90((x, y, _w, h) => x * h + (h - 1 - y));
		case 7: {
			const rotated = rotate90((x, y, w, h) => (w - 1 - x) * h + y);
			photon.fliph(rotated);
			return rotated;
		}
		case 8:
			return rotate90((x, y, w, h) => (w - 1 - x) * h + y);
		default:
			return image;
	}
}

/**
 * Resize an image to fit within specified limits.
 *
 * Strategy:
 * 1. Resize to maxWidth/maxHeight
 * 2. Try both PNG and JPEG, pick smaller
 * 3. If still too large, decrease JPEG quality
 * 4. If still too large, progressively reduce dimensions
 *
 * @param img Image content with base64 data
 * @param options Resize options
 * @returns Resized image or null if unable to resize below limits
 */
export async function resizeImage(img: ImageContent, options?: ImageResizeOptions): Promise<ResizedImage | null> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const inputBuffer = Buffer.from(img.data, "base64");
	const inputBase64Size = Buffer.byteLength(img.data, "utf-8");

	const photon = await loadPhoton();
	if (!photon) {
		return null;
	}

	let image: PhotonImage | undefined;
	try {
		const inputBytes = new Uint8Array(inputBuffer);
		const rawImage = photon.PhotonImage.new_from_byteslice(inputBytes);
		image = applyExifOrientation(photon, rawImage, inputBytes);
		const exifApplied = image !== rawImage;
		if (exifApplied) rawImage.free();

		const originalWidth = image.get_width();
		const originalHeight = image.get_height();
		const format = img.mimeType?.split("/")[1] ?? "png";

		// Check if already within all limits and no EXIF correction was needed
		// If EXIF was applied, we must re-encode to bake in the orientation
		if (
			!exifApplied &&
			originalWidth <= opts.maxWidth &&
			originalHeight <= opts.maxHeight &&
			inputBase64Size < opts.maxBytes
		) {
			return {
				data: img.data,
				mimeType: img.mimeType ?? `image/${format}`,
				originalWidth,
				originalHeight,
				width: originalWidth,
				height: originalHeight,
				wasResized: false,
			};
		}

		// Calculate initial target dimensions
		let targetWidth = originalWidth;
		let targetHeight = originalHeight;

		if (targetWidth > opts.maxWidth) {
			targetHeight = Math.round((targetHeight * opts.maxWidth) / targetWidth);
			targetWidth = opts.maxWidth;
		}
		if (targetHeight > opts.maxHeight) {
			targetWidth = Math.round((targetWidth * opts.maxHeight) / targetHeight);
			targetHeight = opts.maxHeight;
		}

		function tryEncodings(width: number, height: number, jpegQualities: number[]): EncodedCandidate[] {
			const resized = photon!.resize(image!, width, height, photon!.SamplingFilter.Lanczos3);

			try {
				const candidates: EncodedCandidate[] = [encodeCandidate(resized.get_bytes(), "image/png")];
				for (const quality of jpegQualities) {
					candidates.push(encodeCandidate(resized.get_bytes_jpeg(quality), "image/jpeg"));
				}
				return candidates;
			} finally {
				resized.free();
			}
		}

		const qualitySteps = Array.from(new Set([opts.jpegQuality, 85, 70, 55, 40]));
		let currentWidth = targetWidth;
		let currentHeight = targetHeight;

		while (true) {
			const candidates = tryEncodings(currentWidth, currentHeight, qualitySteps);
			for (const candidate of candidates) {
				if (candidate.encodedSize < opts.maxBytes) {
					return {
						data: candidate.data,
						mimeType: candidate.mimeType,
						originalWidth,
						originalHeight,
						width: currentWidth,
						height: currentHeight,
						wasResized: true,
					};
				}
			}

			if (currentWidth === 1 && currentHeight === 1) {
				break;
			}

			const nextWidth = currentWidth === 1 ? 1 : Math.max(1, Math.floor(currentWidth * 0.75));
			const nextHeight = currentHeight === 1 ? 1 : Math.max(1, Math.floor(currentHeight * 0.75));
			if (nextWidth === currentWidth && nextHeight === currentHeight) {
				break;
			}

			currentWidth = nextWidth;
			currentHeight = nextHeight;
		}

		return null;
	} catch {
		return null;
	} finally {
		if (image) {
			image.free();
		}
	}
}

/**
 * Format a note about image dimensions for the LLM.
 * Helps the model understand coordinate mapping.
 */
export function formatDimensionNote(result: ResizedImage): string | undefined {
	if (!result.wasResized) {
		return undefined;
	}

	const scale = result.originalWidth / result.width;
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original.]`;
}
