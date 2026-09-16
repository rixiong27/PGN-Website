import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import express from "express";
import { createRecruitmentRouter } from "../src/routes/recruitment";

test("roster parses false as active, true as archived, and rejects invalid filters", async () => {
  let archiveFilter: unknown;
  const app = express();
  app.use(createRecruitmentRouter({
    getAuth: (() => ({ userId: "tester", sessionClaims: { email: "test@vt.edu" } })) as never,
    pool: { query: async (sql: string, values: unknown[]) => {
      if (sql.includes("FROM pgn_users")) return { rows: [{ id: 1, clerk_id: "tester", role: "admin", status: "active" }] };
      archiveFilter = values[0];
      return { rows: [] };
    } } as never,
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    for (const [query, expected, status] of [
      ["?archived=false", false, 200], ["?archived=true", true, 200],
      ["", false, 200], ["?archived=invalid", undefined, 400],
    ] as const) {
      archiveFilter = undefined;
      const response = await fetch(`http://127.0.0.1:${address.port}/pnms${query}`);
      assert.equal(response.status, status);
      assert.equal(archiveFilter, expected);
    }
  } finally {
    server.close();
    await once(server, "close");
  }
});