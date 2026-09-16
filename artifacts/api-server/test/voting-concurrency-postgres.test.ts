import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import { after, before, test } from "node:test";

// This suite intentionally starts an isolated temporary PostgreSQL cluster.
// It never reads or writes DATABASE_URL, so the real recruitment database is
// not involved in concurrency coverage.
let directory = "";
let started = false;
let pool: typeof import("@workspace/db").pool;
let createRecruitmentRouter: typeof import("../src/routes/recruitment").createRecruitmentRouter;

const authForRequest = (req: express.Request) => {
  const userId = req.header("x-test-user") ?? "member-one";
  return {
    userId,
    sessionClaims: { email: `${userId}@vt.edu`, name: userId },
  };
};

async function request(
  server: Server,
  method: string,
  path: string,
  body: unknown,
  userId: string,
) {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-test-user": userId },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "voting-pg-"));
  execFileSync("initdb", [
    "-D", join(directory, "data"), "-A", "trust", "-U", "postgres", "--no-locale",
  ], { stdio: "pipe" });
  execFileSync("pg_ctl", [
    "-D", join(directory, "data"),
    "-l", join(directory, "postgres.log"),
    "-o", `-k ${directory} -c listen_addresses='' -c fsync=off`,
    "-w", "start",
  ], { stdio: "pipe", timeout: 15_000 });
  started = true;
  process.env.DATABASE_URL = `postgresql://postgres@localhost/postgres?host=${encodeURIComponent(directory)}`;
  ({ pool } = await import("@workspace/db"));
  ({ createRecruitmentRouter } = await import("../src/routes/recruitment"));

  await pool.query(`
    CREATE TABLE pgn_users (
      id integer PRIMARY KEY,
      clerk_id text NOT NULL UNIQUE,
      name text NOT NULL,
      email text NOT NULL UNIQUE,
      role text NOT NULL,
      status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    );
    CREATE TABLE pgn_pnms (
      id integer PRIMARY KEY,
      first_name text NOT NULL,
      last_name text NOT NULL
    );
    CREATE TABLE pgn_voting_rounds (
      id integer PRIMARY KEY,
      name text NOT NULL,
      status text NOT NULL,
      voting_mode text NOT NULL,
      pnm_ids integer[] NOT NULL,
      deadline timestamptz,
      opened_at timestamptz NOT NULL DEFAULT NOW(),
      closed_at timestamptz,
      electorate_count integer,
      results_snapshot jsonb,
      candidate_statuses jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE pgn_votes (
      id serial PRIMARY KEY,
      round_id integer NOT NULL,
      pnm_id integer NOT NULL,
      voter_id integer NOT NULL,
      score integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      UNIQUE (round_id, pnm_id, voter_id)
    );
    INSERT INTO pgn_users (id, clerk_id, name, email, role, status) VALUES
      (1, 'member-one', 'Member One', 'member-one@vt.edu', 'member', 'active'),
      (2, 'member-two', 'Member Two', 'member-two@vt.edu', 'member', 'active'),
      (3, 'chapter-owner', 'Chapter Owner', 'chapter-owner@vt.edu', 'super_admin', 'active');
    INSERT INTO pgn_pnms (id, first_name, last_name) VALUES (42, 'Taylor', 'Candidate');
    INSERT INTO pgn_voting_rounds (id, name, status, voting_mode, pnm_ids)
      VALUES (12, 'Concurrency', 'open', 'binary', ARRAY[42]::integer[]);
  `);
});

after(async () => {
  if (pool) await pool.end();
  if (started) {
    execFileSync("pg_ctl", [
      "-D", join(directory, "data"), "-m", "immediate", "-w", "stop",
    ], { stdio: "pipe" });
  }
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function app() {
  const server = express();
  server.use(express.json());
  server.use(createRecruitmentRouter({ pool: pool as never, getAuth: authForRequest as never }));
  return server;
}

test("real PostgreSQL concurrent votes remain unique and return no 500", async () => {
  const server = app().listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const responses = await Promise.all([
      request(server, "POST", "/voting/rounds/12/votes", { pnmId: 42, choice: "yes" }, "member-one"),
      request(server, "POST", "/voting/rounds/12/votes", { pnmId: 42, choice: "no" }, "member-two"),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 201]);
    const saved = await pool.query(
      "SELECT voter_id, score FROM pgn_votes WHERE round_id = 12 AND pnm_id = 42 ORDER BY voter_id",
    );
    assert.deepEqual(saved.rows, [
      { voter_id: 1, score: 1 },
      { voter_id: 2, score: 0 },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("real PostgreSQL close and vote overlap settles as closed or before-close, never 500", async () => {
  const server = app().listen(0, "127.0.0.1");
  await once(server, "listening");
  await pool.query("DELETE FROM pgn_votes; UPDATE pgn_voting_rounds SET candidate_statuses='{}'::jsonb;");
  const blocker = await pool.connect();
  try {
    // Hold the same advisory lock used by both routes so both requests overlap
    // while waiting for the round's serialized decision point.
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock($1)", [12]);
    const closing = request(
      server,
      "PATCH",
      "/voting/rounds/12/pnms/42/status",
      { status: "closed" },
      "chapter-owner",
    );
    const voting = request(
      server,
      "POST",
      "/voting/rounds/12/votes",
      { pnmId: 42, choice: "yes" },
      "member-one",
    );
    await delay(20);
    await blocker.query("COMMIT");
    const [closeResponse, voteResponse] = await Promise.all([closing, voting]);
    assert.equal(closeResponse.status, 200);
    assert.ok([201, 409].includes(voteResponse.status), JSON.stringify(voteResponse.body));
    const state = await pool.query(
      "SELECT candidate_statuses FROM pgn_voting_rounds WHERE id = 12",
    );
    assert.deepEqual(state.rows[0].candidate_statuses, { "42": "closed" });
    const saved = await pool.query(
      "SELECT COUNT(*)::int AS count FROM pgn_votes WHERE round_id = 12 AND pnm_id = 42 AND voter_id = 1",
    );
    assert.ok([0, 1].includes(Number(saved.rows[0].count)));
    if (voteResponse.status === 409) assert.equal(Number(saved.rows[0].count), 0);
  } finally {
    try {
      await blocker.query("ROLLBACK");
    } catch {
      // The blocker may already have committed.
    }
    blocker.release();
    server.close();
    await once(server, "close");
  }
});