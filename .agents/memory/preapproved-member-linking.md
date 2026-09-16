---
name: Pre-approved member linking
description: The identity handoff between Admin pre-approval and a member's first Clerk-authenticated request.
---

Pre-approved members are active immediately, but their database identity is linked to the real Clerk user only when the first authenticated request presents the same vt.edu email.

**Why:** Admins need to grant access before a member has completed Clerk sign-up, while normal sign-up users must still be created as pending members.

**How to apply:** Preserve the email match and placeholder identity boundary when changing member provisioning or auth middleware. Do not link arbitrary existing accounts by email; only the pre-approved placeholder state is eligible.