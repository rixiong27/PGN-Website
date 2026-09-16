import assert from "node:assert/strict";
import { once } from "node:events";
import express, { type Request } from "express";
import test from "node:test";
import { createRecruitmentRouter } from "../src/routes/recruitment";

type Role = "member" | "admin" | "super_admin";
type Round = { id: number; status: "open" | "closed" };
type Vote = { round_id: number; pnm_id: number; voter_id: number };

class ClearHistoryDb {
  rounds: Round[] = [
    { id: 11, status: "closed" },
    { id: 12, status: "closed" },
    { id: 13, status: "open" },
  ];
  votes: Vote[] = [
    { round_id: 11, pnm_id: 101, voter_id: 1 },
    { round_id: 12, pnm_id: 102, voter_id: 1 },
    { round_id: 13, pnm_id: 103, voter_id: 1 },
  ];
  activity: Array<{ actor_name: string; action: string; target: string }> = [];
  failActivity = false;
  rollbacks = 0;
  private snapshot: { rounds: Round[]; votes: Vote[]; activity: typeof this.activity } | null = null;

  private rowsForMember(clerkId: string) {
    const role: Role = clerkId === "admin-user" ? "admin" : clerkId === "owner-user" ? "super_admin" : "member";
    return [{
      id: role === "member" ? 1 : role === "admin" ? 2 : 3,
      clerk_id: clerkId,
      name: role === "super_admin" ? "Chapter Owner" : role === "admin" ? "Voting Admin" : "Voting Member",
      email: `${clerkId}@vt.edu`,
      role,
      status: "active",
      created_at: new Date("2026-09-16T12:00:00.000Z"),
    }];
  }

  async query<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    if (sql.startsWith("BEGIN")) {
      this.snapshot = {
        rounds: structuredClone(this.rounds),
        votes: structuredClone(this.votes),
        activity: structuredClone(this.activity),
      };
      return { rows: [] as T[] };
    }
    if (sql === "COMMIT") {
      this.snapshot = null;
      return { rows: [] as T[] };
    }
    if (sql === "ROLLBACK") {
      this.rollbacks += 1;
      if (this.snapshot) {
        this.rounds = this.snapshot.rounds;
        this.votes = this.snapshot.votes;
        this.activity = this.snapshot.activity;
      }
      this.snapshot = null;
      return { rows: [] as T[] };
    }
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] as T[] };
    if (sql.includes("FROM pgn_users WHERE clerk_id = $1")) {
      return { rows: this.rowsForMember(String(values[0])) as T[] };
    }
    if (sql === "SELECT id FROM pgn_voting_rounds WHERE status = 'closed' FOR UPDATE") {
      return { rows: this.rounds.filter((round) => round.status === "closed").map((round) => ({ id: round.id })) as T[] };
    }
    if (sql.startsWith("DELETE FROM pgn_votes")) {
      const ids = values[0] as number[];
      this.votes = this.votes.filter((vote) => !ids.includes(vote.round_id));
      return { rows: [] as T[] };
    }
    if (sql.startsWith("DELETE FROM pgn_voting_rounds")) {
      const ids = values[0] as number[];
      const deleted = this.rounds.filter((round) => ids.includes(round.id) && round.status === "closed");
      this.rounds = this.rounds.filter((round) => !ids.includes(round.id) || round.status !== "closed");
      return { rows: deleted.map((round) => ({ id: round.id })) as T[] };
    }
    if (sql.startsWith("INSERT INTO pgn_activity")) {
      if (this.failActivity) throw new Error("audit insert failed");
      const [actor_name, action, target] = values as string[];
      this.activity.push({ actor_name, action, target });
      return { rows: [] as T[] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }

  connect = async () => ({
    query: this.query.bind(this),
    release: () => undefined,
  });
}

function authForRequest(req: Request) {
  const user = req.header("x-test-user") ?? "member-user";
  return { userId: user, sessionClaims: { email: `${user}@vt.edu`, name: user } };
}

async function request(db: ClearHistoryDb, identity: string) {
  const app = express();
  app.use(express.json());
  app.use(createRecruitmentRouter({ pool: db as never, getAuth: authForRequest as never }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/voting/rounds/history`, {
      method: "DELETE",
      headers: { "x-test-user": identity },
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Express's default error handler returns HTML for an unhandled error.
    }
    return { status: response.status, body };
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("members cannot clear voting history and no data is mutated", async () => {
  const db = new ClearHistoryDb();
  const before = structuredClone({ rounds: db.rounds, votes: db.votes, activity: db.activity });
  const response = await request(db, "member-user");
  assert.equal(response.status, 403);
  assert.deepEqual({ rounds: db.rounds, votes: db.votes, activity: db.activity }, before);
});

test("admins clear only closed rounds, votes, snapshots, and statuses while preserving open rounds", async () => {
  const db = new ClearHistoryDb();
  const response = await request(db, "admin-user");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { deletedCount: 2 });
  assert.deepEqual(db.rounds, [{ id: 13, status: "open" }]);
  assert.deepEqual(db.votes, [{ round_id: 13, pnm_id: 103, voter_id: 1 }]);
  assert.equal(db.activity.length, 1);
  assert.equal(db.activity[0].action, "Cleared voting history");
  assert.match(db.activity[0].target, /^2 closed voting rounds/);
});

test("empty clear is a successful no-op with an audit record", async () => {
  const db = new ClearHistoryDb();
  db.rounds = [{ id: 13, status: "open" }];
  db.votes = [{ round_id: 13, pnm_id: 103, voter_id: 1 }];
  const response = await request(db, "owner-user");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { deletedCount: 0 });
  assert.deepEqual(db.rounds, [{ id: 13, status: "open" }]);
  assert.deepEqual(db.votes, [{ round_id: 13, pnm_id: 103, voter_id: 1 }]);
  assert.equal(db.activity.length, 1);
  assert.match(db.activity[0].target, /^0 closed voting rounds/);
});

test("deletion and audit roll back together when the transaction fails", async () => {
  const db = new ClearHistoryDb();
  db.failActivity = true;
  const before = structuredClone({ rounds: db.rounds, votes: db.votes, activity: db.activity });
  const response = await request(db, "admin-user");
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: "Voting history could not be cleared. No changes were saved." });
  assert.equal(db.rollbacks, 1);
  assert.deepEqual({ rounds: db.rounds, votes: db.votes, activity: db.activity }, before);
});