import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { finished } from "node:stream/promises";
import { imageBytes } from "./photo-fixtures";

// No storage module is imported or provider request made in the default suite.
test("App Storage preserves verified photos across staging PUT replay", {
  skip: process.env.RUN_OBJECT_STORAGE_INTEGRATION !== "1",
  timeout: 180_000,
}, async (t) => {
  assert.notEqual(process.env.NODE_ENV, "production", "Never run provider fixtures in production");
  const bucketName = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  assert.ok(bucketName, "App Storage must be configured before opting in");
  assert.match(bucketName, /^[a-z0-9][a-z0-9._-]+$/, "Expected a bucket ID, not an object path");

  // Never read PRIVATE_OBJECT_DIR, member data, or a database. All operations,
  // including failure teardown, stay under this unpredictable test-only root.
  const prefix = `integration-tests/photo-provider/${crypto.randomUUID()}/`;
  const { ObjectStorageService, objectStorageClient, PhotoCreateNotConfirmedError } = await import("../src/lib/objectStorage");
  const { validatePhotoFile } = await import("../src/lib/photoValidation");
  class IsolatedStorage extends ObjectStorageService {
    photoId?: string;
    protected override createPhotoId() { return this.photoId ?? super.createPhotoId(); }
    override getPrivateObjectDir() { return `/${bucketName}/${prefix}private`; }
  }
  const storage = new IsolatedStorage();
  const bucket = objectStorageClient.bucket(bucketName);
  let phase = "setup";
  const fileAt = (relative: string) => bucket.file(`${prefix}${relative}`);
  const put = async (url: string, bytes: Buffer) => {
    // Do not include signed URLs or response bodies in failure output.
    const response = await fetch(url, {
      method: "PUT", body: new Uint8Array(bytes),
      headers: { "Content-Type": "image/png" },
      signal: AbortSignal.timeout(30_000),
    });
    await response.arrayBuffer();
    assert.equal(response.status, 200, "Signed staging PUT must succeed");
  };

  try {
    phase = "signed staging upload";
    const original = await imageBytes("png");
    const replacement = await imageBytes("webp");
    assert.notDeepEqual(original, replacement);
    phase = "raw SDK transport collision probe";
    // Inspect the SDK's unmodified HTTP response status on a separate object,
    // without logging response bodies, headers, requests, or credentials.
    const probe = fileAt("transport-probe");
    for (const [index, bytes] of [original, replacement].entries()) {
      const stream = probe.createWriteStream({
        resumable: false, validation: "crc32c",
        preconditionOpts: { ifGenerationMatch: 0 },
      });
      let status: number | undefined;
      stream.on("response", (response: { statusCode?: number }) => { status = response.statusCode; });
      const done = finished(stream);
      stream.end(bytes);
      let code: number | undefined;
      try { await done; } catch (error) {
        code = (error as { code?: number }).code;
        assert.equal(code, 412, "Only precondition failure is expected from raw probe");
      }
      t.diagnostic(`Raw SDK save ${index + 1}: response status=${status ?? "none"}, error code=${code ?? "none"}`);
      assert.deepEqual((await probe.download())[0], original);
    }
    for (const pinUUID of [false, true]) {
      const rawFile = fileAt(`save-probe-${pinUUID}`);
      const fixedUUID = crypto.randomUUID();
      const pin = pinUUID ? t.mock.method(crypto, "randomUUID", () => fixedUUID) : undefined;
      syncBuiltinESMExports();
      try {
        await rawFile.save(original, { resumable: false, validation: "crc32c", preconditionOpts: { ifGenerationMatch: 0 } });
        let collisionCode: number | undefined;
        try {
          await rawFile.save(replacement, { resumable: false, validation: "crc32c", preconditionOpts: { ifGenerationMatch: 0 } });
        } catch (error) {
          collisionCode = (error as { code?: number }).code;
          assert.equal(collisionCode, 412);
        }
        t.diagnostic(`Raw File.save collision (global UUID pinned=${pinUUID}): error code=${collisionCode ?? "none"}`);
      } finally {
        pin?.mock.restore();
        syncBuiltinESMExports();
      }
      assert.deepEqual((await rawFile.download())[0], original);
    }
    await t.test("adapter rejects acknowledged request replay", async () => {
      const replayStorage = new IsolatedStorage();
      replayStorage.photoId = crypto.randomUUID();
      const requestId = crypto.randomUUID();
      const pin = t.mock.method(crypto, "randomUUID", () => requestId);
      syncBuiltinESMExports();
      try {
        await replayStorage.saveVerifiedPhoto({ bytes: original, contentType: "image/png" });
        for (const bytes of [replacement, original]) {
          await assert.rejects(
            replayStorage.saveVerifiedPhoto({ bytes, contentType: "image/png" }),
            (error: unknown) => error instanceof PhotoCreateNotConfirmedError ||
              (error as { code?: unknown }).code === 412,
          );
        }
      } finally {
        pin.mock.restore();
        syncBuiltinESMExports();
      }
      const replayFile = fileAt(`private/photos/${replayStorage.photoId}`);
      assert.deepEqual((await replayFile.download())[0], original);
      await replayFile.delete({ ifGenerationMatch: (await replayFile.getMetadata())[0].generation });
    });
    phase = "signed staging upload";
    const signedURL = await storage.getObjectEntityUploadURL();
    const stagingPath = storage.normalizeObjectEntityPath(signedURL);
    assert.match(stagingPath, /^\/objects\/uploads\/[0-9a-f-]{36}$/);
    await put(signedURL, original);
    const staging = await storage.getObjectEntityFile(stagingPath);
    const [initialMetadata] = await staging.getMetadata();
    const verified = await validatePhotoFile(staging);
    assert.deepEqual(verified.bytes, original);

    phase = "replacement between verification and finalization";
    await put(signedURL, replacement);
    assert.deepEqual((await staging.download())[0], replacement);
    assert.notEqual((await staging.getMetadata())[0].generation, initialMetadata.generation);

    phase = "create-only finalization";
    // Pin only the generated identity, not the provider or save implementation.
    // Later, a second adapter call must collide without changing the object.
    const finalId = crypto.randomUUID();
    storage.photoId = finalId;
    const writes: Array<{ sameTarget: boolean; createOnly: boolean }> = [];
    const observer = {
      request(options: { qs?: Record<string, unknown> }) {
        if (options.qs?.name === `${prefix}private/photos/${finalId}`) {
          writes.push({ sameTarget: true, createOnly: options.qs.ifGenerationMatch === 0 });
        }
        return options;
      },
    };
    objectStorageClient.interceptors.push(observer);
    let finalPath: string;
    try {
      finalPath = await storage.saveVerifiedPhoto(verified);
      phase = "deterministic final identity";
      assert.equal(finalPath, `/objects/photos/${finalId}`);
    } finally {
      objectStorageClient.interceptors.splice(objectStorageClient.interceptors.indexOf(observer), 1);
    }
    const finalized = await storage.getObjectEntityFile(finalPath);
    phase = "finalized metadata and bytes";
    const [finalMetadata] = await finalized.getMetadata();
    assert.equal(finalMetadata.contentType, verified.contentType);
    assert.equal(Number(finalMetadata.size), original.length);
    assert.ok(finalMetadata.generation);
    assert.deepEqual((await finalized.download())[0], original);
    t.diagnostic("Finalization stored the exact validated buffer despite staging replacement");

    phase = "replay after finalization";
    await put(signedURL, replacement);
    assert.deepEqual((await staging.download())[0], replacement);
    assert.deepEqual((await finalized.download())[0], original);
    assert.equal((await finalized.getMetadata())[0].generation, finalMetadata.generation);
    t.diagnostic("Replaying the staging PUT preserved finalized bytes and generation");

    phase = "signed PUT cannot target finalized path";
    const redirectedURL = new URL(signedURL);
    redirectedURL.pathname = `/${bucketName}/${finalized.name}`;
    const denied = await fetch(redirectedURL, {
      method: "PUT", body: new Uint8Array(replacement),
      headers: { "Content-Type": "image/png" },
      signal: AbortSignal.timeout(30_000),
    });
    await denied.arrayBuffer();
    await t.test("staging signature cannot authorize the final path", () => {
      assert.equal(denied.status, 403, "Staging signature must not authorize the photos namespace");
    });
    assert.deepEqual((await finalized.download())[0], original);
    assert.equal((await finalized.getMetadata())[0].generation, finalMetadata.generation);

    phase = "namespace enumeration";
    const unrelated = [
      "private/uploads/readme.txt",
      `private/uploads/nested/${crypto.randomUUID()}`,
      "private/photos/readme.txt",
      `private/photos/nested/${crypto.randomUUID()}`,
      `private/avatars/${crypto.randomUUID()}`,
      `sibling/uploads/${crypto.randomUUID()}`,
      `sibling/photos/${crypto.randomUUID()}`,
    ];
    for (const name of unrelated) {
      await fileAt(name).save("unrelated disposable fixture", {
        resumable: false, preconditionOpts: { ifGenerationMatch: 0 },
      });
    }
    const listed = [];
    for await (const entry of storage.listPhotoUploads()) listed.push(entry);
    assert.deepEqual(
      listed.map((entry) => entry.objectPath).sort(),
      [stagingPath, finalPath].sort(),
      "List must include uploads and photos, without nested, unrelated, or sibling assets",
    );
    t.diagnostic("Enumeration included both namespaces and excluded all unrelated fixtures");

    await t.test("real provider enforces create-only finalization", async () => {
      objectStorageClient.interceptors.push(observer);
      try {
        for (const photo of [{ bytes: replacement, contentType: "image/webp" }, verified]) {
          await assert.rejects(storage.saveVerifiedPhoto(photo), (error: unknown) =>
            error instanceof PhotoCreateNotConfirmedError ||
            (error as { code?: unknown }).code === 412,
          "Both different-byte and identical-byte collisions must explicitly reject");
        }
      } finally {
        objectStorageClient.interceptors.splice(objectStorageClient.interceptors.indexOf(observer), 1);
      }
      assert.ok(writes.length >= 2, "Both saves must target the same finalized object");
      assert.ok(writes.every((write) => write.createOnly), "Every outgoing save must send ifGenerationMatch=0");
      t.diagnostic("Confirmed outgoing same-target saves both send ifGenerationMatch=0");
      t.diagnostic("Both collision attempts explicitly rejected");
    });
    // Report the observed provider outcome without dumping requests or bytes.
    phase = "post-collision integrity";
    const collisionBytes = (await finalized.download())[0];
    const collisionGeneration = (await finalized.getMetadata())[0].generation;
    t.diagnostic(`Collision preserved bytes=${collisionBytes.equals(original)}, generation=${collisionGeneration === finalMetadata.generation}`);
    await t.test("collision cannot replace verified bytes or generation", () => {
      assert.deepEqual(collisionBytes, original);
      assert.equal(collisionGeneration, finalMetadata.generation);
    });

    // Refresh generations in case a broken provider accepted the collision.
    // This lets teardown run and still exercises the adapter's listed deletes.
    const current = [];
    for await (const entry of storage.listPhotoUploads()) current.push(entry);
    for (const entry of current) {
      assert.ok(entry.metadata.generation);
      await entry.delete();
    }
    assert.equal((await staging.exists())[0], false);
    assert.equal((await finalized.exists())[0], false);
    for (const name of unrelated) assert.equal((await fileAt(name).exists())[0], true);
    t.diagnostic("Listed deletes preserved unrelated fixtures");
  } catch (error) {
    // GCS/fetch errors may contain signed requests. Only disclose the phase and
    // a numeric provider status, never the raw error, URL, or credentials.
    const code = (error as { code?: unknown }).code;
    const name = error instanceof Error ? error.name : "unknown";
    const assertion = error instanceof assert.AssertionError ? error.message.split("\n")[0] : "";
    throw new Error(`Provider contract failed during ${phase} (${name}, ${assertion})${typeof code === "number" ? ` (HTTP ${code})` : ""}`);
  } finally {
    // Include ignored fixtures and partially created objects on assertion failure.
    // Never enumerate the bucket or configured application private root.
    try {
      const [files] = await bucket.getFiles({ prefix });
      const results = await Promise.allSettled(files.map((file) => file.delete({
        ignoreNotFound: true, ifGenerationMatch: file.metadata.generation,
      })));
      assert.ok(results.every((result) => result.status === "fulfilled"));
      const [remaining] = await bucket.getFiles({ prefix });
      assert.equal(remaining.length, 0);
    } catch {
      throw new Error(`Provider fixture cleanup failed; remove only test prefix ${prefix}`);
    }
  }
});