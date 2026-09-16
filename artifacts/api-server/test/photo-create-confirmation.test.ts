import assert from "node:assert/strict";
import { test } from "node:test";
import { ObjectStorageService, objectStorageClient, PhotoCreateNotConfirmedError } from "../src/lib/objectStorage";

test("photo finalization confirms its own atomic create", async (t) => {
  class IsolatedStorage extends ObjectStorageService {
    override getPrivateObjectDir() { return "/test-bucket/disposable"; }
  }
  const storage = new IsolatedStorage();
  let persisted: { generation?: string; metadata?: Record<string, string> } = {};
  let saveError: Error | undefined;
  let readError: Error | undefined;
  let acceptWrite = true;
  let reads = 0;
  let saves = 0;
  const tokens = new Set<string>();
  const file = {
    async save(bytes: Buffer, options: {
      resumable: boolean; validation: string; preconditionOpts: { ifGenerationMatch: number };
      metadata: { contentType: string; metadata: { photoWriteToken: string } };
    }) {
      saves++;
      assert.equal(bytes.toString(), "verified bytes");
      assert.equal(options.resumable, false);
      assert.equal(options.validation, "crc32c");
      assert.equal(options.preconditionOpts.ifGenerationMatch, 0);
      assert.equal(options.metadata.contentType, "image/png");
      const token = options.metadata.metadata.photoWriteToken;
      assert.match(token, /^[0-9a-f]{64}$/);
      assert.ok(!tokens.has(token), "Every attempt must use a fresh marker");
      tokens.add(token);
      if (saveError) throw saveError;
      if (acceptWrite) persisted = { generation: "1", metadata: options.metadata.metadata };
    },
    async getMetadata() {
      reads++;
      assert.ok(saves > 0, "No preflight existence check");
      if (readError) throw readError;
      return [persisted];
    },
  };
  t.mock.method(objectStorageClient, "bucket", () => ({
    file(name: string) {
      assert.match(name, /^disposable\/photos\/[0-9a-f-]{36}$/);
      return file;
    },
  }) as never);
  const photo = { bytes: Buffer.from("verified bytes"), contentType: "image/png" };
  assert.match(await storage.saveVerifiedPhoto(photo), /^\/objects\/photos\/[0-9a-f-]{36}$/);
  acceptWrite = false;
  await assert.rejects(storage.saveVerifiedPhoto(photo), PhotoCreateNotConfirmedError);
  persisted = { generation: "1" }; // Legacy objects have no marker.
  await assert.rejects(storage.saveVerifiedPhoto(photo), PhotoCreateNotConfirmedError);
  persisted = {};
  await assert.rejects(storage.saveVerifiedPhoto(photo), PhotoCreateNotConfirmedError);
  readError = new Error("metadata unavailable");
  await assert.rejects(storage.saveVerifiedPhoto(photo), readError);
  readError = undefined;
  saveError = Object.assign(new Error("precondition failed"), { code: 412 });
  const before = reads;
  await assert.rejects(storage.saveVerifiedPhoto(photo), saveError);
  assert.equal(reads, before, "Native provider errors propagate without confirmation reads");
});