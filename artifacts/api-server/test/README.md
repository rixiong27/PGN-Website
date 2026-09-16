# API regression tests

Run `pnpm --filter @workspace/api-server test` from the workspace root.

The photo cleanup concurrency tests require PostgreSQL server tools (`initdb`
and `pg_ctl`) on `PATH` and a non-root user. They are included in the normal test
suite and fail rather than silently skip if PostgreSQL is unavailable.

To run only these tests:

```sh
pnpm --filter @workspace/api-server exec tsx --test test/photo-cleanup-postgres.test.ts
```

They create a disposable PostgreSQL cluster in a private temporary directory,
disable TCP listeners, and override `DATABASE_URL` inside their isolated test
process before importing the database module. They never connect to the
configured development or production database. Teardown stops the cluster and
removes its directory. Storage is entirely in memory; no bucket calls are made.

Two real connections exercise the production cleanup/save functions against a
minimal `pgn_pnms` table. Assertions inspect ungranted PostgreSQL locks and their
blocking process IDs rather than infer blocking from a sleep. Raw INSERT/UPDATE
tests establish that table writes are blocked; the validated attachment test
establishes that a deleted photo path cannot be saved. Raw SQL alone does not
validate whether a bucket object exists.

## Opt-in real App Storage contract

```sh
pnpm --filter @workspace/api-server run test:storage-provider
```

Run only in the Replit development workspace with App Storage already configured
(`DEFAULT_OBJECT_STORAGE_BUCKET_ID` and the Replit storage authentication/signing
sidecar). This makes real provider requests and uses a small amount of storage.
The regular test suite skips it without importing the storage adapter or making
provider calls. Once opted in, missing configuration or provider failures fail
the test rather than skip it. `NODE_ENV=production` is explicitly rejected.

Each run uses a fresh `integration-tests/photo-provider/<random UUID>/` prefix
in the configured bucket. It overrides the adapter's private root in a test-only
subclass, never reads `PRIVATE_OBJECT_DIR`, and never connects to a database or
reads member objects. All listing and teardown are scoped to that run's prefix.
Synthetic two-pixel images and unrelated disposable fixtures are removed in
`finally`, even on assertion failure. Cleanup failures report only the test
prefix to remove manually; forcibly killing the process may also leave fixtures.
No signed URL or raw provider error is logged.

The test uses real signed PUTs and GCS operations to verify:

- A staging URL can replace uploaded bytes both before and after finalization.
- Finalization saves the exact buffer returned by image validation, not the
  subsequently replaced staging bytes, with the verified content type.
- A forced UUID collision through the real adapter sends `ifGenerationMatch=0`
  on both outgoing saves and preserves the original bytes and generation.
  If an error is returned it must be HTTP 412, not an unrelated failure.
- Replaying the staging URL does not change the finalized bytes or generation;
  changing its target to the final path is rejected with HTTP 403.
- Enumeration includes both UUID-named uploads and finalized photos, excluding
  nested paths, non-photo assets, and sibling roots; listed deletions preserve
  all unrelated fixtures.

Only UUID generation is temporarily pinned for the collision assertion. A
pass-through SDK request observer checks target equality and generation
preconditions without modifying requests or retaining URLs or credentials.
Storage, signing, image validation, listing, and deletion are not mocked.
This is provider contract coverage, not cleanup-failure recovery or browser testing.

Observed in the development workspace: the provider/SDK resolves the duplicate
conditional save without surfacing HTTP 412, but leaves both bytes and generation
unchanged. The test explicitly reports this outcome and checks persisted state;
it does not treat a resolved promise as evidence that replacement succeeded.
Making the adapter report this collision as an error is separate follow-up work.