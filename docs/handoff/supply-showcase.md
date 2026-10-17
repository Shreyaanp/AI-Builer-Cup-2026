# Local supply-chain showcase

With a shop selected, open **Grow → Purchase orders → Try supply demo** in the local web app
(`WEB_PORT=4211`, `API_PORT=4311`). This creates a private Milk shop, six weeks of sales,
a simulated SAP dairy supplier with a 12-litre minimum, six-litre packs and a quantity price
tier, and one sent order. Another tap resumes that shop without resetting stock or orders.
The demo entry is development-only and its endpoint rejects hosted environments.

On Today, tap **Reorder**, review the forecast/rules draft and tap **Approve and send**.
**View as SAP (IDoc)** shows the existing generator's XML alongside the order in plain words
(stacked on a phone). **Simulate supplier reply** advances through ORDRSP, DESADV and INVOIC.
Tap **Goods arrived**, then confirm the stock review and close the order. Today says
**Milk restocked** only when saved inventory reaches the received stock quantity.

## Verified locally

- `uv run --locked pytest tests/test_supply_chain.py tests/test_supply_showcase.py -q`:
  36 passed, one skipped (local Firestore emulator absent).
- One Playwright spec, `tests/supply-showcase-phone.spec.ts`, passed at 390×844. It walks the
  complete story, checks saved stock, resumes the demo after reload, checks horizontal overflow
  and runs axe on the order timeline. Screenshots: `output/playwright/supply-*.png`.
- `npm run lint`, `npx tsc -b`, `npm run rules`, focused Ruff checks/format and
  `uv run --locked mypy app` passed. OpenAPI and frontend API declarations were regenerated.
- `graphify update .` ran with AST extraction only.

The phone run used an ignored local Playwright/Vite config under `output/` to allow this
workspace's linked dependency directory and isolate Vite's cache. Its servers ran as children
of the foreground Playwright command on 4211/4311. The application Vite config was unchanged.

## Changed files

- Backend: `backend/app/supply_chain.py`, `supply_routes.py`, `supply_showcase.py`.
- UI: `src/features/supply/TodaySupply.tsx`, `PurchaseOrderCard.tsx`, `Supply.tsx`,
  `supplyData.ts`, `types.ts`, `showcaseCopy.ts`; `src/features/v1/today/TodayView.tsx`.
- Contracts: `docs/openapi.json`, `src/api/generated.d.ts`.
- Tests: `backend/tests/test_supply_showcase.py`, `tests/supply-showcase-phone.spec.ts`;
  the dispatch screenshot selector in `tests/stories/s11-supply-chain.spec.ts` follows the new
  shipping-notice label (linted; that older story was not rerun).
- This handoff: `docs/handoff/supply-showcase.md`.

## Limits

This is an offline forecast/rules and simulated-supplier demo. The XML is generated SAP IDoc
format; no SAP network, live model or payment was contacted. Physical-phone, desktop/dark-theme,
full-suite and hosted Firestore validation were outside this run. Existing workspace behavior
selects its first shop after reload; use the demo entry again to resume the Milk shop.
