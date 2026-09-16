import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { InvalidPhotoError, MAX_PHOTO_BYTES, validatePhotoFile } from "../src/lib/photoValidation";
import { imageBytes, photoFile } from "./photo-fixtures";

test("accepts fully decodable JPEG, PNG and WebP", async () => {
  for (const format of ["jpeg", "png", "webp"] as const) {
    await validatePhotoFile(photoFile(await imageBytes(format), `image/${format}`) as never);
  }
});

test("accepts a valid JPEG at the exact 5 MB boundary", async () => {
  const jpeg = await imageBytes("jpeg");
  // Legal JPEG comment segments let a tiny image exercise the byte boundary.
  const comments: Buffer[] = [];
  let remaining = MAX_PHOTO_BYTES - jpeg.length;
  while (remaining) {
    let length = Math.min(65537, remaining);
    if (remaining - length > 0 && remaining - length < 4) length -= 4;
    const comment = Buffer.alloc(length);
    comment[0] = 0xff;
    comment[1] = 0xfe;
    comment.writeUInt16BE(length - 2, 2);
    comments.push(comment);
    remaining -= length;
  }
  const bytes = Buffer.concat([jpeg.subarray(0, 2), ...comments, jpeg.subarray(2)]);
  assert.equal(bytes.length, MAX_PHOTO_BYTES);
  await validatePhotoFile(photoFile(bytes, "image/jpeg") as never);
});

test("rejects metadata and actual byte mismatches, empty, corrupt and disguised files", async () => {
  const png = await imageBytes();
  const cases = [
    photoFile(png, "image/jpeg"), photoFile(png, "application/octet-stream"),
    photoFile(png, "image/png", png.length + 1), photoFile(png, "image/png", png.length - 1),
    photoFile(png, "image/png", MAX_PHOTO_BYTES + 1),
    photoFile(Buffer.alloc(MAX_PHOTO_BYTES + 1), "image/png", 1),
    photoFile(Buffer.alloc(0)), photoFile(Buffer.from("<svg></svg>")),
    photoFile(Buffer.from("GIF89a")), photoFile(png.subarray(0, 40)),
    photoFile(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg"),
    photoFile(Buffer.from("RIFFxxxxWEBP"), "image/webp"),
  ];
  for (const file of cases) await assert.rejects(validatePhotoFile(file as never), InvalidPhotoError);
});

test("rejects oversized metadata before opening a stream", async () => {
  const file = photoFile(Buffer.alloc(0), "image/png", MAX_PHOTO_BYTES + 1);
  file.createReadStream = () => { throw new Error("must not read"); };
  await assert.rejects(validatePhotoFile(file as never), InvalidPhotoError);
});

test("bounds reads and closes streams on understated oversized uploads", async () => {
  const stream = Readable.from([Buffer.alloc(MAX_PHOTO_BYTES), Buffer.from([1])]);
  const file = {
    async getMetadata() { return [{ contentType: "image/png", size: "1" }]; },
    createReadStream(options: { end: number }) {
      assert.equal(options.end, MAX_PHOTO_BYTES);
      return stream;
    },
  };
  await assert.rejects(validatePhotoFile(file as never), InvalidPhotoError);
  assert.equal(stream.destroyed, true);
});

test("propagates storage failures rather than treating them as valid photos", async () => {
  const file = photoFile(await imageBytes());
  file.createReadStream = () => Readable.from((async function* () { throw new Error("storage unavailable"); })());
  await assert.rejects(validatePhotoFile(file as never), /storage unavailable/);
});