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