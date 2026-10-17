# Acceptance suite for the 3 critical flows (Codex, gpt-6-luna)

Owner (17 Oct 06:20): only three flows matter now and they MUST work: vendor onboarding, customer first
open, customer scanning the shop QR. Write ONE acceptance spec, tests/acceptance/critical-flows.spec.ts
(phone 360x800 + desktop, light, English AND Hindi), that a release must pass. Fresh worktree from
origin/main. Ports WEB_PORT=3891 API_PORT=3991, RECALL_PATH=data/test-vectors, fresh DB per run. Never run
commands in the background; `--workers=1`. Leave work uncommitted (the orchestrator pushes). Tests only:
change app code only for a real bug (say so). Owner decisions are in docs/OWNER-NOTES.md (top).

1. Vendor onboarding (target behaviour of onboarding v2, branch origin/fix/voice-reliability; write the
   spec against that behaviour and run it on that branch too): text path; one sentence fills name +
   category + area; no menu question; no halal/veg for a non-food business (self-cleaning helmet station);
   GPS pin; hours asked, "pata nahi" skips; photo card with Skip; shop goes live once name+category+pin;
   summary card; face check offered and skippable; "bas" ends the conversation; a socket drop mid-flow
   resumes at the next missing field with no repeated question; "thinking" never stays on (>12 s); Review
   my shop opens at any moment. Lands on Today with "Add your menu" first.
2. Customer first open: language step after sign-in (or first open) with a sensible default; current
   location used when allowed, no free-text location box then; front door ask → results within budget;
   shop page opens with context kept on back.
3. QR scan: scanning a shop's signed QR as a guest and as a signed-in customer gives a stamp; the count
   (incl. 2 welcome stamps) is identical on the shop button, card and passport; a second scan the same day
   gives no extra stamp; a shop with no reward shows no stamps; claiming a full card needs sign-in.
Mark each test with the PR it depends on (#60/#63/#64/onboarding v2) and skip with a clear reason where
that PR is not on the branch yet. Report: what passes on main, on fix/voice-reliability, and what fails.
