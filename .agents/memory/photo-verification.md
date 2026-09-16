---
name: Photo verification constraints
description: Why photo verification decodes images and leaves rejected files to delayed cleanup
---

Verify photo bytes by decoding, not just by checking their signature. Bound decoded pixels as well as file size.

**Why:** A valid header can hide corrupt image data, and a small compressed file can expand into excessive memory. The 40-million-pixel limit is an intentional additional safety limit, not an alternate interpretation of the 5 MB upload limit.

**How to apply:** Preserve both limits when changing image tooling. Keep validation inside the attachment/cleanup lock and leave rejected uploads to the delayed cleanup process rather than deleting them during a failed save.