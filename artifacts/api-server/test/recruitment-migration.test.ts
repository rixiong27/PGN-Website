import assert from "node:assert/strict";
import test from "node:test";
import { applyRecruitmentMigration } from "../src/lib/recruitmentMigration";

test("voting migration resets only open legacy votes and is idempotent", async () => {
  const calls: string[] = [];
  let alreadyApplied = false;
  const client = {
    async query(sql: string) {
      calls.push(sql.replace(/\s+/g, " ").trim());
      if (sql.includes("SELECT version FROM pgn_schema_migrations")) {
        return { rows: alreadyApplied ? [{ version: "20260916_binary_voting" }] : [] };
      }
      if (sql.startsWith("INSERT INTO pgn_schema_migrations")) alreadyApplied = true;
      return { rows: [] };
    },
    release() {},
  };
  const migrationPool = { connect: async () => client };

  await applyRecruitmentMigration(migrationPool);
  const deleteIndex = calls.findIndex((call) => call.startsWith("DELETE FROM pgn_votes"));
  const updateIndex = calls.findIndex((call) => call.startsWith("UPDATE pgn_voting_rounds"));
  assert.ok(deleteIndex >= 0);
  assert.ok(updateIndex > deleteIndex);
  assert.equal(calls.filter((call) => call.startsWith("ALTER TABLE")).length, 3);

  calls.length = 0;
  await applyRecruitmentMigration(migrationPool);
  assert.equal(calls.some((call) => call.startsWith("DELETE FROM pgn_votes")), false);
  assert.equal(calls.some((call) => call.startsWith("ALTER TABLE")), false);
});