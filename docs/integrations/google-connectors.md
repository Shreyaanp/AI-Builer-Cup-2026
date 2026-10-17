# Square through Google Cloud Integration Connectors

Code: `backend/app/pos_connectors.py` (client only). Connections are billed per node while they run, so the app never creates, resumes or deletes one. The owner does, only while demoing.

## What the code does

With `POS_LIVE=live` and `POS_SOURCE=google-connectors`, a Square pull reads entity lists from the connection `SQUARE_CONNECTION` (default `square-sandbox`) in `CONNECTORS_LOCATION` (default `asia-south1`):

`GET https://connectors.googleapis.com/v1/projects/{project}/locations/{location}/connections/{connection}/entityTypes/{type}/entities`

for the entity types `Location`, `CatalogObject` and `Order`, with Google default credentials (the Cloud Run service account). The entities are put back into the shape of the Square API and fed through the same row builders as a direct pull. If the connection is suspended, missing or refuses the call, the pull falls back to the direct Square API (when a token is set) and then to recorded samples; the reply says `fallback: CONNECTORS_UNAVAILABLE`.

The Connect sheet shows "Pulled via Google Cloud Integration Connectors" when this path answered.

Unverified until a live connection exists: the exact entity type names the Square connector exposes. They are constants in `SQUARE_ENTITIES` in `pos_connectors.py`; check them in the Connectors console (connection > Entities) and adjust.

## Owner's steps (not yet done: no tokens sent)

1. Enable the APIs on the project: `gcloud services enable connectors.googleapis.com integrations.googleapis.com`.
2. Create a dedicated service account for connectors and grant it the minimal roles the Connectors docs list for a connection (typically `roles/secretmanager.secretAccessor` on the token secret). Grant the Cloud Run service account `roles/connectors.viewer` so it can read entities.
3. Put the Square sandbox token in Secret Manager as `square-sandbox-token`.
4. In the console (Integration Connectors > Connections > Create), region `asia-south1`, connector Square, connection id `square-sandbox`, environment Sandbox, token from the secret, minimum nodes 1.
5. Suspend it when not demoing, resume before a demo: Connections > the connection > Edit > Suspend / Resume (check the current `gcloud integration-connectors connections` commands before scripting this).
6. Set `POS_SOURCE=google-connectors` and `POS_LIVE=live` on the service.

Shopify (dev store) is not wired: there is no Shopify pull yet.
