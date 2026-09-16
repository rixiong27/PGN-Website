import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express, { type Request } from "express";
import { createRecruitmentRouter } from "../src/routes/recruitment";

type TestMember = {
  id: number;
  clerk_id: string;
  name: string;
  email: string;
  role: "super_admin" | "admin" | "member" | "pending";
  status: "active" | "pending" | "rejected";
  created_at: Date;
};

type TestState = {
  users: TestMember[];
  invites: Array<{ code: string; label: string; active: boolean }>;
  nextId: number;
};

const state: TestState = { users: [], invites: [], nextId: 1 };
const authByUser: Record<string, { userId: string | null; sessionClaims?: Record<string, unknown> }> = {};

function resetState() {
  state.users = [];
  state.invites = [];
  state.nextId = 1;
  for (const key of Object.keys(authByUser)) delete authByUser[key];
}

function copyMember(member: TestMember): TestMember {
  return { ...member, created_at: new Date(member.created_at) };
}

const fakePool = {
  async query<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    if (sql.includes("FROM pgn_invites")) {
      const invite = state.invites.find((item) => item.code === values[0] && item.active);
      return { rows: (invite ? [{ label: invite.label }] : []) as T[] };
    }

    if (sql.includes("FROM pgn_users WHERE clerk_id = $1 OR")) {
      const [clerkId, email] = values as [string, string];
      const member = state.users.find((item) => item.clerk_id === clerkId || (item.email === email && item.clerk_id.startsWith("preapproved:")));
      return { rows: (member ? [copyMember(member)] : []) as T[] };
    }

    if (sql.startsWith("UPDATE pgn_users SET clerk_id")) {
      const [clerkId, id] = values as [string, number];
      const member = state.users.find((item) => item.id === id);
      if (!member) return { rows: [] };
      member.clerk_id = clerkId;
      return { rows: [copyMember(member)] as T[] };
    }

    if (sql.includes("SELECT COUNT(*)::text AS count FROM pgn_users")) {
      return { rows: [{ count: String(state.users.length) }] as T[] };
    }

    if (sql.startsWith("SELECT * FROM pgn_users WHERE lower(email)")) {
      const member = state.users.find((item) => item.email === values[0]);
      return { rows: (member ? [copyMember(member)] : []) as T[] };
    }

    if (sql.startsWith("INSERT INTO pgn_users")) {
      const [clerkId, name, email, role, status] = values as [string, string, string, TestMember["role"], TestMember["status"]];
      const member: TestMember = {
        id: state.nextId++,
        clerk_id: clerkId,
        name,
        email,
        role,
        status,
        created_at: new Date("2026-09-16T12:00:00.000Z"),
      };
      state.users.push(member);
      return { rows: [copyMember(member)] as T[] };
    }

    if (sql.startsWith("INSERT INTO pgn_activity")) return { rows: [] as T[] };
    throw new Error(`Unexpected test query: ${sql}`);
  },
};

function authForRequest(req: Request) {
  return authByUser[String(req.headers["x-test-user"] ?? "")] ?? { userId: null };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(createRecruitmentRouter({
    pool: fakePool as never,
    getAuth: authForRequest as never,
  }));
  return app;
}

async function request(app: express.Express, method: string, path: string, body?: unknown, user?: string) {
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not start");

  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(user ? { "x-test-user": user } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  server.close();
  await once(server, "close");
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test.beforeEach(resetState);

test("validates active and invalid invite codes without requiring sign-in", async () => {
  state.invites.push({ code: "PGN-VALID", label: "Fall 2026", active: true });
  const app = buildApp();

  const valid = await request(app, "POST", "/access/invite", { code: " PGN-VALID " });
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.body, { valid: true, label: "Fall 2026" });

  const invalid = await request(app, "POST", "/access/invite", { code: "PGN-NOPE" });
  assert.equal(invalid.status, 200);
  assert.deepEqual(invalid.body, { valid: false, label: null });
});

test("rejects non-vt.edu sessions before touching member access", async () => {
  authByUser.outsider = {
    userId: "clerk-outsider",
    sessionClaims: { email: "outsider@example.com", name: "Outside User" },
  };

  const response = await request(buildApp(), "GET", "/me", undefined, "outsider");
  assert.equal(response.status, 403);
  assert.deepEqual(response.body, { error: "A vt.edu email address is required" });
  assert.equal(state.users.length, 0);
});

test("returns 401 for signed-out protected routes", async () => {
  const app = buildApp();
  const me = await request(app, "GET", "/me");
  const dashboard = await request(app, "GET", "/dashboard");

  assert.equal(me.status, 401);
  assert.equal(dashboard.status, 401);
  assert.deepEqual(me.body, { error: "Sign in required" });
});

test("gates pending members while leaving their access profile readable", async () => {
  state.users.push({
    id: state.nextId++,
    clerk_id: "clerk-pending",
    name: "Pending Member",
    email: "pending@vt.edu",
    role: "pending",
    status: "pending",
    created_at: new Date("2026-09-16T12:00:00.000Z"),
  });
  authByUser.pending = {
    userId: "clerk-pending",
    sessionClaims: { email: "pending@vt.edu", name: "Pending Member" },
  };
  const app = buildApp();

  const me = await request(app, "GET", "/me", undefined, "pending");
  assert.equal(me.status, 200);
  assert.equal(me.body.status, "pending");

  const dashboard = await request(app, "GET", "/dashboard", undefined, "pending");
  assert.equal(dashboard.status, 403);
  assert.deepEqual(dashboard.body, { error: "Your chapter account is awaiting approval" });
});

test("links an admin pre-approved member to Clerk on the first authenticated request", async () => {
  state.users.push({
    id: state.nextId++,
    clerk_id: "clerk-admin",
    name: "Chapter Admin",
    email: "admin@vt.edu",
    role: "admin",
    status: "active",
    created_at: new Date("2026-09-16T12:00:00.000Z"),
  });
  authByUser.admin = {
    userId: "clerk-admin",
    sessionClaims: { email: "admin@vt.edu", name: "Chapter Admin" },
  };
  authByUser.newMember = {
    userId: "clerk-member",
    sessionClaims: { email: "newmember@vt.edu", name: "New Member" },
  };
  const app = buildApp();

  const preapproved = await request(app, "POST", "/users", { name: "New Member", email: "newmember@vt.edu" }, "admin");
  assert.equal(preapproved.status, 201);
  assert.equal(preapproved.body.role, "member");
  assert.equal(preapproved.body.status, "active");
  assert.equal(state.users[1]?.clerk_id, "preapproved:newmember@vt.edu");

  const firstAuthenticatedRequest = await request(app, "GET", "/me", undefined, "newMember");
  assert.equal(firstAuthenticatedRequest.status, 200);
  assert.equal(firstAuthenticatedRequest.body.id, preapproved.body.id);
  assert.equal(firstAuthenticatedRequest.body.status, "active");
  assert.equal(state.users[1]?.clerk_id, "clerk-member");
});
