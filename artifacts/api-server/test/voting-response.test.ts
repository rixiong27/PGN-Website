import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import express from "express";
import { createRecruitmentRouter } from "../src/routes/recruitment";

test("round results are a candidate array, not a database query envelope", async () => {
  const date = new Date("2026-09-16T12:00:00Z");
  for (const role of ["member", "admin"]) {
    const app = express();
    app.use(createRecruitmentRouter({
      getAuth: (() => ({ userId: "test-user", sessionClaims: { email: "test@vt.edu" } })) as never,
      pool: { query: async (sql: string) => {
        if (sql.includes("FROM pgn_users WHERE")) return { rows: [{ id: 1, clerk_id: "test-user", role, status: "active" }] };
        if (sql.includes("FROM pgn_voting_rounds")) return { rows: [{ id: 1, name: "Round", status: "open", pnm_ids: [2], opened_at: date }] };
        if (sql.includes("AVG(v.score)")) return { rows: [{ pnm_id: 2, pnm_name: "Test PNM", average: "4", vote_count: 1 }] };
        if (sql.includes("SELECT v.score")) return { rows: [{ score: 4, member_name: "Test Member", created_at: date }] };
        throw new Error(`Unexpected SQL: ${sql}`);
      } } as never,
    }));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const response = await fetch(`http://127.0.0.1:${address.port}/voting/rounds/1`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.ok(Array.isArray(body.results));
      assert.equal(body.results.find((item: { pnmId: number }) => item.pnmId === 2).average, 4);
      assert.equal("votes" in body.results[0], role === "admin");
    } finally {
      server.close();
      await once(server, "close");
    }
  }
});