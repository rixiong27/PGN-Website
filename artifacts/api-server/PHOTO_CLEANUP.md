# Private PNM photo cleanup

The API runs cleanup on startup and hourly while running. No browser callback or
successful save is required: uploads abandoned after a failed save, deleted PNMs,
removed photos, and replaced photos are all covered, including older uploads.
After downtime the next startup catches up. Inspect server logs for
“Private photo cleanup finished” or “Private photo cleanup failed”.
Failures are retried on the next hourly run.

Only UUID-named objects in the private `uploads/` directory are eligible.
Objects must be at least 24 hours old (well beyond the 15-minute signed PUT URL
lifetime). Unknown ages or generations are skipped. This grace period gives
unfinished forms time to save; forms left open longer may need a fresh upload.

Before deletion the job locks the PNM table and checks every photo reference,
including archived PNMs and shared paths. Attachment writes take the same lock
and verify the object still exists before committing. This prevents a concurrent
save from attaching an object after cleanup decided to delete it. Other private
objects are not scanned. A generation precondition prevents deletion of an
object overwritten since listing. Database/check/storage errors fail closed;
the job never assumes that a failed reference query means an unused object.

The job deletes one object per transaction, keeping lock duration limited to one
storage request. Multiple server replicas coordinate through PostgreSQL locks.
Replacement and removal do not delete inline, so a cleanup outage does not turn
a successful profile save into an error. Bucket objects themselves are the durable
cleanup backlog; no in-memory queue can be lost on a restart.