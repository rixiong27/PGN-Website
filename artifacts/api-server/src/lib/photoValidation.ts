import type { File } from "@google-cloud/storage";
import sharp from "sharp";

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const PHOTO_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export class InvalidPhotoError extends Error {
  constructor(message = "PNM photos must be valid JPG, PNG, or WebP images no larger than 5 MB") {
    super(message);
    this.name = "InvalidPhotoError";
  }
}

/** Check storage metadata AND bounded, decoded bytes, never client declarations. */
export async function validatePhotoFile(file: Pick<File, "getMetadata" | "createReadStream">): Promise<{ bytes: Buffer; contentType: string }> {
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PHOTO_BYTES ||
      !PHOTO_CONTENT_TYPES.has(String(metadata.contentType))) {
    throw new InvalidPhotoError();
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  // Read one extra byte to detect understated metadata without unbounded buffering.
  const stream = file.createReadStream({ end: MAX_PHOTO_BYTES });
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_PHOTO_BYTES) throw new InvalidPhotoError();
      chunks.push(buffer);
    }
  } finally {
    stream.destroy();
  }
  if (bytes !== size) throw new InvalidPhotoError("Photo size does not match its stored metadata");

  const validatedBytes = Buffer.concat(chunks);
  try {
    // A header sniff alone accepts corrupt/truncated images. Decode all frames,
    // with a pixel limit to bound decompression cost as well as compressed bytes.
    const image = sharp(validatedBytes, {
      animated: true, failOn: "warning", limitInputPixels: 40_000_000,
    });
    const info = await image.metadata();
    const types: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
    const type = types[info.format ?? ""];
    if (!type || type !== metadata.contentType) throw new InvalidPhotoError();
    await image.stats();
  } catch {
    throw new InvalidPhotoError("Photo content is invalid or does not match its image type");
  }
  return { bytes: validatedBytes, contentType: String(metadata.contentType) };
}