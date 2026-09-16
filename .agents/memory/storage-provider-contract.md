---
name: Storage provider collision semantics
description: Live conditional saves may resolve as no-ops; verify persisted bytes and generation.
---

Do not infer conditional-write protection solely from a rejected save promise.

**Why:** Investigation in the development workspace on 2026-09-16 isolated the earlier no-op to globally mocked crypto UUIDs. The SDK also uses those UUIDs for gccl-invocation-id; repeated invocation IDs resolved without writing, whereas unmocked File.save and streaming collisions rejected with HTTP 412. This points to request replay handling in the transport/provider path; the upstream implementation is opaque.

**How to apply:** Pin only application object IDs in collision tests, not global crypto UUIDs that affect SDK request identities. Keep a separate replay probe if investigating invocation reuse. Assert outgoing preconditions, explicit rejection, and unchanged stored bytes and generation. Confirmation markers must be independent of object-ID generation and unique even for identical-byte attempts. Preserve disposable-prefix isolation.