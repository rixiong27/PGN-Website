import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import express, { type Request } from "express";
import { createRecruitmentRouter } from "../src/routes/recruitment";

const openedAt = new Date("2026-09-16T12:00:00.000Z");
const memberCreatedAt = new Date("2026-09-01T12:00:00.000Z");
const voteCreatedAt = new Date("2026-09-16T12:30:00.000Z");

const fakePool = {
  async query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> {
    if (sql.includes("FROM pgn_users WHERE clerk_id = $1 OR")) {
      return {
        rows: [{
          id: 7,
          clerk_id: currentUserId,
          name: currentRole === "admin" ? "Voting Admin" : "Voting Member",
          email: `${currentUserId}@vt.edu`,
          role: currentRole,
          status: "active",
          created_at: memberCreatedAt,
        }] as T[],
      };
    }

    if (sql === "SELECT * FROM pgn_voting_rounds WHERE id = $1") {
      return {
        rows: [{
          id: 12,
          name: "Fall Candidate Review",
          status: "open",
          pnm_ids: [42],
          deadline: null,
          opened_at: openedAt,
          closed_at: null,
        }] as T[],
      };
    }

    if (sql.includes("FROM pgn_pnms p LEFT JOIN pgn_votes")) {
      return {
        rows: [{
          pnm_id: 42,
          pnm_name: "Taylor Candidate",
          average: "3.50",
          vote_count: 2,
        }] as T[],
      };
    }

    if (sql.includes("SELECT v.score, u.name AS member_name")) {
      return {
        rows: [{
          score: 4,
          member_name: "Voting Member",
          created_at: voteCreatedAt,
        }] as T[],
      };
    }

    throw new Error(`Unexpected test query: ${sql}`);
  },
};

let currentUserId = "member-user";
let currentRole: "member" | "admin" = "member";

function authForRequest(_req: Request) {
  return {
    userId: currentUserId,
    sessionClaims: {
      email: `${currentUserId}@vt.edu`,
      name: currentRole === "admin" ? "Voting Admin" : "Voting Member",
    },
  };
}

const app = express();
app.use(express.json());
app.use(createRecruitmentRouter({
  pool: fakePool as never,
  getAuth: authForRequest as never,
}));

async function getVotingRound() {
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not start");
  }

  const response = await fetch(`http://127.0.0.1:${address.port}/voting/rounds/12`);
  const body = await response.json();
  server.close();
  await once(server, "close");
  return { status: response.status, body };
}

test("returns voting results as an array for an authenticated member", async () => {
  currentUserId = "member-user";
  currentRole = "member";

  const response = await getVotingRound();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.results));
  assert.deepEqual(response.body.results, [{
    pnmId: 42,
    pnmName: "Taylor Candidate",
    average: 3.5,
    voteCount: 2,
  }]);
});

test("includes individual votes in the results array for an authenticated admin", async () => {
  currentUserId = "admin-user";
  currentRole = "admin";

  const response = await getVotingRound();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.results));
  assert.deepEqual(response.body.results, [{
    pnmId: 42,
    pnmName: "Taylor Candidate",
    average: 3.5,
    voteCount: 2,
    votes: [{
      score: 4,
      memberName: "Voting Member",
      createdAt: voteCreatedAt.toISOString(),
    }],
  }]);
});