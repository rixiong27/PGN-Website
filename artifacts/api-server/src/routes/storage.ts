import { Readable } from 'stream';
import { MAX_PHOTO_BYTES, PHOTO_CONTENT_TYPES } from '../lib/photoValidation';
import { getAuth as clerkGetAuth } from '@clerk/express';
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from '@workspace/api-zod';
import { pool as defaultPool } from '@workspace/db';
import { Router, type IRouter, type Request, type Response } from 'express';

import {
  ObjectNotFoundError,
  ObjectStorageService,
} from '../lib/objectStorage';

type StorageDependencies = {
  getAuth: typeof clerkGetAuth;
  pool: Pick<typeof defaultPool, 'query'>;
  objectStorageService: Pick<ObjectStorageService,
    'getObjectEntityUploadURL' | 'normalizeObjectEntityPath' |
    'searchPublicObject' | 'downloadObject' | 'getObjectEntityFile'>;
};

export function createStorageRouter(dependencies: Partial<StorageDependencies> = {}): IRouter {
const router: IRouter = Router();
const getAuth = dependencies.getAuth ?? clerkGetAuth;
const pool = dependencies.pool ?? defaultPool;
const objectStorageService = dependencies.objectStorageService ?? new ObjectStorageService();

type StorageMember = {
  role: 'super_admin' | 'admin' | 'member' | 'pending';
  status: 'active' | 'pending' | 'rejected';
};

async function getActiveMember(req: Request): Promise<StorageMember | null> {
  const clerkId = getAuth(req).userId;
  if (!clerkId) return null;

  const result = await pool.query<StorageMember>(
    'SELECT role, status FROM pgn_users WHERE clerk_id = $1 LIMIT 1',
    [clerkId],
  );
  const member = result.rows[0];
  return member?.status === 'active' ? member : null;
}

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 * Requires auth middleware so public callers cannot mint write-capable URLs.
 */
router.post(
  '/storage/uploads/request-url',
  async (req: Request, res: Response) => {
    const auth = getAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: 'Unauthorized' });

      return;
    }

    const member = await getActiveMember(req);
    if (!member || (member.role !== 'admin' && member.role !== 'super_admin')) {
      res.status(403).json({ error: 'Only chapter admins can upload PNM photos' });
      return;
    }

    const parsed = RequestUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Missing or invalid required fields' });
      return;
    }

    try {
      const { name, size, contentType } = parsed.data;
      if (!PHOTO_CONTENT_TYPES.has(contentType) || size <= 0 || size > MAX_PHOTO_BYTES) {
        res.status(400).json({
          error: 'PNM photos must be JPG, PNG, or WebP images no larger than 5 MB',
        });
        return;
      }

      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const objectPath =
        objectStorageService.normalizeObjectEntityPath(uploadURL);

      res.json(
        RequestUploadUrlResponse.parse({
          uploadURL,
          objectPath,
          metadata: { name, size, contentType },
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, 'Error generating upload URL');
      res.status(500).json({ error: 'Failed to generate upload URL' });
    }
  },
);

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get(
  '/storage/public-objects/*filePath',
  async (req: Request, res: Response) => {
    try {
      const raw = req.params.filePath;
      const filePath = Array.isArray(raw) ? raw.join('/') : raw;
      const file = await objectStorageService.searchPublicObject(filePath);
      if (!file) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      const response = await objectStorageService.downloadObject(file);

      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));

      if (response.body) {
        const nodeStream = Readable.fromWeb(
          response.body as ReadableStream<Uint8Array>,
        );
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      req.log.error({ err: error }, 'Error serving public object');
      res.status(500).json({ error: 'Failed to serve public object' });
    }
  },
);

/**
 * GET /storage/objects/*
 *
 * Serve object entities from PRIVATE_OBJECT_DIR.
 * These are served from a separate path from /public-objects and can optionally
 * be protected with authentication or ACL checks based on the use case.
 */
router.get('/storage/objects/*path', async (req: Request, res: Response) => {
  try {
    if (!getAuth(req).userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!await getActiveMember(req)) {
      res.status(403).json({ error: 'Active chapter membership is required' });
      return;
    }
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join('/') : raw;
    const objectPath = `/objects/${wildcardPath}`;
    const objectFile =
      await objectStorageService.getObjectEntityFile(objectPath);

    // --- Protected route example (uncomment when using replit-auth) ---
    // if (!req.isAuthenticated()) {
    //   res.status(401).json({ error: "Unauthorized" });
    //   return;
    // }
    // const canAccess = await objectStorageService.canAccessObjectEntity({
    //   userId: req.user.id,
    //   objectFile,
    //   requestedPermission: ObjectPermission.READ,
    // });
    // if (!canAccess) {
    //   res.status(403).json({ error: "Forbidden" });
    //   return;
    // }

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(
        response.body as ReadableStream<Uint8Array>,
      );
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, 'Object not found');
      res.status(404).json({ error: 'Object not found' });
      return;
    }
    req.log.error({ err: error }, 'Error serving object');
    res.status(500).json({ error: 'Failed to serve object' });
  }
});

return router;
}

export default createStorageRouter();
