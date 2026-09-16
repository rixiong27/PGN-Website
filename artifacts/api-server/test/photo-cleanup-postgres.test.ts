import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import type { pool as Pool } from "@workspace/db";
import { imageBytes, photoFile } from "./photo-fixtures";

// Never consume DATABASE_URL from the environment. Each test process starts its
// own cluster, reachable only through a private temporary Unix socket directory.
let directory: string;
let started = false;
let pool: typeof Pool;
let cleanupPhotos: typeof import("../src/lib/photoCleanup").cleanupPhotos;
let withPhotoWrite: typeof import("../src/lib/photoCleanup").withPhotoWrite;
type Client = Awaited<ReturnType<typeof pool.connect>>;
const path = "/objects/uploads/concurrency-fixture";
const finalizedPath = "/objects/photos/concurrency-fixture";
const now = Date.parse("2026-09-16T12:00:00Z");

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "photo-pg-"));
  execFileSync("initdb", ["-D", join(directory, "data"), "-A", "trust", "-U", "postgres", "--no-locale"], { stdio: "pipe" });
  execFileSync("pg_ctl", [
    "-D", join(directory, "data"), "-l", join(directory, "postgres.log"),
    "-o", `-k ${directory} -c listen_addresses='' -c fsync=off`, "-w", "start",
  ], { stdio: "pipe", timeout: 15_000 });
  started = true;
  process.env.DATABASE_URL = `postgresql://postgres@localhost/postgres?host=${encodeURIComponent(directory)}`;
  ({ pool } = await import("@workspace/db"));
  ({ cleanupPhotos, withPhotoWrite } = await import("../src/lib/photoCleanup"));
  // A minimal table in a disposable database, not the application's table.
  await pool.query("CREATE TABLE pgn_pnms (id integer PRIMARY KEY, photo_path text)");
});

after(async () => {
  try {
    if (pool) await pool.end();
  } finally {
    if (started) execFileSync("pg_ctl", ["-D", join(directory, "data"), "-m", "immediate", "-w", "stop"], { stdio: "pipe" });
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

async function reached(operation: Promise<unknown>, signal: ReturnType<typeof gate>) {
  await Promise.race([
    signal.promise,
    operation.then(() => { throw new Error("Operation completed without reaching the expected phase"); }),
  ]);
}

// Only connection checkout is adapted; every SQL statement executes unchanged
// against PostgreSQL. Production code may release without releasing our observer.
function database(client: Client): typeof pool {
  return {
    connect: async () => ({ query: client.query.bind(client), release() {} }),
  } as unknown as typeof pool;
}

async function storage() {
  const bytes = await imageBytes();
  const state = { exists: true, finalized: false, attempts: 0, removals: 0, validations: 0 };
  const objects = {
    async *listPhotoUploads() {
      // Deliberately allow stale listings, as two bucket scans can overlap.
      yield {
        objectPath: path,
        metadata: { timeCreated: "2026-09-14T00:00:00Z", generation: "1" },
        async delete() {
          state.attempts++;
          if (state.exists) state.removals++;
          state.exists = false; // Matches ignoreNotFound: true.
        },
      };
      if (state.finalized) {
        yield {
          objectPath: finalizedPath,
          metadata: { timeCreated: "2026-09-14T00:00:00Z", generation: "1" },
          async delete() {
            state.finalized = false;
          },
        };
      }
    },
    async getObjectEntityFile() {
      state.validations++;
      if (!state.exists) throw new Error("Fixture object not found");
      return photoFile(bytes);
    },
    async saveVerifiedPhoto() {
      state.finalized = true;
      return finalizedPath;
    },
  };
  return { state, objects: objects as unknown as Parameters<typeof withPhotoWrite>[3] & Parameters<typeof cleanupPhotos>[1] };
}

// Observe a real, ungranted table lock and its actual blocker. A short polling
// delay is only a yield; elapsed time is never evidence that blocking occurred.
async function waitForBlocked(observer: Client, waiter: number, blocker: number, mode: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await observer.query(
      `SELECT 1 FROM pg_locks
       WHERE pid = $1 AND relation = 'pgn_pnms'::regclass
         AND mode = $3 AND NOT granted
         AND $2::integer = ANY(pg_blocking_pids($1))`,
      [waiter, blocker, mode],
    );
    if (result.rowCount) return;
    await delay(10);
  }
  assert.fail(`Connection ${waiter} did not wait on ${blocker} for ${mode}`);
}

async function scenario(run: (ctx: {
  a: Client; b: Client; aPid: number; bPid: number;
  hold: ReturnType<typeof gate>;
  track: <T>(promise: Promise<T>) => Promise<T>;
}) => Promise<void>) {
  await pool.query("TRUNCATE pgn_pnms");
  const a = await pool.connect();
  const b = await pool.connect();
  const hold = gate();
  const pending: Promise<unknown>[] = [];
  function track<T>(promise: Promise<T>) {
    pending.push(promise);
    void promise.catch(() => {}); // Assertions below still observe rejections.
    return promise;
  }
  try {
    for (const client of [a, b]) await client.query("SET statement_timeout = '8s'");
    const aPid = (await a.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const bPid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    assert.notEqual(aPid, bPid);
    await run({ a, b, aPid, bPid, hold, track });
  } finally {
    hold.open();
    // Unlock manually held transactions before waiting for competing operations.
    await a.query("ROLLBACK");
    await b.query("ROLLBACK");
    await Promise.allSettled(pending);
    a.release();
    b.release();
  }
}

for (const operation of ["INSERT", "UPDATE"] as const) {
  test(`cleanup blocks an ordinary ${operation} until deletion finishes`, { timeout: 15_000 }, async () => {
    await scenario(async ({ a, b, aPid, bPid, hold, track }) => {
      await a.query("INSERT INTO pgn_pnms VALUES (1, NULL)");
      const { objects, state } = await storage();
      const deleting = gate();
      const heldStorage = {
        async *listPhotoUploads() {
          for await (const file of objects!.listPhotoUploads()) {
            yield { ...file, async delete() { deleting.open(); await hold.promise; await file.delete(); } };
          }
        },
      };
      const cleanup = track(cleanupPhotos(database(a), heldStorage, now));
      await reached(cleanup, deleting);
      let completed = false;
      // Raw SQL proves the table lock also covers imports. Raw writers do not
      // validate storage, so write NULL here, not a deleted photo reference.
      const write = track(b.query(operation === "INSERT"
        ? "INSERT INTO pgn_pnms VALUES (2, NULL)"
        : "UPDATE pgn_pnms SET photo_path = NULL WHERE id = 1").then(() => { completed = true; }));
      await waitForBlocked(a, bPid, aPid, "RowExclusiveLock");
      assert.equal(completed, false);
      assert.equal(state.attempts, 0);
      hold.open();
      assert.deepEqual(await cleanup, { deleted: 1 });
      await write;
      assert.equal(completed, true);
    });
  });
}

test("a save blocks cleanup, which preserves the newly committed attachment", { timeout: 15_000 }, async () => {
  await scenario(async ({ a, b, aPid, bPid, hold, track }) => {
    const { objects, state } = await storage();
    const written = gate();
    const save = track(withPhotoWrite(database(a), path, async (client, savedPath) => {
      assert.equal(savedPath, finalizedPath);
      await client.query("INSERT INTO pgn_pnms VALUES (1, $1)", [savedPath]);
      written.open();
      await hold.promise;
    }, objects));
    await reached(save, written);
    const cleanup = track(cleanupPhotos(database(b), objects, now));
    await waitForBlocked(a, bPid, aPid, "ShareRowExclusiveLock");
    assert.equal(state.attempts, 0);
    hold.open();
    await save;
    assert.deepEqual(await cleanup, { deleted: 1 });
    assert.equal(state.exists, false);
    assert.equal(state.finalized, true);
    assert.equal((await b.query("SELECT photo_path FROM pgn_pnms")).rows[0].photo_path, finalizedPath);
  });
});

test("an attachment waits for cleanup, then rejects its deleted path without committing", { timeout: 15_000 }, async () => {
  await scenario(async ({ a, b, aPid, bPid, hold, track }) => {
    const { objects, state } = await storage();
    const deleting = gate();
    const cleanup = track(cleanupPhotos(database(a), {
      async *listPhotoUploads() {
        for await (const file of objects!.listPhotoUploads()) {
          yield { ...file, async delete() { deleting.open(); await hold.promise; await file.delete(); } };
        }
      },
    }, now));
    await reached(cleanup, deleting);
    let writeCalled = false;
    const save = track(withPhotoWrite(database(b), path, async client => {
      writeCalled = true;
      await client.query("INSERT INTO pgn_pnms VALUES (1, $1)", [path]);
    }, objects));
    await waitForBlocked(a, bPid, aPid, "ShareRowExclusiveLock");
    assert.equal(state.validations, 0);
    assert.equal(writeCalled, false);
    hold.open();
    assert.deepEqual(await cleanup, { deleted: 1 });
    await assert.rejects(save, /Fixture object not found/);
    assert.equal(state.validations, 1);
    assert.equal(writeCalled, false);
    assert.equal((await b.query("SELECT * FROM pgn_pnms")).rowCount, 0);
    // A subsequent valid save proves rollback released the failed transaction.
    await withPhotoWrite(database(b), null, client => client.query("INSERT INTO pgn_pnms VALUES (2, NULL)"), objects);
  });
});

test("concurrent cleanup workers serialize stale listings and preserve referenced photos", { timeout: 15_000 }, async () => {
  await scenario(async ({ a, b, aPid, bPid, hold, track }) => {
    const { objects, state } = await storage();
    await a.query("INSERT INTO pgn_pnms VALUES (1, $1)", [`${path}-saved`]);
    let savedDeletes = 0;
    const deleting = gate();
    function listing(pause: boolean) {
      return {
        async *listPhotoUploads() {
          for await (const file of objects!.listPhotoUploads()) {
            yield { ...file, async delete() {
              if (pause) { deleting.open(); await hold.promise; }
              await file.delete();
            } };
            yield { ...file, objectPath: `${path}-saved`, async delete() { savedDeletes++; } };
          }
        },
      };
    }
    const first = track(cleanupPhotos(database(a), listing(true), now));
    await reached(first, deleting);
    const second = track(cleanupPhotos(database(b), listing(false), now));
    await waitForBlocked(a, bPid, aPid, "ShareRowExclusiveLock");
    assert.equal(state.attempts, 0);
    hold.open();
    assert.deepEqual(await first, { deleted: 1 });
    assert.deepEqual(await second, { deleted: 1 });
    assert.equal(state.attempts, 2); // Second delete is an idempotent not-found.
    assert.equal(state.removals, 1);
    assert.equal(savedDeletes, 0);
    assert.equal((await b.query("SELECT photo_path FROM pgn_pnms")).rows[0].photo_path, `${path}-saved`);
  });
});