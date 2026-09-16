import { pool } from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";
import { InvalidPhotoError, validatePhotoFile } from "./photoValidation";

const storage = new ObjectStorageService();
export const PHOTO_GRACE_MS = 24 * 60 * 60 * 1000;

// The lock also blocks ordinary INSERT/UPDATE statements, including imports.
// Attachment validation must happen AFTER acquiring it to avoid check/delete races.
export async function withPhotoWrite<T>(
  db: typeof pool,
  path: string | null | undefined,
  write: (client: Pick<typeof pool, "query">) => Promise<T>,
  objects: Pick<ObjectStorageService, "getObjectEntityFile"> = storage,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE pgn_pnms IN SHARE ROW EXCLUSIVE MODE");
    if (path) {
      if (!path.startsWith("/objects/uploads/")) throw new InvalidPhotoError("Invalid photo path");
      const file = await objects.getObjectEntityFile(path);
      await validatePhotoFile(file);
    }
    const result = await write(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function cleanupPhotos(
  db: typeof pool = pool,
  objects: Pick<ObjectStorageService, "listPhotoUploads"> = storage,
  now = Date.now(),
) {
  let deleted = 0;
  for await (const file of objects.listPhotoUploads()) {
    const created = Date.parse(String(file.metadata.timeCreated ?? ""));
    // Unknown age/generation fails closed. Grace exceeds the 15-minute PUT URL TTL.
    if (!Number.isFinite(created) || now - created < PHOTO_GRACE_MS || !file.metadata.generation) continue;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("LOCK TABLE pgn_pnms IN SHARE ROW EXCLUSIVE MODE");
      const references = await client.query(
        "SELECT 1 FROM pgn_pnms WHERE photo_path = $1 LIMIT 1",
        [file.objectPath],
      );
      if (!references.rows.length) {
        await file.delete();
        deleted++;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error; // Retry on next run; never delete if the reference check fails.
    } finally {
      client.release();
    }
  }
  return { deleted };
}