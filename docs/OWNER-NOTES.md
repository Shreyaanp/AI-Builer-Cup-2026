# Owner notes (consolidated, newest first)

Single place for everything the owner asked for in conversation. PLAN-V2.md holds the plan and
status; this file holds the owner's intent so nothing is lost across resets. Keep both updated.

## 17 Oct, 05:10 (tour story)

- "The story I want to sell is not there; update the tour account with meaningful data so a
  person sees the application at its best, all the features it can provide."
- Two honestly labelled demo worlds: eight Bengaluru shops and five Singapore shops, with
  local menus, prices, hours, payments and languages. One owner tour shop per world has eight
  weeks of sales, forecasts, Today, rescue, rewards, replied chats, supplier documents and a
  playbook; the customer can discover, chat and explore their passport.
- Use a repeatable, idempotent seed with an explicit reset and a two-minute judge walk.
  This task is local and uncommitted; production demo preparation is owner-run only.

## 16 Oct, ~06:00 (Google services)

- Add, each behind a switch with a fallback: Gemini grounding with Google Maps (top priority) and Routes
  API (account 3 search task); Document AI, Vertex AI Agent Engine, Looker Studio dashboard (Codex).
  Imagen dropped (not needed). Never claim a service in the deck/video that is not actually used.

## 16 Oct, ~05:45 (Recommendations AI)

- Use the INR 57,593 Recommendations AI trial (only usable on Recommendations AI): catalog import now,
  "Similar items" model training (no events needed, 2-5 days, likely ready ~20-21 Oct for judging and the
  finale), real user events only (never synthetic), app falls back to the embeddings engine until ready.
  First step of the account 3 search-engine task. Owner wants every Google product leveraged properly.

## 16 Oct, ~05:00 (shipping plan)

- **Feature cutoff: Friday 16 Oct midnight IST.** After that only fixes, polish, video, deck. Every new
  feature sits behind a switch; anything not green by the cutoff is hidden, never shipped half-done
  ("if it does not work, it does not ship"). Voice, images and photos must be perfectly in sync.
- Saturday: demo video (< 3 min, real screen recordings via the story-director walks, assembled with
  HyperFrames, voice-over in our Achernar voice via Google TTS), deck as PDF in English mapped to the
  rubric (40/25/25/10) with impact numbers, moat and architecture diagram, rule-book compliance pass,
  tag the submitted commit, history rewrite, submit.
- DevOps: release from one tagged commit with full runtime config (ship script currently skips env),
  faster CI, small load test + architecture diagram ("scalable" = shown, not claimed).
- Cloud Run min-instances=1 from Saturday until judging ends (owner approved; free credit).
- Codex queue (in order): PR integration + regression fixes, guide/payments/landing, shop playbook,
  voice-everything + instant path + context caching + latency (scratchpad task-VOICE-EVERYTHING.md),
  Google services: Document AI, Agent Engine, Looker Studio (scratchpad task-GOOGLE-SERVICES.md),
  DevOps hardening (scratchpad task-DEVOPS.md), multi-agent ADK, story-director fix briefs.
- Account 3: max 2 sessions at a time (owner 05:20: build longer, not burn the window at once).

## 16 Oct, ~04:30 (shop playbook)

- Hyper-personalization via a per-shop "shop playbook": coach asks 2-3 extra skippable onboarding
  questions (goals, busiest times, regulars); Gemini builds a structured playbook (goals, key metrics,
  watch-list, segments, vocabulary, tone) from answers + menu + data; refreshed weekly; drives Today,
  coach and Grow; visible/editable under You. Codex builds it next (brief: scratchpad task-SHOP-PLAYBOOK.md).

## 16 Oct, ~04:05 (workers)

- Claude orchestrates only (no feature code). Account 3 and Codex never idle. Account 2 sunset after
  its two current tasks. Antigravity: gemini-3.8-flash-low for testing / finding issues.

## 16 Oct, ~04:00 (owner tabs and Today)

- Approved: Grow replaces Google, You replaces Privacy, Shop (was My shop) light refinement. Design
  canvas https://claude.ai/artifact/HMmcAECR75pfTFdQ7LbskH. Theme NEVER changes (same Chalkboard
  tokens/fonts; owner calm, customer flashy via the `audience` switch; MUI Material 3).
- Today must be meaningful (owner, 04:20): greeting + one daily personal coach line (never generic);
  "Needs you now" (max 3); "Your shop today" pulse: yesterday sales, customers who looked/asked,
  stamps/regulars, today forecast (each only if data exists; tap → coach chart); day one = warm
  "Let's get <shop> online" with next step + mic.
- Today page (Coach tab, name kept "Coach"): anything complete goes away. Thin progress bar only
  while setup is unfinished; "Needs you now" with max 3 live items, each leaving when done; card
  gone when nothing is pending ("All set for today"); collapses to a pill while chatting. Tags and
  chips appear only when they mean "act on this" or "this changed".

## 16 Oct, ~03:10 (attribution)

- Claude must NEVER appear as a contributor/co-author. Shared commit-msg hook strips AI trailers in
  every worktree; accounts 2/3 settings disable attribution. **Before submission (after the last
  merge, workers paused): rewrite main history to remove the 14 old Claude co-author lines and
  force-push; verify GitHub shows only the owner.**

## 16 Oct, ~02:45

- Owner has a Google AI Pro plan: use Gemini CLI (installed; owner logs in once) for bug and
  feature detection and PR review; optional Jules for small fixes. 2 days left to submission.

## 16 Oct, ~02:40

- Stories must stay complete and immersive as the app grows: story contracts, a UX research
  refresh (components and aesthetic), a story director that walks and records every story and
  files fixes.
- Customer portal gamified properly with game theory (intuitive, prominent, obvious how it works).
- Drain Codex and account 3 (both owner accounts; account 3 has a lot of limit; Codex has 2 more
  weekly refreshes after the 7-day limit). Run multiple sessions in parallel.

## 16 Oct, ~02:30 (supply chain; owner is from the supply-chain industry: ask them domain questions)

- **Connect your system**: shops that already run software (POS/billing/ERP: Petpooja, Tally,
  Zoho, Square, Shopify, SAP…) plug it in instead of re-entering data. One AI connector: Gemini
  maps any export/feed to our schema, owner confirms the mapping once, then it syncs.
- **Supply chain, full linked loop**: TimesFM forecast + business rules draft the PO to the best
  supplier → PO → order confirmation → ASN/dispatch → invoice, between parties on DIFFERENT
  systems (e.g. SAP IDoc XML vs JSON/CSV/WhatsApp-style). The AI translates documents both ways,
  flags uncertain fields, and the phone shows plain-language cards ("PO 4500012345: 20 kg flour by
  Fri. Accept?"). Real-format sample files, labelled simulation (no live SAP by Saturday).
- **Business rules (all must-haves)**: MOQ + lead time; price tiers + credit terms (cash/7/30 days,
  credit limit); approval limits (above an amount or new supplier needs the owner tap);
  substitutions + shortages (allowed substitutes, partial deliveries, back-orders). The coach
  respects them when preparing orders and warns when one is broken.
- **Payments and rides**: deep links inside the Features page (UPI/PhonePe pay link + QR with
  amount; Rapido/Uber/Porter rider links). We never process money. UI/UX impeccably simple.

## 16 Oct, ~02:00 (hackathon review: docs/HACKATHON-REVIEW.md, honest score ~6.5/10)

- Approved spend (tiny, demo volume, with a budget alert): **BigQuery TimesFM forecasting ON**
  and **Vertex AI embeddings / vector search** for the one shared search engine.
- Add: **agent-to-agent shopping**, **visible multi-agent ADK design**, **Impact page with real
  evaluation numbers**, **fraud checks that work** (duplicate-owner face check + Gemini
  suspicious-listing checks). Owner also ticked "Other" without text: ask in the morning.
- Claude: never start coding past 85% of its budget; the last 10-15% is orchestration only.

## 16 Oct, ~01:45 (before sleeping; "can I get everything tested and properly working by morning")

Process

- One feature = one agent/coding tool that does the whole thing end to end, pushes to GitHub and
  opens a PR; Claude reviews and merges. Plan each feature properly first (plan mode) and
  complete the END-TO-END STORY, not fragments.
- Think through every scenario (onboarding and everything else). The app must make sense; right
  now flows are hard to follow and there is not much use for it yet.
- Morning: a full status of everything, on request.

Product

1. **More dynamic and flashier for the demo**, every flow considered end to end.
2. **Google flow complete**: at least an assisted flow that clearly works end to end (honest:
   real publishing needs Google approval; the owner submits on Google's own pages).
3. **Duplicate owner face check**: optional, but placed in a real flow and it must WORK; today it
   has many issues. Fix properly.
4. **Ultra-intelligent cards/questions**: e.g. a vegetarian shop must never get a halal card.
   Cards and questions follow what the AI knows about the shop (business-type profiles).
5. **Show what the AI can do**: an in-app, prominent "how to talk to the AI" demo/guide that
   highlights forecast, demand, sourcing from other vendors, etc. Not buried in My shop.
6. **Google tab becomes a Features page**: the Google icon opens our features page; "Get on
   Google" is one feature among them. Coach and My shop are already full; add suggestions
   (what to do next) there.
7. **Landing page** updated to scream that both merchants and customers use this, with these
   features.
8. **Customer side**: finding products, producers and things in and around them; extremely
   flashy, innovative UI/UX, designs and motion.
9. **Vendor side**: very cut-to-the-chase.
10. **One common search engine** for customers finding products AND vendor-to-vendor sourcing.
11. **Stamp card / scratch card**: keep the concept, make it prominent and make it obvious how it
    works.
12. UI/UX rules: always the best possible; the app must be absolutely usable.

## 16 Oct, ~00:30–01:30

- Voice: one soft female voice everywhere (Gemini **Achernar**); conversation must be real
  to-and-fro (react with knowledge, one natural question, no app narration, no gushing); never
  invent a shop name. Text model: gemini-3.5-flash.
- Onboarding = **voice mode like ChatGPT**: mic always on, reactive orb, the shop card ("cart")
  fills up, the conversation stays scrollable; phone first; proper alerts with Try again / Type
  instead / close for every failure (mic blocked, connection lost, rate limit).
- Ask the shop NAME first, then the kind of business; build a profile per business type (not the
  same questions for everyone: this is a general vendor platform).
- Camera INSIDE the chat (inline viewfinder, guided shots), map INSIDE the chat (small and big
  view, drop a pin), Google Maps safe hand-off (prefilled "Add a missing place"; owner submits).
- Manual entry form is terrible on the phone: make it a guided, phone-friendly journey.
- Coach shows forecast/sales/analysis as rich animated chart cards (like Claude/ChatGPT).
- Customer side: AI-first, like a chat; spacing/padding/heatmap audit to reduce eye strain.
- "Journeys" = guided journeys (M3/MUI patterns). Personal touch, design, animation and motion
  graphics matter a lot; the AI must be genuinely smart (use ADK fully).
- Must work flawlessly: **voice mode** and **voice back**.
- Workers: use Codex and accounts 2/3 fully; Claude orchestrates only after 89% of its budget.
  Regression runs every 3 h and before every release; never ship red.

## 15 Oct

- Feature freeze (later replaced by the final push above); Chalkboard theme + Direction 2 touches;
  owner app calm, customer app flashy; light default, pleasing dark mode; works in any country
  (Singapore/APAC only the demo default); honest labels for demo/simulated data.
