# POS connections

Owners bring a POS in three ways. All of them end in the same review screen; nothing is saved until the owner confirms.

1. **Upload an export.** Petpooja, Loyverse and Square CSV exports are recognised from their header row and mapped instantly, with no model call (`backend/app/pos_presets.py`, fixtures in `backend/tests/fixtures/connect/presets/`). Other exports go to the AI column mapper as before. Variations ("Large") are folded into the item name, and dates in any of the usual POS formats become ISO days. Petpooja dates are read day-first.
2. **Pull live from Square (sandbox) or Loyverse** (`backend/app/pos_live.py`, routes `GET /api/v1/businesses/{id}/connect/live` and `POST .../connect/live/{square|loyverse}/{menu|sales}`). Each pull produces a table with the same headers as that POS's CSV export, so the preset, a saved mapping and the review step are exactly those of an upload. Sales cover the last 28 days; refunds and voided receipts are skipped. Read only: nothing is ever written to the POS.
3. **Square through Google Cloud Integration Connectors.** See `google-connectors.md`.

## Switch and fallbacks

Every live path sits behind `POS_LIVE` (`offline` by default). Order of attempts for a pull:

`google-connectors` (Square only, when `POS_SOURCE=google-connectors`) → direct vendor API (needs the token) → recorded sample responses (`backend/app/pos_samples/`), served through the same code, rebased so the newest sale is today.

The reply says which one answered: `simulated`, `via` (`google-connectors`, `direct`, `samples`) and `fallback` (`NO_TOKEN`, `LIVE_UNAVAILABLE`, `CONNECTORS_UNAVAILABLE`, or empty). The Connect sheet tells the owner when it is showing recorded data.

## Settings

| Env var | Default | Meaning |
| --- | --- | --- |
| `POS_LIVE` | `offline` | `live` to call vendors; `offline` answers from samples |
| `SQUARE_SANDBOX_TOKEN` | empty | Square sandbox access token (Secret Manager) |
| `SQUARE_SANDBOX_LOCATION_ID` | empty | Limit sales to one sandbox location (optional) |
| `LOYVERSE_TOKEN` | empty | Loyverse API access token (Secret Manager) |
| `POS_SOURCE` | `direct` | `google-connectors` routes Square through Integration Connectors |
| `CONNECTORS_LOCATION` | `asia-south1` | Region of the connections |
| `SQUARE_CONNECTION` | `square-sandbox` | Connection id |

Tokens come only from the environment (Secret Manager on Cloud Run); they are never committed or logged, and `GET .../connect/live` reports only `live` or `simulated`.

## Owner's steps for tokens

**Square sandbox:** developer.squareup.com > Applications > create an application > Credentials > Sandbox > copy the *Sandbox access token*. Create test items and sales in Sandbox test accounts > Square Dashboard.

**Loyverse:** Back Office (loyverse.com) > Settings > Access tokens > Add access token > copy it. It grants read access to items, inventory and receipts.

Store each in Secret Manager and give the service the secret and the switch:

```
printf '%s' 'PASTE_TOKEN' | gcloud secrets create square-sandbox-token --data-file=-
gcloud run services update SERVICE --region REGION \
  --update-secrets=SQUARE_SANDBOX_TOKEN=square-sandbox-token:latest,LOYVERSE_TOKEN=loyverse-token:latest \
  --update-env-vars=POS_LIVE=live
```

## Not done yet

Shopify has no pull; its export upload works as before. Real-money POS accounts are out of scope: the Square pull targets the sandbox host only.
