---
name: Pre-approved member linking
description: The identity handoff between Admin pre-approval and a member's first Clerk-authenticated request.
---

Pre-approved members are active immediately, but their database identity is linked to the real Clerk user only when the first authenticated request presents the same authoritative verified email. Default Clerk session claims do not reliably carry an email, so resolve an existing member by authenticated Clerk user ID first; only use the verified email lookup for pre-approved linking or a new chapter join.

**Why:** Admins need to grant access before a member has completed Clerk sign-up, while normal sign-up users must still be created as pending members.

**How to apply:** Preserve the email match and placeholder identity boundary when changing member provisioning or auth middleware. Treat the authoritative provider's verified email as the source of truth when claims omit it, and never fabricate an email from a Clerk ID. Do not link arbitrary existing accounts by email; only the pre-approved placeholder state is eligible. A prior any-email change locked out valid users because it required `claims.email`/`email_address` before checking an existing `clerk_id`.