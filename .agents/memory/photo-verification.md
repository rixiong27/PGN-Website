---
name: Photo verification constraints
description: Why photo verification decodes images and leaves rejected files to delayed cleanup
---

Verify photo bytes by decoding, not just by checking their signature. Bound decoded pixels as well as file size.

**Why:** A valid header can hide corrupt image data, and a small compressed file can expand into excessive memory. The 40-million-pixel limit is an intentional additional safety limit, not an alternate interpretation of the 5 MB upload limit.

**How to apply:** Preserve both limits when changing image tooling. Keep validation inside the attachment/cleanup lock and leave rejected uploads to the delayed cleanup process rather than deleting them during a failed save.

Finalize the exact buffer that passed decoding into a server-only, create-only object. Do not copy or re-read the mutable upload target after verifying it.

**Why:** Signed PUT URLs remain reusable until expiry; a check followed by an unpinned storage copy has a replacement race even if the database write is locked.

**How to apply:** Keep upload targets separate from saved photo paths. Cleanup must cover both temporary uploads and abandoned finalized objects, with the same grace period and reference lock. Legacy upload-path reads must validate and return the same buffer, never stream unchecked replacement bytes.