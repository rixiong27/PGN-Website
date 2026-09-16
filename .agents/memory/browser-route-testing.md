---
name: Browser route test fixtures
description: The Vite-specific approach used to isolate Clerk and API dependencies in browser route tests.
---

Browser tests for the recruitment app can use an explicit test-only environment flag with a Clerk auth double and deterministic API fixtures. A Vite object alias may resolve `@clerk/react` but still leave `@clerk/react/internal` unresolved; replace that subpath in a pre-transform instead of changing the production import.

**Why:** The unresolved subpath prevents the app module from transforming, leaving Chromium at a blank root even though the direct URL and Vite server are healthy.

**How to apply:** Keep the fixture mode gated by an explicit test environment variable, and assert both the protected shell and the route fallback/loading markers so browser failures identify the actual class of regression.