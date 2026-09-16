---
name: Storage provider collision semantics
description: Live conditional saves may resolve as no-ops; verify persisted bytes and generation.
---

Do not infer conditional-write protection solely from a rejected save promise.

**Why:** In the development workspace on 2026-09-16, real duplicate saves sent `ifGenerationMatch=0` for the same object and resolved, while the original bytes and generation remained unchanged. This is an observed provider/SDK-path behavior, not a claim about all GCS environments. The adapter's collision error reporting remains a separate concern.

**How to apply:** Provider-contract tests must assert outgoing preconditions and compare stored bytes and generation after the collision. Never accept unchanged bytes alone, since a replacement could write identical content with a new generation. Preserve disposable-prefix isolation when investigating provider behavior.