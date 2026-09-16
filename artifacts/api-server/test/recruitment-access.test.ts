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
const verifiedEmailByUser: Record<string, { email: string; name?: string | null } | null> = {};

function resetState() {
  state.users = [];
  state.invites = [];
  state.nextId = 1;
  for (const key of Object.keys(authByUser)) delete authByUser[key];
  for (const key of Object.keys(verifiedEmailByUser)) delete verifiedEmailByUser[key];
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

    if (sql === "SELECT * FROM pgn_users WHERE clerk_id = $1") {
      const member = state.users.find((item) => item.clerk_id === values[0]);
      return { rows: (member ? [copyMember(member)] : []) as T[] };
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

    if (sql.startsWith("SELECT id FROM pgn_users WHERE lower(email)")) {
      const member = state.users.find((item) => item.email === values[0]);
      return { rows: (member ? [{ id: member.id }] : []) as T[] };
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

function buildApp(getVerifiedEmail?: (clerkId: string) => Promise<{ email: string; name?: string | null } | null>) {
  const app = express();
  app.use(express.json());
  const dependencies = {
    pool: fakePool as never,
    getAuth: authForRequest as never,
    ...(getVerifiedEmail ? { getVerifiedEmail: getVerifiedEmail as never } : {}),
  };
  app.use(createRecruitmentRouter(dependencies));
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

test("allows any verified email domain to join and keeps chapter approval pending", async () => {
  state.users.push({
    id: state.nextId++,
    clerk_id: "clerk-admin",
    name: "Chapter Admin",
    email: "admin@vt.edu",
    role: "admin",
    status: "active",
    created_at: new Date("2026-09-16T12:00:00.000Z"),
  });
  state.invites.push({ code: "PGN-VALID", label: "Fall 2026", active: true });
  authByUser.outsider = {
    userId: "clerk-outsider",
    sessionClaims: { email: "outsider@example.com", name: "Outside User" },
  };

  const app = buildApp();
  const joined = await request(app, "POST", "/access/join", { code: "PGN-VALID" }, "outsider");
  assert.equal(joined.status, 201);
  assert.equal(joined.body.email, "outsider@example.com");
  assert.equal(joined.body.role, "pending");
  assert.equal(joined.body.status, "pending");

  const access = await request(app, "GET", "/me", undefined, "outsider");
  assert.equal(access.status, 200);
  assert.equal(access.body.email, "outsider@example.com");
  assert.equal(access.body.status, "pending");
});

test("never promotes the first chapter-code user to Super Admin", async () => {
  state.invites.push({ code: "PGN-VALID", label: "Fall 2026", active: true });
  authByUser.firstUser = {
    userId: "clerk-first-user",
    sessionClaims: { email: "first@example.com", name: "First User" },
  };

  const joined = await request(buildApp(), "POST", "/access/join", { code: "PGN-VALID" }, "firstUser");
  assert.equal(joined.status, 201);
  assert.equal(joined.body.role, "pending");
  assert.equal(joined.body.status, "pending");
});

test("relinks the saved owner to a new Clerk environment only after email verification", async () => {
  state.users.push({
    id: state.nextId++,
    clerk_id: "clerk-development-owner",
    name: "Chapter Owner",
    email: "owner@example.com",
    role: "super_admin",
    status: "active",
    created_at: new Date("2026-09-16T12:00:00.000Z"),
  });
  state.invites.push({ code: "PGN-VALID", label: "Fall 2026", active: true });
  authByUser.productionOwner = {
    userId: "clerk-production-owner",
    sessionClaims: { email: "owner@example.com", name: "Production Owner" },
  };

  const joined = await request(
    buildApp(async () => ({ email: "owner@example.com", name: "Production Owner" })),
    "POST",
    "/access/join",
    { code: "PGN-VALID" },
    "productionOwner",
  );
  assert.equal(joined.status, 201);
  assert.equal(joined.body.role, "super_admin");
  assert.equal(joined.body.status, "active");
  assert.equal(state.users[0]?.clerk_id, "clerk-production-owner");
  assert.equal(state.users[0]?.name, "Chapter Owner");
});

test("does not relink the saved owner when the verified email differs", async () => {
  state.users.push({
    id: state.nextId++,
    clerk_id: "clerk-development-owner",
    name: "Chapter Owner",
    email: "owner@example.com",
    role: "super_admin",
    status: "active",
    created_at: new Date("2026-09-16T12:00:00.000Z"),
  });
  state.invites.push({ code: "PGN-VALID", label: "Fall 2026", active: true });
  authByUser.wrongOwner = {
    userId: "clerk-wrong-owner",
    sessionClaims: { email: "owner@example.com", name: "Wrong User" },
  };

  const joined = await request(
    buildApp(async () => ({ email: "different@example.com", name: "Wrong User" })),
    "POST",
    "/access/join",
    { code: "PGN-VALID" },
    "wrongOwner",
  );
  assert.equal(joined.status, 403);
  assert.deepEqual(joined.body, { error: "A verified email address is required" });
  assert.equal(state.users[0]?.clerk_id, "clerk-development-owner");
});

test("resolves a verified email through Clerk when default session claims omit email", async () => {
  state.users.push({
    id: state.nextId++,
    clerk_id: "clerk-admin",
    name: "Chapter Admin",
    email: "admin@vt.edu",
    role: "admin",
    status: "active",
    created_at: new Date("2026-09-16T12:00:00.000Z"),
  });
  state.invites.push({ code: "PGN-VALID", label: "Fall 2026", active: true });
  authByUser.outsider = { userId: "clerk-outsider", sessionClaims: { sub: "clerk-outsider" } };
  verifiedEmailByUser["clerk-outsider"] = { email: "outsider@example.com", name: "Outside User" };

  const joined = await request(
    buildApp(async (clerkId) => verifiedEmailByUser[clerkId] ?? null),
    "POST",
    "/access/join",
    { code: "PGN-VALID" },
    "outsider",
  );
  assert.equal(joined.status, 201);
  assert.equal(joined.body.email, "outsider@example.com");
  assert.equal(joined.body.name, "Outside User");
  assert.equal(joined.body.status, "pending");
});

test("resolves an existing member by Clerk user ID without requiring an email claim", async () => {
  state.users.push({
    id: state.nextId++,
    clerk_id: "clerk-owner",
    name: "Chapter Owner",
    email: "owner@example.com",
    role: "admin",
    status: "active",
    created_at: new Date("2026-09-16T12:00:00.000Z"),
  });
  authByUser.owner = { userId: "clerk-owner", sessionClaims: { sub: "clerk-owner" } };

  const response = await request(
    buildApp(async () => {
      throw new Error("existing members must not need an email lookup");
    }),
    "GET",
    "/me",
    undefined,
    "owner",
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.email, "owner@example.com");
});

test("blocks unknown or unverified users when Clerk has no verified email", async () => {
  state.invites.push({ code: "PGN-VALID", label: "Fall 2026", active: true });
  authByUser.unknown = { userId: "clerk-unknown", sessionClaims: { sub: "clerk-unknown" } };
  verifiedEmailByUser["clerk-unknown"] = null;

  const response = await request(
    buildApp(async (clerkId) => verifiedEmailByUser[clerkId] ?? null),
    "POST",
    "/access/join",
    { code: "PGN-VALID" },
    "unknown",
  );
  assert.equal(response.status, 403);
  assert.deepEqual(response.body, { error: "A verified email address is required" });
});

test("rejects invalid chapter codes and accepts valid codes for a verified default-claims user", async () => {
  state.users.push({
    id: state.nextId++,
    clerk_id: "clerk-admin",
    name: "Chapter Admin",
    email: "admin@vt.edu",
    role: "admin",
    status: "active",
    created_at: new Date("2026-09-16T12:00:00.000Z"),
  });
  state.invites.push({ code: "PGN-VALID", label: "Fall 2026", active: true });
  authByUser.outsider = { userId: "clerk-outsider", sessionClaims: { sub: "clerk-outsider" } };
  verifiedEmailByUser["clerk-outsider"] = { email: "outsider@example.com" };
  const app = buildApp(async (clerkId) => verifiedEmailByUser[clerkId] ?? null);

  const invalid = await request(app, "POST", "/access/join", { code: "PGN-NOPE" }, "outsider");
  assert.equal(invalid.status, 403);
  assert.deepEqual(invalid.body, { error: "That chapter code is not valid" });

  const valid = await request(app, "POST", "/access/join", { code: "PGN-VALID" }, "outsider");
  assert.equal(valid.status, 201);
  assert.equal(valid.body.email, "outsider@example.com");
  assert.equal(valid.body.status, "pending");
});

test("members cannot delete PNMs", async () => {
  state.users.push({
    id: state.nextId++,
    clerk_id: "clerk-member",
    name: "Chapter Member",
    email: "member@example.com",
    role: "member",
    status: "active",
    created_at: new Date("2026-09-16T12:00:00.000Z"),
  });
  authByUser.member = {
    userId: "clerk-member",
    sessionClaims: { email: "member@example.com", name: "Chapter Member" },
  };

  const response = await request(buildApp(), "DELETE", "/pnms/10", undefined, "member");
  assert.equal(response.status, 403);
  assert.deepEqual(response.body, { error: "You do not have permission to do that" });
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
    sessionClaims: { email: "newmember@example.com", name: "New Member" },
  };
  const app = buildApp();

  const preapproved = await request(app, "POST", "/users", { name: "New Member", email: "newmember@example.com" }, "admin");
  assert.equal(preapproved.status, 201);
  assert.equal(preapproved.body.role, "member");
  assert.equal(preapproved.body.status, "active");
  assert.equal(state.users[1]?.clerk_id, "preapproved:newmember@example.com");

  const firstAuthenticatedRequest = await request(app, "GET", "/me", undefined, "newMember");
  assert.equal(firstAuthenticatedRequest.status, 200);
  assert.equal(firstAuthenticatedRequest.body.id, preapproved.body.id);
  assert.equal(firstAuthenticatedRequest.body.status, "active");
  assert.equal(state.users[1]?.clerk_id, "clerk-member");
});
