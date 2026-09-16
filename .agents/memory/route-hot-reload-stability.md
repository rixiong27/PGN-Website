---
name: Route hot-reload stability
description: Why this app currently avoids React Fast Refresh during development.
---

Keep development full reloads enabled while most authenticated route components remain in one large module.

**Why:** Full reloads were chosen as a precaution after cross-page errors, but Fast Refresh was never confirmed as the cause. The reported Voting crash persisted and was traced to an API response-shape mismatch. Do not assume hook warnings or component-stack locations identify the original exception.

**How to apply:** Preserve the current reload preference unless deliberately reassessed. For crashes, inspect the actual exception and API response shape before blaming caches or hook identities.