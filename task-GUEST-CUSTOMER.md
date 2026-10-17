# Guest customer brief

Base: origin/release/stable-2-main (release 2 / PR #50), branch feat/guest-customer.
Leave all work uncommitted for the orchestrator. No push, PR, deployment, cloud changes or paid calls.
Foreground local checks only; WEB_PORT=3825, API_PORT=3925, RECALL_PATH=data/test-vectors;
Playwright workers=1. Do not edit voice/onboarding or tests/qa.

Allow guests to chat, follow, stamp, play and view their passport behind GUEST_CUSTOMER.
Require Google at reward claim, rescue reservation and leaderboard access. Link the anonymous
identity on upgrade so its private activity survives. Enforce daily stamps and guest chat limits
on the backend; support owner block/unblock without exposing personal data. Local tests and
substituted Firebase verification are separate from real provider evidence.
