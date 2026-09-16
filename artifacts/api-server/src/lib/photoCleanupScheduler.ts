import { cleanupPhotos } from "./photoCleanup";
import { logger } from "./logger";

export function startPhotoCleanup() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      logger.info(await cleanupPhotos(), "Private photo cleanup finished");
    } catch (err) {
      logger.error({ err }, "Private photo cleanup failed; will retry in one hour");
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), 60 * 60 * 1000);
  timer.unref();
}