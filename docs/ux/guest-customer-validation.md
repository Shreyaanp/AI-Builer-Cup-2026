# Guest customers — local handoff, 17 October 2026

## Implementation

Guest customer identity is available behind `GUEST_CUSTOMER=true` (default remains false).
Guests can open a shop, chat with its owner, follow it, scan its signed QR, collect a daily
stamp, scratch cards, freeze their streak and read their private passport without Google.
Google is checked on the server at reward/perk claims, rescue reservations and regulars access.

Firebase anonymous identities are accepted only by customer endpoints. Owner/coach endpoints
still require verified Google identity. The shared owner identity provider also rejects anonymous
users as signed-out and uses the same linking helper for an eventual Google sign-in. Google upgrade links the anonymous Firebase user and
refreshes its claims, keeping the same UID and all server data. The local sign-in fixture also
keeps the guest UID. This is identity preservation, not a transfer between two existing accounts.
An already-used Google credential remains an open case: linking fails without discarding the
guest, and merging into that other UID is not implemented.

Passport edits are atomic in the existing SQLite/Firestore document adapters. A shop-local day
can earn one stamp per customer, including a location-free card stamp followed by a GPS scan.
The legacy scan route uses the same server identity when guests are enabled. Untrusted device
card totals cannot create rewards through the merge endpoint with the guest flag enabled.

Guest chat has a lower identity rate limit. Owner blocking persists across thread removal,
Google linking and the legacy inquiry route. Owners can unblock in their inbox. A hashed guest
label replaces contact details in the inbox; the internal guest marker is not displayed.

## Merge state and boundaries

The worktree started with an unfinished merge of cached main `c441078a` (#105). All conflicts
are resolved using main's new screens and owner/voice implementations. The local `origin/main`
ref advanced during this session to `752a95ae` (#156); its baseline/icon/test updates are included
in the working tree. No network command was run.

Landing, owner onboarding and voice sources have no guest diff against cached main. Git still
has the original merge operation pending: no merge or implementation commit was made because
the task's final instruction explicitly says **Do not commit**. The contradictory request to
commit was raised for clarification and had no answer at handoff. The orchestrator must finish
the merge/commit history, including the newer main ancestry, before pushing.

Vite reports the existing large-chunk warning. No load-time/Core Web Vitals or live security audit
claim is made.

No push, deployment, cloud resource, billing/IAM change, paid model call or external service
contact was made. Dependencies were installed using `npm ci --offline --ignore-scripts` from
the local cache. An earlier cache-only install attempt failed without network access.

## Observed checks

Only the dedicated phone spec and related backend suites were executed; the full browser and
backend suites were not run in this session. The guest spec skips when the feature is disabled,
so the default browser suite remains compatible with the default-off release flag.

| Check                                                                                                                                                    | Observed result                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pytest tests/test_customer.py tests/test_guest_customer.py tests/test_passport.py tests/test_games.py tests/test_community.py tests/test_threads.py -q` | 98 passed, 53 skipped, including the final full-card case                                                                             |
| `pytest tests/test_guest_customer.py -q` after adding full-card claim                                                                                    | 10 passed, 9 skipped                                                                                                                  |
| Ruff application/guest-test lint and affected-file format check                                                                                          | Passed                                                                                                                                |
| `mypy app`                                                                                                                                               | Passed: 107 source files                                                                                                              |
| `tests/guest-customer.spec.ts --project=phone --workers=1`                                                                                               | 1 passed with owner reply/block/unblock, guest games and upgrade preservation                                                         |
| Scoped `npm run check -- -- tests/guest-customer.spec.ts --project=phone --workers=1`                                                                    | Passed: lint, TypeScript/Vite build, hook enforcement and the one phone acceptance case; log: `output/guest-customer-final-check.log` |
| `RULES_BASE=origin/main npm run rules`                                                                                                                   | All product rules passed after including cached #156                                                                                  |
| Offline API contracts                                                                                                                                    | Exported with `backend/scripts/export_contract.py`; TypeScript types regenerated                                                      |
| `graphify update .`                                                                                                                                      | AST-only update; extractor warns about the existing `src/features/v1/api.ts` parser limitation                                        |

Backend tests verify owned chats, stranger isolation, anonymous/owner separation, concurrent
stamp attempts, the daily cap, block persistence, lower guest message limits and state surviving
upgrade. The final full-card test advances shop-local days, earns a complete card, verifies that
a guest cannot claim, signs in locally, claims exactly once and preserves stamp history.

A repeated run exposed a disposed-response race in the full-card UI fixture during teardown.
The fixture now fulfills from the already-read passport snapshot and is removed after sign-in;
the corrected targeted run and scoped check passed.

The phone spec uses real local HTTP routes for chat/follow/QR/stamp/games and the claim auth gate.
Only the full-card readiness response is substituted to reach the claim UI in one browser run;
it does not forge stamps in backend storage. Local sign-in and Firebase verification fixtures
are not live OAuth evidence.

## UI review

Reviewed the added controls against Material 3 semantics, typography, spacing and accessibility,
web interaction rules and the Chalkboard house checklist. Reused existing buttons, sheets,
semantic roles and motion. Browser viewport: 390×844; reduced motion enabled for the guest.

| Checklist                                | Result / evidence                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Purpose and one primary action           | Pass for captured states: owner Send; guest freeze/claim is contextual                                                          |
| Plain content / details on demand        | Guest label and profile privacy note; account request appears at value actions                                                  |
| Semantic controls / typography / spacing | Existing Material buttons/sheets and shared text roles retained                                                                 |
| Accessibility / reachability             | No page horizontal scroll; axe WCAG 2 A/AA found no violations in the passport and inbox region                                 |
| Personal activity                        | Follows, owned chat and stamp history survive local upgrade; backend covers linked Firebase UID                                 |
| States                                   | Success, block/unblock, repeat scan and auth rejection tested; exhaustive offline/permission/keyboard states remain unvalidated |
| Motion                                   | Guest path uses reduced motion; no new animation added                                                                          |
| Story                                    | Shop → owner chat → follow → QR → stamp/scratch → passport/freeze → claim gate verified                                         |
| Languages / themes / sizes               | Guest copy is typed for all 15 locales; this run only validates English/light at phone width                                    |

Review locations: `src/features/inquiries/Messages.tsx:671` (hide guest contact),
`src/features/inquiries/Messages.tsx:726` (unblock), `src/features/customer/Profile.tsx:158`
(guest privacy), `src/features/passport/games/StreakFlame.tsx:227` (guest play),
`src/features/rewards/StampCard.tsx:284` (claim gate).

Current local screenshots: [owner inbox](guest-customer-phone-inbox.png),
[guest passport and games](guest-customer-phone-passport.png).
These are browser-emulation artifacts, not physical-phone validation. Earlier screenshots in
this directory predate this integration and are not counted as current evidence.

## Guest changes relative to cached main

- Backend: `auth.py`, `community_routes.py`, `customer_routes.py`, `features.py`, `games_routes.py`,
  `limits.py`, `main.py`, `merchant.py`, `merchant_firestore.py`, `owner_routes.py`, `passport.py`,
  `passport_routes.py`, `settings.py`, `threads.py`; dedicated `tests/test_guest_customer.py`.
- Frontend: `src/auth/features.ts`, `src/auth/IdentityProvider.tsx`, `src/auth/upgradeGoogle.ts`; customer account, Chats, Profile,
  SignIn and guest copy; owner inquiry Messages; public ShopChat; Passport, StampMoment, store,
  CoopGoal, StreakFlame, WonPerks; rewards StampCard.
- Contracts: `docs/openapi.json`, `src/api/generated.d.ts`.
- Browser acceptance: one spec, `tests/guest-customer.spec.ts`.
- Evidence: this handoff and two current phone screenshots. Existing untracked Firestore rules/SDK tests and older screenshots are
  retained but were not run as part of this task's targeted acceptance command.

## Open risks

- Existing-Google-account credential collisions do not migrate the guest into that other UID.
- Firestore cases skip without an explicitly local emulator; no hosted durability result is claimed.
- Live Firebase anonymous enablement/linking, physical phones, dark mode and non-English flows
  were not validated in this session. Guest access still requires the feature flag at release.
- Clearing browser identity can lose access; a guest is not a verified physical person.
- Git merge completion and local commits remain pending under the final no-commit instruction.
