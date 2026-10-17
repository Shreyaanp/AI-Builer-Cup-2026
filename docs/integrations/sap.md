# SAP sandbox purchase orders

Purchase orders has a section, **Live from SAP sandbox**, that shows real purchase orders from SAP's public S/4HANA Cloud sandbox (SAP Business Accelerator Hub). It is read only: the app never sends anything to SAP. Each order is mapped into our canonical order and shown with the SAP IDoc XML we would write for it.

Code: `backend/app/sap_sandbox.py`. Route: `GET /api/v1/businesses/{id}/supply/sap-sandbox`.

## What the owner sees

- Switch off, no key, SAP refuses the key, or SAP does not answer: a recorded sample of the sandbox's reply (`backend/app/supply_samples/sap-sandbox-a_purchaseorder.json`) with the label "Recorded sample of SAP's sandbox, not live" and the reason.
- Switch on with a working key: the label "Read now from SAP's sandbox". The sandbox is read at most once every 5 minutes (60 seconds after a failure).

## Owner's steps to get the API key (free, about 5 minutes)

1. Go to https://api.sap.com and sign in (create a free SAP Universal ID if you have none).
2. Open **SAP S/4HANA Cloud** > **Purchase Order (A2X)** (API_PURCHASEORDER_PROCESS_SRV) > **API Sandbox**.
3. Click **Show API Key** (top right), then **Copy Key**.
4. Store it in Secret Manager. Never put it in Git, a chat, or a `.env` that is committed:

   ```
   gcloud secrets create SAP_SANDBOX_API_KEY --replication-policy=automatic
   printf '%s' 'PASTE_KEY' | gcloud secrets versions add SAP_SANDBOX_API_KEY --data-file=-
   ```
5. Give the Cloud Run service the secret and the switch:

   ```
   gcloud run services update SERVICE --region REGION \
     --update-secrets=SAP_SANDBOX_API_KEY=SAP_SANDBOX_API_KEY:latest \
     --update-env-vars=SUPPLY_SAP_LIVE=true
   ```
6. Open My shop > Purchase orders. The label should read "Read now from SAP's sandbox".

To turn it off again, set `SUPPLY_SAP_LIVE=false`; the recorded sample takes over.

## Settings

| Env var | Default | Meaning |
| --- | --- | --- |
| `SUPPLY_SAP_LIVE` | `false` | Switch for the live read |
| `SAP_SANDBOX_API_KEY` | empty | API key, from Secret Manager only |
| `SAP_SANDBOX_URL` | the sandbox's `API_PURCHASEORDER_PROCESS_SRV` | Must be `https` |
| `SAP_SANDBOX_ODATA` | `v2` | `v2` (`A_PurchaseOrder`) or `v4` (`PurchaseOrder`) |

## Limits

- The sandbox is shared demo data, rate limited, and may change or be down; the fallback covers that.
- Only the first 10 orders and 60 lines per order are read.
- Orders are not stored; they are shown, not imported into the shop's own purchase orders.
