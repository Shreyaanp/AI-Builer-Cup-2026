"""Direct browser access stays denied; the Admin SDK/backend owns customer permissions."""

import os
import time
from pathlib import Path

import httpx
import jwt
import pytest


@pytest.mark.parametrize("provider", ["", "anonymous", "google.com"])
def test_customer_cannot_access_firestore_directly(provider: str) -> None:
    host = os.getenv("FIRESTORE_EMULATOR_HOST", "")
    if host.split(":")[0] not in {"127.0.0.1", "localhost"}:
        pytest.skip("Requires an explicitly local emulator loaded with firestore.rules.")
    now = int(time.time())
    headers = {}
    if provider:
        # Emulator-only unsigned fixture. Never use a real Firebase token in tests.
        token = jwt.encode(
            {
                "sub": "fixture-person",
                "user_id": "fixture-person",
                "aud": "demo-ogoogle-local",
                "iss": "https://securetoken.google.com/demo-ogoogle-local",
                "iat": now,
                "exp": now + 600,
                "firebase": {"sign_in_provider": provider},
            },
            "",
            algorithm="none",
        )
        headers["Authorization"] = "Bearer " + token
    url = f"http://{host}/v1/projects/demo-ogoogle-local/databases/(default)/documents/ogoogle_ai_test_rules/community/profile/fixture"
    assert Path("../firestore.rules").is_file()
    with httpx.Client(timeout=10, trust_env=False) as client:
        for response in (
            client.get(url, headers=headers),
            client.patch(
                url, headers=headers, json={"fields": {"name": {"stringValue": "forged"}}}
            ),
            client.delete(url, headers=headers),
        ):
            assert response.status_code == 403, response.text
