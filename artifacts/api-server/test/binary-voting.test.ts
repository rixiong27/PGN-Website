import assert from "node:assert/strict";
import { once } from "node:events";
import express, { type Request } from "express";
import test from "node:test";
import { createRecruitmentRouter } from "../src/routes/recruitment";

type User = { id: number; name: string; role: "member" | "admin"; status: "active" | "inactive" };
type Vote = { pnm_id: number; voter_id: number; score: number; created_at: Date };

const openedAt = new Date("2026-09-16T12:00:00.000Z");

class VotingDb {
  users: User[] = [
    { id: 1, name: "Member One", role: "member", status: "active" },
    { id: 2, name: "Member Two", role: "member", status: "active" },
    { id: 99, name: "Voting Admin", role: "admin", status: "active" },
  ];
  votes: Vote[] = [];
  round: Record<string, unknown> = {
    id: 12,
    name: "Binary review",
    status: "open",
    voting_mode: "binary",
    pnm_ids: [42],
    deadline: null,
    opened_at: openedAt,
    closed_at: null,
    electorate_count: null,
    results_snapshot: null,
  };

  activeUsers() {
    return this.users.filter((user) => user.status === "active" && ["member", "admin", "super_admin"].includes(user.role));
  }

  candidateRow() {
    const activeIds = new Set(this.activeUsers().map((user) => user.id));
    const votes = this.votes.filter((vote) => vote.pnm_id === 42 && activeIds.has(vote.voter_id));
    return {
      pnm_id: 42,
      pnm_name: "Taylor Candidate",
      vote_count: votes.length,
      yes_count: votes.filter((vote) => vote.score === 1).length,
      no_count: votes.filter((vote) => vote.score === 0).length,
      my_score: votes.find((vote) => vote.voter_id === (currentUser === "admin-user" ? 99 : 1))?.score ?? null,
    };
  }

  async query<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("pg_advisory_xact_lock")) return { rows: [] as T[] };
    if (sql.includes("FROM pgn_users WHERE clerk_id = $1 OR")) {
      const id = String(values[0]);
      const user = this.users.find((candidate) => candidate.id === Number(id === "admin-user" ? 99 : 1));
      return { rows: (user ? [{ ...user, clerk_id: id, email: `${id}@vt.edu`, created_at: openedAt }] : []) as T[] };
    }
    if (sql === "SELECT * FROM pgn_voting_rounds WHERE id = $1" || sql.includes("FROM pgn_voting_rounds WHERE id = $1 FOR UPDATE") || sql === "SELECT * FROM pgn_voting_rounds WHERE id=$1" || sql.includes("FROM pgn_voting_rounds WHERE id=$1 FOR UPDATE")) {
      return { rows: [structuredClone(this.round)] as T[] };
    }
    if (sql.includes("SELECT id FROM pgn_users WHERE id=$1")) return { rows: [{ id: Number(values[0]) }] as T[] };
    if (sql.includes("SELECT COUNT(*)::int AS count FROM pgn_users WHERE status='active'")) {
      return { rows: [{ count: this.activeUsers().length }] as T[] };
    }
    if (sql.includes("SELECT id, name FROM pgn_users WHERE status='active'")) {
      return { rows: this.activeUsers().map((user) => ({ id: user.id, name: user.name })) as T[] };
    }
    if ((sql.includes("COUNT(voter.id)") || sql.includes("COUNT(u.id)")) && sql.includes("FROM pgn_pnms p")) {
      return { rows: [this.candidateRow()] as T[] };
    }
    if (sql.includes("SELECT v.pnm_id, v.score")) {
      const activeIds = new Set(this.activeUsers().map((user) => user.id));
      return {
        rows: this.votes.filter((vote) => activeIds.has(vote.voter_id)).map((vote) => ({
          pnm_id: vote.pnm_id,
          score: vote.score,
          voter_id: vote.voter_id,
          member_name: this.users.find((user) => user.id === vote.voter_id)?.name,
          created_at: vote.created_at,
        })) as T[],
      };
    }
    if (sql.includes("SELECT v.score, u.id AS voter_id")) {
      const activeIds = new Set(this.activeUsers().map((user) => user.id));
      return {
        rows: this.votes.filter((vote) => activeIds.has(vote.voter_id)).map((vote) => ({
          score: vote.score,
          voter_id: vote.voter_id,
          member_name: this.users.find((user) => user.id === vote.voter_id)?.name,
          created_at: vote.created_at,
        })) as T[],
      };
    }
    if (sql.startsWith("INSERT INTO pgn_votes")) {
      const [roundId, pnmId, voterId, score] = values as number[];
      this.votes = this.votes.filter((vote) => !(vote.pnm_id === pnmId && vote.voter_id === voterId));
      this.votes.push({ pnm_id: pnmId, voter_id: voterId, score, created_at: new Date() });
      return { rows: [{ round_id: roundId }] as T[] };
    }
    if (sql.includes("UPDATE pgn_voting_rounds") && sql.includes("results_snapshot")) {
      const [, electorateCount, rawSnapshot] = values;
      this.round.status = "closed";
      this.round.closed_at = new Date();
      this.round.electorate_count = electorateCount;
      this.round.results_snapshot = JSON.parse(String(rawSnapshot));
      return { rows: [structuredClone(this.round)] as T[] };
    }
    throw new Error(`Unexpected test query: ${sql}`);
  }

  connect = async () => ({
    query: this.query.bind(this),
    release: () => undefined,
  });
}

let currentUser = "member-user";
function authForRequest(_req: Request) {
  return {
    userId: currentUser,
    sessionClaims: {
      email: `${currentUser}@vt.edu`,
      name: currentUser === "admin-user" ? "Voting Admin" : "Voting Member",
    },
  };
}

async function request(db: VotingDb, method: string, path: string, body?: unknown) {
  const app = express();
  app.use(express.json());
  app.use(createRecruitmentRouter({ pool: db as never, getAuth: authForRequest as never }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("binary results use the live electorate and show zero-vote rounds honestly", async () => {
  const db = new VotingDb();
  db.votes.push({ pnm_id: 42, voter_id: 404, score: 1, created_at: openedAt });
  currentUser = "member-user";
  const response = await request(db, "GET", "/voting/rounds/12");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.results[0], {
    pnmId: 42,
    pnmName: "Taylor Candidate",
    voteCount: 0,
    yesCount: 0,
    noCount: 0,
    notVotedCount: 3,
    electorateCount: 3,
    yesPercentage: 0,
    noPercentage: 0,
    notVotedPercentage: 100,
    myChoice: null,
  });
});

test("binary choice persists through reload and closed snapshots do not change", async () => {
  const db = new VotingDb();
  currentUser = "member-user";
  const saved = await request(db, "POST", "/voting/rounds/12/votes", { pnmId: 42, choice: "yes" });
  assert.equal(saved.status, 201);
  const reloaded = await request(db, "GET", "/voting/rounds/12");
  assert.equal(reloaded.body.results[0].myChoice, "yes");
  assert.equal(reloaded.body.results[0].yesPercentage, 33.3);

  currentUser = "admin-user";
  const closed = await request(db, "POST", "/voting/rounds/12/close");
  assert.equal(closed.status, 200);
  assert.equal(closed.body.electorateCount, 3);
  db.users[1].status = "inactive";
  db.votes.push({ pnm_id: 42, voter_id: 2, score: 0, created_at: new Date() });
  currentUser = "member-user";
  const history = await request(db, "GET", "/voting/rounds/12");
  assert.equal(history.body.results[0].yesCount, 1);
  assert.equal(history.body.results[0].noCount, 0);
  assert.equal(history.body.results[0].electorateCount, 3);
  currentUser = "admin-user";
  const adminHistory = await request(db, "GET", "/voting/rounds/12");
  assert.deepEqual(adminHistory.body.results[0].votes.map((vote: { choice: string }) => vote.choice), ["yes"]);
  const lateVote = await request(db, "POST", "/voting/rounds/12/votes", { pnmId: 42, choice: "no" });
  assert.equal(lateVote.status, 409);
});