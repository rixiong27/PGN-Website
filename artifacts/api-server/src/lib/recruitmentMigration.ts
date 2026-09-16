type QueryResult = { rows: Array<Record<string, unknown>> };

type MigrationClient = {
  query: (sql: string, values?: unknown[]) => Promise<QueryResult>;
  release: () => void;
};

type MigrationPool = {
  connect: () => Promise<MigrationClient>;
};

const votingMigration = "20260916_binary_voting";

/**
 * Applies the voting schema and converts pre-feature open rounds exactly once.
 *
 * This intentionally lives outside request handling. The migration is guarded
 * by a database row and runs in one transaction, so two API processes cannot
 * both clear an old round or observe half of the new schema.
 */
export async function applyRecruitmentMigration(pool: MigrationPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS pgn_schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [votingMigration],
    );
    const applied = await client.query(
      "SELECT version FROM pgn_schema_migrations WHERE version = $1 FOR UPDATE",
      [votingMigration],
    );
    if (!applied.rows.length) {
      await client.query("ALTER TABLE pgn_voting_rounds ADD COLUMN IF NOT EXISTS voting_mode text");
      await client.query("ALTER TABLE pgn_voting_rounds ADD COLUMN IF NOT EXISTS electorate_count integer");
      await client.query("ALTER TABLE pgn_voting_rounds ADD COLUMN IF NOT EXISTS results_snapshot jsonb");
      // Open legacy 1–5 ballots are intentionally discarded during the
      // migration. Closed legacy rounds are historical and remain untouched.
      await client.query(`
        DELETE FROM pgn_votes
        WHERE round_id IN (
          SELECT id FROM pgn_voting_rounds
          WHERE status = 'open' AND voting_mode IS DISTINCT FROM 'binary'
        )
      `);
      await client.query(`
        UPDATE pgn_voting_rounds
        SET voting_mode = 'binary'
        WHERE status = 'open' AND voting_mode IS DISTINCT FROM 'binary'
      `);
      await client.query(
        "INSERT INTO pgn_schema_migrations (version) VALUES ($1)",
        [votingMigration],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}