import assert from "node:assert/strict";
import test from "node:test";
import { cleanupPhotos, PHOTO_GRACE_MS, withPhotoWrite } from "../src/lib/photoCleanup";
import { imageBytes, photoFile } from "./photo-fixtures";

const now = Date.parse("2026-09-16T12:00:00.000Z");
const oldCreated = new Date(now - PHOTO_GRACE_MS - 1);
const recentCreated = new Date(now - PHOTO_GRACE_MS + 10_000);

type MockFile = {
  objectPath: string;
  metadata: { timeCreated?: string | Date; generation?: string };
  delete: () => Promise<void>;
};

type MockClient = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
  release: () => void;
};

function database(options: {
  references?: (path: string) => unknown[];
  referenceError?: Error;
  events?: string[];
} = {}) {
  const events = options.events ?? [];
  const calls = { connect: 0, rollback: 0, commit: 0, released: 0, references: [] as string[] };
  const client: MockClient = {
    async query(sql, values = []) {
      events.push(`query:${sql}`);
      if (sql === "BEGIN") return { rows: [] };
      if (sql === "SET LOCAL lock_timeout = '5s'") return { rows: [] };
      if (sql === "LOCK TABLE pgn_pnms IN SHARE ROW EXCLUSIVE MODE") return { rows: [] };
      if (sql === "COMMIT") {
        calls.commit++;
        return { rows: [] };
      }
      if (sql === "ROLLBACK") {
        calls.rollback++;
        return { rows: [] };
      }
      if (sql.startsWith("SELECT 1 FROM pgn_pnms")) {
        const path = String(values[0]);
        calls.references.push(path);
        if (options.referenceError) throw options.referenceError;
        return { rows: options.references?.(path) ?? [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {
      calls.released++;
      events.push("release");
    },
  };
  const db = {
    async connect() {
      calls.connect++;
      events.push("connect");
      return client;
    },
  };
  return { db, calls, events };
}

function file(
  objectPath: string,
  metadata: MockFile["metadata"] = { timeCreated: oldCreated, generation: "1" },
  deleteError?: Error,
) {
  let deletes = 0;
  const object: MockFile = {
    objectPath,
    metadata,
    async delete() {
      deletes++;
      if (deleteError) throw deleteError;
    },
  };
  return { object, deletes: () => deletes };
}

async function* uploads(files: MockFile[]) {
  yield* files;
}

test("cleanup deletes orphaned uploads, including a replaced photo, one transaction each", async () => {
  const orphan = file("/objects/uploads/orphan");
  const replaced = file("/objects/uploads/replaced");
  const { db, calls } = database();

  const result = await cleanupPhotos(
    db as never,
    { listPhotoUploads: () => uploads([orphan.object, replaced.object]) } as never,
    now,
  );

  assert.deepEqual(result, { deleted: 2 });
  assert.equal(orphan.deletes(), 1);
  assert.equal(replaced.deletes(), 1);
  assert.equal(calls.connect, 2);
  assert.equal(calls.commit, 2);
  assert.equal(calls.rollback, 0);
  assert.deepEqual(calls.references, [orphan.object.objectPath, replaced.object.objectPath]);
  assert.equal(calls.released, 2);
});

test("cleanup preserves objects referenced by active, shared, and archived PNMs", async () => {
  const shared = file("/objects/uploads/shared");
  const archived = file("/objects/uploads/archived");
  const references = new Map<string, unknown[]>([
    [shared.object.objectPath, [{ photo_path: shared.object.objectPath }, { photo_path: shared.object.objectPath, archived: true }]],
    [archived.object.objectPath, [{ photo_path: archived.object.objectPath, archived: true }]],
  ]);
  const { db, calls } = database({ references: path => references.get(path) ?? [] });

  const result = await cleanupPhotos(
    db as never,
    { listPhotoUploads: () => uploads([shared.object, archived.object]) } as never,
    now,
  );

  assert.deepEqual(result, { deleted: 0 });
  assert.equal(shared.deletes(), 0);
  assert.equal(archived.deletes(), 0);
  assert.equal(calls.commit, 2);
  assert.equal(calls.rollback, 0);
});

test("cleanup fails closed for young uploads and unknown age or generation metadata", async () => {
  const recent = file("/objects/uploads/recent", {
    timeCreated: recentCreated,
    generation: "1",
  });
  const unknownAge = file("/objects/uploads/unknown-age", {
    timeCreated: "not-a-date",
    generation: "1",
  });
  const unknownGeneration = file("/objects/uploads/unknown-generation", {
    timeCreated: oldCreated,
  });
  const eligible = file("/objects/uploads/eligible");
  const { db, calls } = database();

  const result = await cleanupPhotos(
    db as never,
    { listPhotoUploads: () => uploads([
      recent.object,
      unknownAge.object,
      unknownGeneration.object,
      eligible.object,
    ]) } as never,
    now,
  );

  assert.deepEqual(result, { deleted: 1 });
  assert.equal(recent.deletes(), 0);
  assert.equal(unknownAge.deletes(), 0);
  assert.equal(unknownGeneration.deletes(), 0);
  assert.equal(eligible.deletes(), 1);
  assert.equal(calls.connect, 1);
});

test("cleanup rolls back and never deletes when the reference query fails", async () => {
  const candidate = file("/objects/uploads/db-failure");
  const referenceError = new Error("database unavailable");
  const { db, calls } = database({ referenceError });

  await assert.rejects(
    cleanupPhotos(
      db as never,
      { listPhotoUploads: () => uploads([candidate.object]) } as never,
      now,
    ),
    referenceError,
  );

  assert.equal(candidate.deletes(), 0);
  assert.equal(calls.rollback, 1);
  assert.equal(calls.commit, 0);
  assert.equal(calls.released, 1);
});

test("cleanup rolls back when generation-guarded deletion fails", async () => {
  const deleteError = new Error("generation mismatch");
  const candidate = file("/objects/uploads/generation-failure", undefined, deleteError);
  const { db, calls } = database();

  await assert.rejects(
    cleanupPhotos(
      db as never,
      { listPhotoUploads: () => uploads([candidate.object]) } as never,
      now,
    ),
    deleteError,
  );

  assert.equal(candidate.deletes(), 1);
  assert.equal(calls.rollback, 1);
  assert.equal(calls.commit, 0);
  assert.equal(calls.released, 1);
});

function writeDatabase(events: string[]) {
  const calls = { rollback: 0, commit: 0, released: 0 };
  const client: MockClient = {
    async query(sql) {
      events.push(`query:${sql}`);
      if (sql === "ROLLBACK") calls.rollback++;
      if (sql === "COMMIT") calls.commit++;
      return { rows: [] };
    },
    release() {
      calls.released++;
      events.push("release");
    },
  };
  return {
    calls,
    db: {
      async connect() {
        events.push("connect");
        return client;
      },
    },
  };
}

test("withPhotoWrite acquires the table lock before checking that the object exists", async () => {
  const events: string[] = [];
  const { db, calls } = writeDatabase(events);
  const savedPath = "/objects/photos/finalized";
  const objects = {
    async getObjectEntityFile(path: string) {
      events.push(`exists:${path}`);
      return photoFile(await imageBytes());
    },
    async saveVerifiedPhoto() {
      events.push("finalize");
      return savedPath;
    },
  };
  const result = await withPhotoWrite(
    db as never,
    "/objects/uploads/photo",
    async (client, persistedPath) => {
      events.push("write");
      assert.equal(persistedPath, savedPath);
      await client.query("UPDATE pgn_pnms SET photo_path=$1", [persistedPath]);
      return "saved";
    },
    objects as never,
  );

  assert.equal(result, "saved");
  assert.ok(events.indexOf("query:LOCK TABLE pgn_pnms IN SHARE ROW EXCLUSIVE MODE") < events.indexOf("exists:/objects/uploads/photo"));
  assert.ok(events.indexOf("exists:/objects/uploads/photo") < events.indexOf("write"));
  assert.equal(calls.commit, 1);
  assert.equal(calls.rollback, 0);
  assert.equal(calls.released, 1);
});

test("withPhotoWrite rolls back without writing when the object is absent", async () => {
  const events: string[] = [];
  const { db, calls } = writeDatabase(events);
  const missing = new Error("object not found");
  let writes = 0;
  const objects = {
    async getObjectEntityFile() {
      throw missing;
    },
  };

  await assert.rejects(
    withPhotoWrite(
      db as never,
      "/objects/uploads/missing",
      async () => {
        writes++;
      },
      objects as never,
    ),
    missing,
  );

  assert.equal(writes, 0);
  assert.equal(calls.rollback, 1);
  assert.equal(calls.commit, 0);
  assert.equal(calls.released, 1);
  assert.ok(events.indexOf("query:LOCK TABLE pgn_pnms IN SHARE ROW EXCLUSIVE MODE") < events.indexOf("release"));
});

test("withPhotoWrite rolls back when the database write fails", async () => {
  const events: string[] = [];
  const { db, calls } = writeDatabase(events);
  const writeError = new Error("write failed");
  const objects = {
    async getObjectEntityFile(path: string) {
      events.push(`exists:${path}`);
      return photoFile(await imageBytes());
    },
    async saveVerifiedPhoto() {
      return "/objects/photos/write-failure";
    },
  };

  await assert.rejects(
    withPhotoWrite(
      db as never,
      "/objects/uploads/write-failure",
      async () => {
        events.push("write");
        throw writeError;
      },
      objects as never,
    ),
    writeError,
  );

  assert.equal(calls.rollback, 1);
  assert.equal(calls.commit, 0);
  assert.equal(calls.released, 1);
});

test("withPhotoWrite persists the validated bytes even when staging is replaced during finalization", async () => {
  const validBytes = await imageBytes();
  const replacement = Buffer.from("not an image");
  let stagingBytes = validBytes;
  let finalizedBytes: Buffer | undefined;
  let finalizedType: string | undefined;
  const finalPath = "/objects/photos/exact-bytes";
  const objects = {
    async getObjectEntityFile() {
      return photoFile(stagingBytes);
    },
    async saveVerifiedPhoto(photo: { bytes: Buffer; contentType: string }) {
      // The reusable PUT target can change while the immutable object is being
      // finalized. The saver must persist the bytes returned by validation.
      finalizedBytes = Buffer.from(photo.bytes);
      finalizedType = photo.contentType;
      stagingBytes = replacement;
      return finalPath;
    },
  };
  let persistedPath: string | null | undefined;
  await withPhotoWrite(
    writeDatabase([]).db as never,
    "/objects/uploads/reused",
    async (_client, savedPath) => {
      persistedPath = savedPath;
    },
    objects as never,
  );

  assert.equal(persistedPath, finalPath);
  assert.deepEqual(finalizedBytes, validBytes);
  assert.equal(finalizedType, "image/png");
  assert.deepEqual(stagingBytes, replacement);
});

test("withPhotoWrite does not write the database when finalization fails", async () => {
  const finalizationError = new Error("immutable object unavailable");
  const { db, calls } = writeDatabase([]);
  let writes = 0;
  const objects = {
    async getObjectEntityFile() {
      return photoFile(await imageBytes());
    },
    async saveVerifiedPhoto() {
      throw finalizationError;
    },
  };

  await assert.rejects(
    withPhotoWrite(
      db as never,
      "/objects/uploads/finalization-failure",
      async () => {
        writes++;
      },
      objects as never,
    ),
    finalizationError,
  );

  assert.equal(writes, 0);
  assert.equal(calls.rollback, 1);
  assert.equal(calls.commit, 0);
  assert.equal(calls.released, 1);
});

test("withPhotoWrite preserves an already finalized path", async () => {
  const finalPath = "/objects/photos/already-finalized";
  let persistedPath: string | null | undefined;
  const objects = {
    async getObjectEntityFile() {
      return photoFile(await imageBytes());
    },
    async saveVerifiedPhoto() {
      throw new Error("must not re-finalize an immutable object");
    },
  };

  await withPhotoWrite(
    writeDatabase([]).db as never,
    finalPath,
    async (_client, savedPath) => {
      persistedPath = savedPath;
    },
    objects as never,
  );

  assert.equal(persistedPath, finalPath);
});

test("delayed cleanup removes unreferenced finalized photos but preserves referenced finals", async () => {
  const referenced = file("/objects/photos/referenced");
  const unreferenced = file("/objects/photos/unreferenced");
  const references = new Map<string, unknown[]>([
    [referenced.object.objectPath, [{ photo_path: referenced.object.objectPath }]],
  ]);
  const { db, calls } = database({ references: path => references.get(path) ?? [] });

  const result = await cleanupPhotos(
    db as never,
    { listPhotoUploads: () => uploads([referenced.object, unreferenced.object]) } as never,
    now,
  );

  assert.deepEqual(result, { deleted: 1 });
  assert.equal(referenced.deletes(), 0);
  assert.equal(unreferenced.deletes(), 1);
  assert.deepEqual(calls.references, [referenced.object.objectPath, unreferenced.object.objectPath]);
});