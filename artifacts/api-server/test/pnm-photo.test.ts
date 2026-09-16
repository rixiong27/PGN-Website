import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express, { type Request } from "express";
import { createStorageRouter } from "../src/routes/storage";
import { createRecruitmentRouter } from "../src/routes/recruitment";
import { ObjectNotFoundError } from "../src/lib/objectStorage";
import { imageBytes, photoFile } from "./photo-fixtures";

const maxSize = 5 * 1024 * 1024;
const objectPath = "/objects/uploads/candidate-photo";
const uploadURL = "https://storage.googleapis.com/test-bucket/uploads/candidate-photo";
const metadata = { name: "candidate.png", size: 128, contentType: "image/png" };
const identities = {
  member: { role: "member", status: "active" },
  admin: { role: "admin", status: "active" },
  super_admin: { role: "super_admin", status: "active" },
  pending: { role: "pending", status: "pending" },
  rejected: { role: "admin", status: "rejected" },
} as const;
type Identity = keyof typeof identities | "unknown";

// External boundaries are faked; real Express routes, schemas, authorization,
// SQL parameters, response mapping and streaming run for every request.
async function fixture(run: (h: {
  request: (path: string, identity?: Identity, body?: unknown, method?: string) => Promise<Response>;
  calls: { uploads: number; reads: string[]; downloads: number; queries: number; finalizations: number };
  stored: Map<number, Record<string, unknown>>;
  setPhoto: (bytes: Buffer, type?: string, size?: number) => void;
  setFinalizationHook: (hook: (photo: { bytes: Buffer; contentType: string }) => void | Promise<void>) => void;
  validStagingBytes: Buffer;
}) => Promise<void>) {
  const validStagingBytes = await imageBytes();
  const objectPath = "/objects/uploads/candidate-photo";
  const finalized = new Map<string, { bytes: Buffer; contentType: string }>();
  const filePaths = new WeakMap<object, string>();
  let file = photoFile(validStagingBytes);
  filePaths.set(file, objectPath);
  let finalizationHook: ((photo: { bytes: Buffer; contentType: string }) => void | Promise<void>) | undefined;
  const calls = { uploads: 0, reads: [] as string[], downloads: 0, queries: 0, finalizations: 0 };
  const stored = new Map<number, Record<string, unknown>>();
  const auth = (req: Request) => {
    const userId = req.header("x-test-user") ?? null;
    return {
      userId,
      sessionClaims: userId ? { email: `${userId}@example.com` } : undefined,
    };
  };
  const pool = {
    async connect() { return { query: pool.query, release() {} }; },
    async query(sql: string, values: unknown[] = []) {
      calls.queries++;
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.startsWith("LOCK TABLE")) return { rows: [] };
      if (sql.includes("FROM pgn_users")) {
        const user = String(values[0]) as keyof typeof identities;
        const identity = identities[user];
        return { rows: identity ? [{
          ...identity, id: 7, clerk_id: user, name: "Test User",
          email: `${user}@vt.edu`, created_at: new Date(),
        }] : [] };
      }
      if (sql.startsWith("INSERT INTO pgn_activity")) return { rows: [] };
      if (sql.startsWith("INSERT INTO pgn_pnms (first_name,last_name,pronouns,email,year,major,minor,gpa,semester)")) {
        return { rows: [] };
      }
      if (sql.startsWith("INSERT INTO pgn_pnms") || sql.startsWith("UPDATE pgn_pnms SET")) {
        const columns = ["first_name", "last_name", "pronouns", "email", "year", "major", "minor", "gpa", "photo_path", "status", "semester"];
        // Derive persisted fields from SQL bindings, never from an HTTP response.
        for (const [index, column] of columns.entries()) {
          if (sql.startsWith("UPDATE")) assert.ok(sql.includes(`${column}=$${index + 1}`));
        }
        assert.ok(sql.includes("photo_path"));
        const id = sql.startsWith("UPDATE") ? Number(values[11]) : stored.size + 1;
        const row = { id, ...Object.fromEntries(columns.map((c, i) => [c, values[i]])),
          created_at: new Date(), updated_at: new Date(), archived: false };
        stored.set(id, structuredClone(row));
        return { rows: [structuredClone(row)] };
      }
      if (sql.includes("FROM pgn_pnms p LEFT JOIN")) {
        const rows = sql.includes("WHERE p.id = $1")
          ? [stored.get(Number(values[0]))].filter(Boolean) : [...stored.values()];
        return { rows: structuredClone(rows) };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const service = {
    async getObjectEntityUploadURL() { calls.uploads++; return uploadURL; },
    normalizeObjectEntityPath(url: string) { assert.equal(url, uploadURL); return objectPath; },
    async getObjectEntityFile(path: string) {
      calls.reads.push(path);
      if (path === objectPath) return file;
      const saved = finalized.get(path);
      if (!saved) throw new ObjectNotFoundError();
      const finalizedFile = photoFile(saved.bytes, saved.contentType);
      filePaths.set(finalizedFile, path);
      return finalizedFile;
    },
    async saveVerifiedPhoto(photo: { bytes: Buffer; contentType: string }) {
      calls.finalizations++;
      const finalPath = `/objects/photos/00000000-0000-4000-8000-${String(calls.finalizations).padStart(12, "0")}`;
      const bytes = Buffer.from(photo.bytes);
      await finalizationHook?.(photo);
      finalized.set(finalPath, { bytes, contentType: photo.contentType });
      return finalPath;
    },
    async searchPublicObject() { throw new Error("Unexpected public lookup"); },
    async downloadObject(objectFile: object) {
      calls.downloads++;
      const path = filePaths.get(objectFile);
      const saved = path ? finalized.get(path) : undefined;
      return new Response(saved?.bytes ?? new Uint8Array([137, 80, 78, 71]), {
        headers: {
          "Content-Type": saved?.contentType ?? "image/png",
          "Cache-Control": "private, max-age=3600",
        },
      });
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.log = { error() {}, warn() {} } as unknown as Request["log"];
    next();
  });
  app.use(createStorageRouter({ getAuth: auth as never, pool: pool as never, objectStorageService: service as never }));
  app.use(createRecruitmentRouter({ getAuth: auth as never, pool: pool as never, photoStorage: service as never }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run({ calls, stored, setPhoto: (bytes, type, size) => { file = photoFile(bytes, type, size); },
      setFinalizationHook: hook => { finalizationHook = hook; },
      validStagingBytes,
      request: (path, identity, body, method) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: { ...(identity ? { "x-test-user": identity } : {}), "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }) });
  } finally {
    server.close();
    server.closeAllConnections();
    await once(server, "close");
  }
}

test("upload URL permissions reject outsiders and members before accessing storage", async () => {
  await fixture(async ({ request, calls }) => {
    for (const identity of [undefined, "unknown", "member", "pending", "rejected"] as const) {
      const res = await request("/storage/uploads/request-url", identity, metadata);
      assert.equal(res.status, identity ? 403 : 401, String(identity));
      assert.ok((await res.json()).error);
    }
    assert.equal(calls.uploads, 0);
    for (const identity of ["admin", "super_admin"] as const) {
      const res = await request("/storage/uploads/request-url", identity, metadata);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { uploadURL, objectPath });
    }
    assert.equal(calls.uploads, 2);
  });
});

test("only admins can create or import PNMs, without member writes", async () => {
  await fixture(async ({ request, stored }) => {
    const profile = { firstName: "Permission", lastName: "Check" };
    const memberCreate = await request("/pnms", "member", profile);
    assert.equal(memberCreate.status, 403);
    assert.equal(stored.size, 0);

    const memberImport = await request(
      "/pnms/import",
      "member",
      { csv: "first_name,last_name,pronouns,email,year,major,minor,gpa\nNo,Write,,,,,," },
    );
    assert.equal(memberImport.status, 403);
    assert.equal(stored.size, 0);

    const adminCreate = await request("/pnms", "admin", profile);
    assert.equal(adminCreate.status, 201);
    assert.equal(stored.size, 1);

    const adminImport = await request(
      "/pnms/import",
      "admin",
      { csv: "first_name,last_name,pronouns,email,year,major,minor,gpa\nImported,PNM,,,,,," },
    );
    assert.equal(adminImport.status, 200);
    assert.deepEqual(await adminImport.json(), { imported: 1, errors: [] });
    assert.equal(stored.size, 1);
  });
});

test("upload validation rejects invalid types, malformed metadata and files over 5 MB", async () => {
  await fixture(async ({ request, calls }) => {
    for (const body of [
      ...["image/gif", "image/svg+xml", "text/plain", "application/octet-stream"].map(contentType => ({ ...metadata, contentType })),
      { ...metadata, size: maxSize + 1 }, { ...metadata, size: -1 },
      { ...metadata, size: "128" }, { name: "missing-fields.png" },
    ]) {
      const res = await request("/storage/uploads/request-url", "admin", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.ok((await res.json()).error);
    }
    assert.equal(calls.uploads, 0);
    for (const contentType of ["image/jpeg", "image/png", "image/webp"]) {
      const res = await request("/storage/uploads/request-url", "admin", { ...metadata, size: maxSize, contentType });
      assert.equal(res.status, 200, contentType);
      assert.equal((await res.json()).objectPath, objectPath);
    }
  });
});

test("private photos require active membership and stream to members and admins", async () => {
  await fixture(async ({ request, calls, setPhoto, validStagingBytes }) => {
    for (const identity of [undefined, "unknown", "pending", "rejected"] as const) {
      const res = await request(`/storage${objectPath}`, identity);
      assert.equal(res.status, identity ? 403 : 401);
    }
    assert.deepEqual(calls.reads, []);
    assert.equal(calls.downloads, 0);
    for (const identity of ["member", "admin", "super_admin"] as const) {
      const res = await request(`/storage${objectPath}`, identity);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/png");
      assert.equal(res.headers.get("cache-control"), "private, no-store");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), validStagingBytes);
    }
    assert.deepEqual(calls.reads, [objectPath, objectPath, objectPath]);
    setPhoto(Buffer.from("not an image"), "image/png");
    const invalid = await request(`/storage${objectPath}`, "member");
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).error, "Photo content is invalid");
    assert.equal(calls.downloads, 0);
    assert.deepEqual(calls.reads, [objectPath, objectPath, objectPath, objectPath]);
    assert.equal((await request("/storage/objects/uploads/missing", "member")).status, 404);
    assert.equal(calls.downloads, 0);
  });
});

test("profile photo path persists on create and edit and survives independent reloads", async () => {
  await fixture(async ({ request, stored }) => {
    const upload = await request("/storage/uploads/request-url", "admin", metadata);
    assert.equal(upload.status, 200);
    const { objectPath: stagingPath } = await upload.json();
    const profile = { firstName: "Test", lastName: "Candidate", photoPath: stagingPath };
    const created = await request("/pnms", "admin", profile);
    assert.equal(created.status, 201);
    const { id, photoPath } = await created.json();
    assert.match(photoPath, /^\/objects\/photos\/[a-zA-Z0-9-]+$/);
    assert.notEqual(photoPath, stagingPath);
    assert.equal(stored.get(id)?.photo_path, photoPath);
    const reload = async (expected: string | null) => {
      const detail = await request(`/pnms/${id}`, "member");
      assert.equal(detail.status, 200);
      assert.equal((await detail.json()).photoPath, expected);
      const list = await request("/pnms", "member");
      assert.equal(list.status, 200);
      assert.equal((await list.json()).find((p: { id: number }) => p.id === id).photoPath, expected);
    };
    await reload(photoPath);
    const denied = await request(`/pnms/${id}`, "member", { ...profile, photoPath: null }, "PATCH");
    assert.equal(denied.status, 403);
    assert.equal(stored.get(id)?.photo_path, photoPath);
    const edited = await request(`/pnms/${id}`, "admin", { ...profile, photoPath: stagingPath }, "PATCH");
    assert.equal(edited.status, 200);
    const editedPath = (await edited.json()).photoPath;
    assert.match(editedPath, /^\/objects\/photos\/[a-zA-Z0-9-]+$/);
    assert.notEqual(editedPath, stagingPath);
    assert.equal(stored.get(id)?.photo_path, editedPath);
    await reload(editedPath);
    const removed = await request(`/pnms/${id}`, "admin", { ...profile, photoPath: null }, "PATCH");
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).photoPath, null);
    assert.equal(stored.get(id)?.photo_path, null);
    await reload(null);
  });
});

test("replacing a reusable upload cannot change a member's finalized photo", async () => {
  await fixture(async ({ request, setPhoto, validStagingBytes, stored }) => {
    const upload = await request("/storage/uploads/request-url", "admin", metadata);
    const { objectPath: stagingPath } = await upload.json();
    setPhoto(validStagingBytes, "image/png");
    const profile = { firstName: "Immutable", lastName: "Candidate", photoPath: stagingPath };
    const created = await request("/pnms", "admin", profile);
    assert.equal(created.status, 201);
    const { id, photoPath: finalizedPath } = await created.json();
    assert.match(finalizedPath, /^\/objects\/photos\/[a-zA-Z0-9-]+$/);
    assert.equal(stored.get(id)?.photo_path, finalizedPath);

    // Reusing the original PUT URL can replace only the staging object.
    setPhoto(Buffer.from("not an image"), "image/png");
    const failedReuse = await request(`/pnms/${id}`, "admin", profile, "PATCH");
    assert.equal(failedReuse.status, 400);

    const served = await request(`/storage${finalizedPath}`, "member");
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.match(served.headers.get("cache-control")!, /private/);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), validStagingBytes);
  });
});

test("finalization persists the validated bytes when staging changes during save", async () => {
  await fixture(async ({ request, setPhoto, setFinalizationHook, validStagingBytes }) => {
    const upload = await request("/storage/uploads/request-url", "admin", metadata);
    const { objectPath: stagingPath } = await upload.json();
    setPhoto(validStagingBytes, "image/png");
    let replaced = false;
    setFinalizationHook(() => {
      replaced = true;
      setPhoto(Buffer.from("not an image"), "image/png");
    });

    const created = await request("/pnms", "admin", {
      firstName: "Exact",
      lastName: "Bytes",
      photoPath: stagingPath,
    });
    assert.equal(created.status, 201);
    const { photoPath: finalizedPath } = await created.json();
    assert.equal(replaced, true);

    const served = await request(`/storage${finalizedPath}`, "member");
    assert.equal(served.status, 200);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), validStagingBytes);
  });
});

test("create and edit reject invalid stored photos without changing PNM data", async () => {
  await fixture(async ({ request, stored, setPhoto }) => {
    const profile = { firstName: "Test", lastName: "Candidate", photoPath: objectPath };
    const created = await request("/pnms", "admin", profile);
    assert.equal(created.status, 201);
    const { id } = await created.json();
    const original = structuredClone(stored.get(id));
    const png = await imageBytes();
    for (const [bytes, type, size] of [
      [Buffer.from("<script>alert(1)</script>"), "image/png", undefined],
      [png, "image/jpeg", undefined],
      [png, "image/png", png.length + 1],
      [Buffer.alloc(maxSize + 1), "image/png", 128],
      [png.subarray(0, 40), "image/png", undefined],
    ] as [Buffer, string, number | undefined][]) {
      setPhoto(bytes, type, size);
      for (const [path, method] of [["/pnms", "POST"], [`/pnms/${id}`, "PATCH"]]) {
        const response = await request(path, "admin", { ...profile, firstName: "Changed" }, method);
        assert.equal(response.status, 400);
        assert.ok((await response.json()).error);
        assert.equal(stored.size, 1);
        assert.deepEqual(stored.get(id), original);
      }
    }
    // Removing a photo does not require the old bytes to remain valid.
    assert.equal((await request(`/pnms/${id}`, "admin", { ...profile, photoPath: null }, "PATCH")).status, 200);
  });
});