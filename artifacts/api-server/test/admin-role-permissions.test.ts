import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import express from "express";
import { createRecruitmentRouter } from "../src/routes/recruitment";

test("admins manage roles, members cannot, and the owner stays protected", async () => {
  for (const [actor, target, status] of [
    ["admin", "member", 200],
    ["admin", "admin", 200],
    ["member", "member", 403],
    ["admin", "super_admin", 403],
    ["super_admin", "member", 200],
  ] as const) {
    const member = { id: 2, name: "Test", email: "test@vt.edu", clerk_id: "target", role: target, status: "active", created_at: new Date() };
    let updated = false;
    const app = express();
    app.use(express.json());
    app.use(createRecruitmentRouter({
      getAuth: (() => ({ userId: "actor", sessionClaims: { email: "actor@vt.edu" } })) as never,
      pool: { query: async (sql: string, values: unknown[]) => {
        if (sql.includes("WHERE clerk_id")) return { rows: [{ ...member, id: 1, clerk_id: "actor", role: actor }] };
        if (sql.startsWith("SELECT * FROM pgn_users WHERE id=")) return { rows: [member] };
        if (sql.startsWith("UPDATE pgn_users SET role=")) {
          updated = true;
          return { rows: [{ ...member, role: values[0] }] };
        }
        if (sql.startsWith("INSERT INTO pgn_activity")) return { rows: [] };
        throw new Error(`Unexpected query: ${sql}`);
      } } as never,
    }));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const response = await fetch(`http://127.0.0.1:${address.port}/users/2/role`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: target === "admin" ? "member" : "admin" }),
      });
      assert.equal(response.status, status);
      assert.equal(updated, status === 200);
    } finally {
      server.close();
      await once(server, "close");
    }
  }
});