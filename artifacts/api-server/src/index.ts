import app from "./app";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";
import { startPhotoCleanup } from "./lib/photoCleanupScheduler";

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
  // Schema changes are applied by the development post-merge and production
  // publish flows; the API must never mutate schema during startup.
  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
    startPhotoCleanup();
  });
}

start().catch((error) => {
  logger.error({ err: error }, "Database migration failed");
  process.exit(1);
});
