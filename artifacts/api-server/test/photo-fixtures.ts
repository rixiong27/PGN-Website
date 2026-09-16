import { Readable } from "node:stream";
import sharp from "sharp";

export async function imageBytes(format: "jpeg" | "png" | "webp" = "png") {
  return sharp({ create: { width: 2, height: 2, channels: 3, background: "#123456" } })
    .toFormat(format).toBuffer();
}

export function photoFile(bytes: Buffer, contentType = "image/png", size = bytes.length) {
  return {
    async getMetadata() { return [{ contentType, size: String(size) }]; },
    createReadStream() { return Readable.from([bytes]); },
  };
}