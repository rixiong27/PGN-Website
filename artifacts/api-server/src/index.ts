import app from "./app";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";
import { applyRecruitmentMigration } from "./lib/recruitmentMigration";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function start(): Promise<void> {
  await applyRecruitmentMigration(pool);
  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
  });
}

start().catch((error) => {
  logger.error({ err: error }, "Database migration failed");
  process.exit(1);
});
