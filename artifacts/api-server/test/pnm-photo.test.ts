import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express, { type Request } from "express";
import { createStorageRouter } from "../src/routes/storage";
import { createRecruitmentRouter } from "../src/routes/recruitment";
import { ObjectNotFoundError } from "../src/lib/objectStorage";

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
  calls: { uploads: number; reads: string[]; downloads: number; queries: number };
  stored: Map<number, Record<string, unknown>>;
}) => Promise<void>) {
  const calls = { uploads: 0, reads: [] as string[], downloads: 0, queries: 0 };
  const stored = new Map<number, Record<string, unknown>>();
  const auth = (req: Request) => ({ userId: req.header("x-test-user") ?? null });
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
      if (path !== objectPath) throw new ObjectNotFoundError();
      return { name: path };
    },
    async searchPublicObject() { throw new Error("Unexpected public lookup"); },
    async downloadObject() {
      calls.downloads++;
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600" },
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
    await run({ calls, stored, request: (path, identity, body, method) =>
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
  await fixture(async ({ request, calls }) => {
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
      assert.match(res.headers.get("cache-control")!, /private/);
      assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [137, 80, 78, 71]);
    }
    assert.deepEqual(calls.reads, [objectPath, objectPath, objectPath]);
    assert.equal((await request("/storage/objects/uploads/missing", "member")).status, 404);
    assert.equal(calls.downloads, 3);
  });
});

test("profile photo path persists on create and edit and survives independent reloads", async () => {
  await fixture(async ({ request, stored }) => {
    const upload = await request("/storage/uploads/request-url", "admin", metadata);
    assert.equal(upload.status, 200);
    const { objectPath: returnedPath } = await upload.json();
    const profile = { firstName: "Test", lastName: "Candidate", photoPath: returnedPath };
    const created = await request("/pnms", "admin", profile);
    assert.equal(created.status, 201);
    const { id, photoPath } = await created.json();
    assert.equal(photoPath, returnedPath);
    assert.equal(stored.get(id)?.photo_path, returnedPath);
    const reload = async (expected: string | null) => {
      const detail = await request(`/pnms/${id}`, "member");
      assert.equal(detail.status, 200);
      assert.equal((await detail.json()).photoPath, expected);
      const list = await request("/pnms", "member");
      assert.equal(list.status, 200);
      assert.equal((await list.json()).find((p: { id: number }) => p.id === id).photoPath, expected);
    };
    await reload(returnedPath);
    const denied = await request(`/pnms/${id}`, "member", { ...profile, photoPath: null }, "PATCH");
    assert.equal(denied.status, 403);
    assert.equal(stored.get(id)?.photo_path, returnedPath);
    for (const path of [null, returnedPath]) {
      const edited = await request(`/pnms/${id}`, "admin", { ...profile, photoPath: path }, "PATCH");
      assert.equal(edited.status, 200);
      assert.equal((await edited.json()).photoPath, path);
      assert.equal(stored.get(id)?.photo_path, path);
      await reload(path);
    }
  });
});