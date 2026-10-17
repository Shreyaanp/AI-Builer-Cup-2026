# Tour story: local handoff

Branch `feat/tour-story`, based on cached `origin/release/stable-2-main` at `d5073925`.
Work is uncommitted. No push, deployment, cloud/billing/IAM change or external service call
was requested or performed. Voice/onboarding source and `tests/qa/` are outside this change.

## Implemented

- Thirteen fictional, visibly labelled shops: eight around Indiranagar, Bengaluru, and five
  around Katong, Singapore. Each has six priced items/services, structured hours, local payment
  methods and languages, approximate pins, bundled menu artwork and shop-specific sample reviews.
- A private owner tour copy per world: 56 completed days of item sales, forecasts through the
  existing offline fallback, daily pulse, waiting questions, low stock, rescue deals, playbook,
  reward settings and a linked forecast → PO → confirmation → dispatch → invoice simulation.
  The receipt and invoice approval remain actionable in the existing supply flow.
- A customer explicitly loads sample follows, two replied owned threads, stamps in progress,
  scratch cards and collected rescues into an empty demo passport. Real points stay separate.
  The Bengaluru owner copy has an invalid-provider UPI address for a local link/QR preview.
- Shared deterministic seeding is used by the local development launcher, the in-app tour and
  the CLI. Normal reruns preserve actions and add missing days; private copies also refresh
  daily pulse and rescue samples. Reset is explicit and refuses non-demo passport activity.
  Loading an existing demo passport also repairs chat links after a public-world reset,
  preserving its rewards and unfollows. An owner tour leaves real customer passports alone.
  Production preparation requires the owner's explicit CLI target; production demo routes
  open only accounts already prepared by that script.
- [The two-minute walk](../tour-story.md) gives the screen order and narration for recording.
- The customer chat story now uses the seeded Katong bakery without a seed-dependent skip.
  S11 accepts the supplier's two flour names (Atta / Wheat flour); both still require kg,
  linked documents, partial confirmation, receipt and the invoice-price correction.

## Verification evidence

These are observations, separate from the implementation list above.

- Final targeted backend run: **75 passed, 13 skipped**. Covers tour seeding, local currencies,
  ownership, production gates, forecasts, supply documents, photos, threads, sessions and
  disconnect cleanup. The skipped emulator cases do not establish Firestore behavior.
- Next-day regressions cover preserved stock, owner-selected gallery and purchase-order receipt
  progress. A public-reset chat regression reproduced a 404 before the fix and passed afterward.
  Final tour seed suite: **15 passed**, including idempotence, reset, owner isolation and real
  passport preservation.
- Ruff lint/format and mypy passed; API contracts were regenerated offline. Changed frontend
  files passed Prettier and `git diff --check`.
- Browser command: `npm run check -- -- tests/tour-story.spec.ts tests/customer-chat.spec.ts
tests/tour.spec.ts tests/stories --workers=1`. Lint, build and hook enforcement passed;
  walkthroughs are still running. The first cold customer walk reached Saved but exceeded its
  90-second total timeout; its isolated rerun passed in 20.1 seconds. The full backend/browser
  suites were not rerun for this handoff.
- S11 after its catalogue-name correction: **2 passed**, phone and desktop. The strengthened
  passport captures wait for points, impact and a stamped shop: **2 passed**. Final tour checks
  also assert the shop card's seven displayed stamps (five earned plus two welcome).
- Local verification uses `WEB_PORT=3867`, `API_PORT=3967`, `RECALL_PATH=data/test-vectors` and
  a fresh merchant/session database under `.cache/tour-story-verified/`. Browser DNS blocks
  external hosts. Provider modes remain offline/fixture. Logs are in that ignored directory.

## UX review

Tour-specific captures belong under `output/playwright/tour-story/` at 390×844 and 1440×1000.
The new public-shop cases cover both worlds in light/dark, image loading, demo-badge explanation,
axe and horizontal overflow. Two cold-account area walks check suggestions, local item prices
and map pins. The customer walk checks the passport and owner reply; the owner
walk checks Today, an actual forecast chart, the sample payment QR and supplier timeline. Hindi
and Simplified Chinese exercise the customer entry action. Record final visual observations
after the fresh browser run completes.

Checklist observations (automated results do not replace a physical-phone or screen-reader review):

| Check                | Review                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Three-second purpose | Today leads with stock/questions; the customer has local choices and a next reward.                                          |
| Primary action       | The new story action is secondary in Profile; existing screen actions stay in place.                                         |
| Content              | Short action/help/error copy in all 15 locales; Demo labels and badge explanation are explicit.                              |
| Eye strain           | Existing semantic surfaces and typography; public-shop contrast checked with axe in both themes.                             |
| States               | Loading and retry are implemented; success and production refusal are exercised. No new error-state screenshot.              |
| Personal context     | Currency and menus follow the area; reruns keep edits, replies, rewards and unfollows.                                       |
| Motion               | No new animation; existing reduced-motion customer walk passes.                                                              |
| Reach and input      | New action and badge have 48px targets, native button semantics and visible focus. Physical touch remains untested.          |
| Complete journey     | Owner forecast/payment/supplier records and customer discovery/map/shop/rewards/chat are linked.                             |
| Languages            | Hindi and Simplified Chinese entry captures check label visibility and horizontal overflow; no native-speaker certification. |

## Open limits

- Gallery images are labelled local menu artwork, not shop photographs. No external photo
  source or image model was contacted.
- Forecasts use weekday averages in these checks. No live TimesFM/Gemini/ASR accuracy is claimed.
  The demo badge never creates real identity verification or Google business authority.
- Saved kg is the existing estimated CO₂ impact metric, not measured rescued food weight.
- PayNow is listed for Singapore. The existing payment-link feature supports INR/UPI only;
  the invalid-provider sample must never be paid. No payment or supplier was contacted.
- Production demo accounts were not seeded here. Firestore, physical phones, installed payment
  apps, screen readers and native-speaker review remain unvalidated.

## Files changed

The final file manifest will be recorded after generated test artifacts are reviewed.
