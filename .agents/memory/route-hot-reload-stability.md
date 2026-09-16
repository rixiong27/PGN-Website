---
name: Route hot-reload stability
description: Why this app currently avoids React Fast Refresh during development.
---

Keep development full reloads enabled while most authenticated route components remain in one large module.

**Why:** Fast Refresh retained stale hook signatures after generated-client and authentication edits, causing valid route components to fail at their first hook across multiple pages. Cache clears alone did not prevent recurrence.

**How to apply:** Do not re-enable Fast Refresh unless the route components have been split into stable modules and authenticated navigation has been checked across the main sidebar routes.