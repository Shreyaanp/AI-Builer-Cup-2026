"""Durable owner-scoped merchant records in the app's dedicated Firestore namespace.

Mirrors MerchantStore so ADK tools and routes are adapter-agnostic. Every write that depends
on a revision, a proposal digest or a single-use challenge runs in one Firestore transaction.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import time
from threading import Lock
from typing import Any, cast
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from fastapi import HTTPException
from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

from .community import Documents, FirestoreDocuments
from .customer import Inquiry, InquiryInput, InquiryReceipt
from .merchant import (
    CHALLENGE_SECONDS,
    DEMO_ID,
    PROPOSAL_SECONDS,
    SUPPLY_KINDS,
    BusinessFields,
    ProductFields,
    ProposalRequest,
    challenge_prompts,
    check_demo_seed,
    preserve_profile,
    public_projection,
    require_name,
    seal_proposal,
    validate_proposal,
)
from .playbook import migrate_stored
from .sales import check_import, prepare_import, sales_days, today_for, validate_capacity
from .stock_alerts import (
    ALERT_SECONDS,
    MAX_ALERTS,
    StockAlertInput,
    StockAlertReceipt,
    alert_key,
    check_item,
)
from .threads import change_thread, contact_hash, new_thread
from .vendor_profile import migrate_profile


def document_id(value: str | None, missing: str) -> str:
    """Only server-generated UUIDs may name documents; reject paths and arbitrary strings.

    The one exception is the fixed `demo-…` IDs of seeded demo shops (letters, digits and
    hyphens only, so never a path)."""
    if value and DEMO_ID.fullmatch(value):
        return value
    try:
        return str(UUID(str(value)))
    except ValueError as error:
        raise HTTPException(404, missing) from error


def product_key(name: str, unit: str) -> str:
    return hashlib.sha256(f"{name}\0{unit}".encode()).hexdigest()


class FirestoreMerchantStore:
    def __init__(self, client: firestore.Client, namespace: str) -> None:
        self.client = client
        self.feature_docs: Documents = FirestoreDocuments(client, namespace)
        root = client.collection(namespace).document("merchant")
        self.people = root.collection("people")
        self.businesses = root.collection("businesses")
        self.proposals = root.collection("proposals")
        self.challenges = root.collection("challenges")
        # Avoid competing local read-lock upgrades on one dedupe document. Transactions
        # still enforce deduplication and sharing across independent server processes.
        self.inquiry_lock = Lock()
        self.stock_alert_lock = Lock()

    def person_ref(self, uid: str) -> Any:
        return self.people.document(hashlib.sha256(uid.encode()).hexdigest())

    def sim_state(self, uid: str, bid: str) -> dict[str, Any] | None:
        self.owned_business(uid, bid)
        ref = self.businesses.document(document_id(bid, "Business not found."))
        data = ref.collection("google_sim").document(hashlib.sha256(uid.encode()).hexdigest()).get()
        return data.to_dict() if data.exists else None

    def save_sim_state(self, uid: str, bid: str, state: dict[str, Any]) -> None:
        business = self.businesses.document(document_id(bid, "Business not found."))
        ref = business.collection("google_sim").document(hashlib.sha256(uid.encode()).hexdigest())

        @firestore.transactional
        def run(transaction: Any) -> None:
            self.owned(business.get(transaction=transaction), uid)
            current = ref.get(transaction=transaction).to_dict() or {}
            if state["version"] != current.get("version", 0) + 1:
                raise HTTPException(409, "Simulator changed. Reload before reviewing.")
            transaction.set(ref, state)

        run(self.client.transaction())

    @staticmethod
    def owned(snapshot: Any, uid: str) -> dict[str, Any]:
        data = snapshot.to_dict() if snapshot.exists else None
        if not data or data.get("deleting") or uid not in data.get("owners", []):
            raise HTTPException(404, "Business not found.")
        return dict(data)

    def owned_business(self, uid: str, bid: str, transaction: Any = None) -> dict[str, Any]:
        ref = self.businesses.document(document_id(bid, "Business not found."))
        return self.owned(ref.get(transaction=transaction), uid)

    @staticmethod
    def present(bid: str, data: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": bid,
            "fields": migrate_profile(data["fields"]),
            "revision": data["revision"],
            "last_confirmed": data.get("last_confirmed"),
            "coach_notes": data.get("coach_notes") or [],
            "gallery": data.get("gallery") or [],
            "icon": data.get("icon"),
            "registration": data["status"],
            "public": bool(data.get("public")),
            "google_publication": "not_connected",
        }

    def list_businesses(self, uid: str) -> list[dict[str, Any]]:
        query = self.businesses.where(filter=FieldFilter("owners", "array_contains", uid))
        rows = [(snapshot.id, snapshot.to_dict() or {}) for snapshot in query.limit(50).stream()]
        rows.sort(key=lambda row: (row[1].get("created", 0), row[0]))
        return [self.present(bid, data) for bid, data in rows]

    def context(self, uid: str, bid: str | None) -> dict[str, Any]:
        person = self.person_ref(uid).get().to_dict() or {}
        business = self.present(bid, self.owned_business(uid, bid)) if bid else None
        return {
            "business": business,
            "inventory": self.inventory(uid, bid) if bid else [],
            "person_verification": person.get("verification", "not_enrolled"),
        }

    def inventory(self, uid: str, bid: str) -> list[dict[str, Any]]:
        self.owned_business(uid, bid)
        ref = self.businesses.document(document_id(bid, "Business not found."))
        rows = [
            (snapshot.id, snapshot.to_dict() or {})
            for snapshot in ref.collection("inventory").limit(500).stream()
        ]
        rows.sort(key=lambda row: (row[1].get("created", 0), row[0]))
        return [{"id": pid, **data["fields"]} for pid, data in rows]

    def propose(
        self, uid: str, request: ProposalRequest, idempotency_key: str | None = None
    ) -> dict[str, Any]:
        validate_proposal(request)
        pid = (
            str(uuid5(NAMESPACE_URL, f"{uid}:{request.business_id}:{idempotency_key}"))
            if idempotency_key
            else str(uuid4())
        )
        ref = self.proposals.document(pid)

        @firestore.transactional
        def run(transaction: Any) -> dict[str, Any]:
            if request.business_id:
                business = self.businesses.document(
                    document_id(request.business_id, "Business not found.")
                )
                current = self.owned(business.get(transaction=transaction), uid)
                preserve_profile(request, current["fields"])
                prior = ref.get(transaction=transaction).to_dict() if idempotency_key else None
                if (
                    prior
                    and prior["uid"] == uid
                    and (
                        prior["receipt"]
                        or (
                            prior["expires"] >= time.time()
                            and json.loads(prior["payload"])["revision"] == current["revision"]
                        )
                    )
                ):
                    return {
                        "id": pid,
                        "digest": prior["digest"],
                        "expires": prior["expires"],
                        "snapshot": json.loads(prior["payload"]),
                    }
                if current["revision"] != request.revision:
                    raise HTTPException(409, "The business changed. Reload before reviewing.")
            elif request.revision != 0:
                raise HTTPException(409, "A new business starts at revision zero.")
            payload, text, digest = seal_proposal(request)
            expires = time.time() + PROPOSAL_SECONDS
            transaction.set(
                ref,
                {
                    "uid": uid,
                    "payload": text,
                    "digest": digest,
                    "expires": expires,
                    "receipt": None,
                },
            )
            return {"id": pid, "digest": digest, "expires": expires, "snapshot": payload}

        return run(self.client.transaction())

    def commit(self, uid: str, pid: str, digest: str) -> dict[str, Any]:
        proposal_ref = self.proposals.document(document_id(pid, "Proposal not found."))

        @firestore.transactional
        def run(transaction: Any) -> dict[str, Any]:
            snapshot = proposal_ref.get(transaction=transaction)
            proposal = snapshot.to_dict() if snapshot.exists else None
            if not proposal or proposal["uid"] != uid:
                raise HTTPException(404, "Proposal not found.")
            if not secrets.compare_digest(proposal["digest"], digest):
                raise HTTPException(409, "Review the exact proposal before saving.")
            if proposal["receipt"]:
                return dict(json.loads(proposal["receipt"]))
            if proposal["expires"] < time.time():
                raise HTTPException(409, "Review expired; prepare a new proposal.")
            data = json.loads(proposal["payload"])
            require_name(data)
            bid = data["business_id"]
            business_ref = self.businesses.document(bid)
            business = business_ref.get(transaction=transaction)
            if business.exists:
                if self.owned(business, uid)["revision"] != data["revision"]:
                    raise HTTPException(409, "The business changed; review again.")
            elif data["kind"] != "business" or data["revision"] != 0:
                raise HTTPException(404, "Business not found.")
            now = time.time()
            # Firestore transactions require every read before the first write.
            items = [
                business_ref.collection("inventory").document(
                    product_key(product["name"], product["unit"])
                )
                for product in data["products"]
            ]
            # A new unit for a saved item replaces that item (see ProductFields.previous_unit).
            replaced = [
                business_ref.collection("inventory").document(
                    product_key(product["name"], product["previous_unit"])
                )
                if product.get("previous_unit")
                else None
                for product in data["products"]
            ]
            existing = {ref.id: ref.get(transaction=transaction) for ref in items}
            old = {ref.id: ref.get(transaction=transaction) for ref in replaced if ref}
            if data["kind"] == "business":
                data["business"] = migrate_profile(data["business"])
            if data["kind"] == "business" and business.exists:
                transaction.update(
                    business_ref, {"fields": data["business"], "revision": data["revision"] + 1}
                )
            elif data["kind"] == "business":
                transaction.create(
                    business_ref,
                    {
                        "fields": data["business"],
                        "revision": 1,
                        "status": "draft",
                        "owners": [uid],
                        "public": False,
                        "created": now,
                    },
                )
            else:
                transaction.update(business_ref, {"revision": data["revision"] + 1})
            # Inventory proposals, or a brand-new shop arriving with its menu.
            for ref, previous, product in zip(items, replaced, data["products"], strict=True):
                prior = existing[ref.id]
                created = (prior.to_dict() or {}).get("created", now) if prior.exists else now
                if previous is not None and previous.id != ref.id and old[previous.id].exists:
                    created = (old[previous.id].to_dict() or {}).get("created", created)
                    transaction.delete(previous)
                fields = {key: value for key, value in product.items() if key != "previous_unit"}
                transaction.set(ref, {"fields": fields, "created": created, "updated": now})
            receipt = {
                "business_id": bid,
                "revision": data["revision"] + 1,
                "receipt_id": str(uuid4()),
                "google_publication": "not_connected",
            }
            transaction.update(proposal_ref, {"receipt": json.dumps(receipt)})
            return receipt

        return run(self.client.transaction())

    def challenge(
        self, uid: str, bid: str, exclude_prompts: list[str] | None = None
    ) -> dict[str, Any]:
        business_ref = self.businesses.document(document_id(bid, "Business not found."))
        cid = str(uuid4())
        prompts = challenge_prompts(exclude=exclude_prompts)
        expires = time.time() + CHALLENGE_SECONDS

        @firestore.transactional
        def run(transaction: Any) -> None:
            self.owned(business_ref.get(transaction=transaction), uid)
            transaction.create(
                self.challenges.document(cid),
                {
                    "uid": uid,
                    "business_id": business_ref.id,
                    "prompts": prompts,
                    "expires": expires,
                    "consumed": False,
                    "result": None,
                },
            )

        run(self.client.transaction())
        return {
            "id": cid,
            "prompts": prompts,
            "expires": expires,
            "max_seconds": 8,
            "max_bytes": 8 * 1024 * 1024,
        }

    def consume(self, uid: str, cid: str) -> dict[str, Any]:
        ref = self.challenges.document(document_id(cid, "Challenge not found."))

        @firestore.transactional
        def run(transaction: Any) -> dict[str, Any]:
            snapshot = ref.get(transaction=transaction)
            row = snapshot.to_dict() if snapshot.exists else None
            if not row or row["uid"] != uid:
                raise HTTPException(404, "Challenge not found.")
            if row["consumed"] or row["expires"] < time.time():
                raise HTTPException(409, "Challenge expired or already used. Retry the scan.")
            self.owned(
                self.businesses.document(row["business_id"]).get(transaction=transaction), uid
            )
            transaction.update(ref, {"consumed": True})
            return {"business_id": row["business_id"], "prompts": row["prompts"]}

        return run(self.client.transaction())

    def challenge_row(self, uid: str, cid: str) -> tuple[Any, dict[str, Any]]:
        ref = self.challenges.document(document_id(cid, "Challenge not found."))
        snapshot = ref.get()
        row = snapshot.to_dict() if snapshot.exists else None
        if not row or row["uid"] != uid:
            raise HTTPException(404, "Challenge not found.")
        return ref, row

    def face_result(self, uid: str, cid: str, result: dict[str, Any]) -> None:
        ref, _ = self.challenge_row(uid, cid)
        ref.update({"result": result})
        self.person_ref(uid).set({"verification": result.get("result", "not_started")}, merge=True)

    def result(self, uid: str, cid: str) -> dict[str, Any]:
        _, row = self.challenge_row(uid, cid)
        return dict(row["result"]) if row["result"] else {"status": "awaiting_capture"}

    def invalidate_face(self, uid: str) -> None:
        self.person_ref(uid).set({"verification": "not_enrolled"}, merge=True)
        batch = self.client.batch()
        for snapshot in self.challenges.where(filter=FieldFilter("uid", "==", uid)).stream():
            batch.delete(snapshot.reference)
        batch.commit()

    def consent(self, uid: str) -> dict[str, Any] | None:
        record = (self.person_ref(uid).get().to_dict() or {}).get("consent")
        return dict(record) if record else None

    def record_consent(self, uid: str, version: str) -> dict[str, Any]:
        record = {"version": version, "accepted": time.time()}
        self.person_ref(uid).set({"consent": record}, merge=True)
        return record

    def erase_owner(self, uid: str) -> list[str]:
        refs: list[Any] = []
        owned = []
        query = self.businesses.where(filter=FieldFilter("owners", "array_contains", uid))
        for snapshot in query.stream():
            # Seal the parent before enumerating children: racing transactions either commit
            # before this update (and are enumerated) or retry against the deletion marker.
            snapshot.reference.update({"deleting": True, "public": False})
            for kind in ("rescue", "brief", "brief_wording", "shop_daily", *SUPPLY_KINDS):
                self.feature_docs.delete_scope(kind, snapshot.id)
            owned.append(snapshot.id)
            refs += [item.reference for item in snapshot.reference.collection("inventory").stream()]
            refs += [
                item.reference for item in snapshot.reference.collection("google_sim").stream()
            ]
            refs += [item.reference for item in snapshot.reference.collection("planning").stream()]
            for collection in (
                "inquiries",
                "inquiry_dedupe",
                "inquiry_blocks",
                "sales_days",
                "sales_imports",
                "recaps",
                "sold_out_days",
                "stock_alerts",
                "supplier_orders",
                "connector_mappings",
            ):
                refs += [
                    item.reference for item in snapshot.reference.collection(collection).stream()
                ]
            refs.append(snapshot.reference)
        for collection in (self.proposals, self.challenges):
            refs += [
                s.reference for s in collection.where(filter=FieldFilter("uid", "==", uid)).stream()
            ]
        refs.append(self.person_ref(uid))
        for start in range(0, len(refs), 400):  # Firestore batches accept up to 500 writes.
            batch = self.client.batch()
            for ref in refs[start : start + 400]:
                batch.delete(ref)
            batch.commit()
        return owned

    def set_availability(
        self, uid: str, bid: str, product_id: str, available: bool
    ) -> dict[str, Any]:
        business_ref = self.businesses.document(document_id(bid, "Business not found."))
        if not re.fullmatch(r"[0-9a-f]{64}", product_id):
            raise HTTPException(404, "Product not found.")
        item_ref = business_ref.collection("inventory").document(product_id)

        @firestore.transactional
        def run(transaction: Any) -> dict[str, Any]:
            business = self.owned(business_ref.get(transaction=transaction), uid)
            item = item_ref.get(transaction=transaction)
            if not item.exists:
                raise HTTPException(404, "Product not found.")
            fields = {**(item.to_dict() or {})["fields"], "available": available}
            day = today_for(business["fields"]).isoformat()
            signal_ref = business_ref.collection("sold_out_days").document(day)
            signal = signal_ref.get(transaction=transaction).to_dict() or {}
            alerts = list(business_ref.collection("stock_alerts").stream(transaction=transaction))
            now = time.time()
            for alert in alerts:
                data = alert.to_dict() or {}
                if data["expires"] <= now:
                    transaction.delete(alert.reference)
                elif (
                    available
                    and not (item.to_dict() or {})["fields"].get("available", True)
                    and data["name"] == fields["name"]
                    and data["unit"] == fields["unit"]
                ):
                    transaction.update(alert.reference, {"ready": True})
            if not available and (item.to_dict() or {})["fields"].get("available", True):
                transaction.set(signal_ref, {"count": signal.get("count", 0) + 1})
            transaction.update(item_ref, {"fields": fields, "updated": time.time()})
            transaction.update(business_ref, {"revision": business["revision"] + 1})
            return {"id": product_id, **fields, "revision": business["revision"] + 1}

        return run(self.client.transaction())

    def share(self, uid: str, bid: str, public: bool) -> dict[str, Any]:
        ref = self.businesses.document(document_id(bid, "Business not found."))
        self.owned(ref.get(), uid)
        ref.update({"public": public})
        return {"business_id": ref.id, "public": public}

    def shared_shops(self) -> list[dict[str, Any]]:
        from google.cloud.firestore_v1.base_query import FieldFilter

        rows = self.businesses.where(filter=FieldFilter("public", "==", True)).stream()
        return [shop for row in rows if (shop := self.public_shop(row.id)) is not None]

    def seed_demo_shop(
        self, uid: str, bid: str, fields: BusinessFields, products: list[ProductFields]
    ) -> bool:
        record = check_demo_seed(bid, fields)
        ref = self.businesses.document(bid)
        items = {product_key(p.name, p.unit): p.model_dump() for p in products}

        @firestore.transactional
        def run(transaction: Any) -> bool:
            snapshot = ref.get(transaction=transaction)
            stored = [
                (row.id, row.to_dict() or {})
                for row in ref.collection("inventory").limit(500).stream(transaction=transaction)
            ]
            now = time.time()
            if snapshot.exists:
                # Never take over a shop someone else owns, even under a demo-looking ID.
                data = self.owned(snapshot, uid)
                if (
                    data["fields"] == record
                    and data.get("public")
                    and {pid: row["fields"] for pid, row in stored} == items
                ):
                    return False
                transaction.update(
                    ref, {"fields": record, "revision": data["revision"] + 1, "public": True}
                )
            else:
                transaction.create(
                    ref,
                    {
                        "fields": record,
                        "revision": 1,
                        "status": "draft",
                        "owners": [uid],
                        "public": True,
                        "created": now,
                    },
                )
            for pid, _ in stored:
                if pid not in items:
                    transaction.delete(ref.collection("inventory").document(pid))
            # Menu order is kept through `created`, as in commit().
            for order, (pid, item) in enumerate(items.items()):
                transaction.set(
                    ref.collection("inventory").document(pid),
                    {"fields": item, "created": now + order / 1000, "updated": now},
                )
            return True

        return bool(run(self.client.transaction()))

    def attach_demo_owner(self, uid: str, bid: str, owner_uid: str) -> bool:
        if not owner_uid.strip():
            raise ValueError("Demo owner UID must not be empty.")
        ref = self.businesses.document(document_id(bid, "Business not found."))

        @firestore.transactional
        def run(transaction: Any) -> bool:
            data = self.owned(ref.get(transaction=transaction), uid)
            check_demo_seed(bid, BusinessFields.model_validate(data["fields"]))
            if owner_uid in data["owners"]:
                return False
            transaction.update(ref, {"owners": [*data["owners"], owner_uid]})
            return True

        return bool(run(self.client.transaction()))

    def seed_demo_inquiries(self, uid: str, bid: str, inquiries: list[Inquiry]) -> bool:
        ref = self.businesses.document(document_id(bid, "Business not found."))

        @firestore.transactional
        def run(transaction: Any) -> bool:
            data = self.owned(ref.get(transaction=transaction), uid)
            check_demo_seed(bid, BusinessFields.model_validate(data["fields"]))
            records = [
                (ref.collection("inquiries").document(document_id(i.id, "Invalid inquiry.")), i)
                for i in inquiries
            ]
            missing = [(r, i) for r, i in records if not r.get(transaction=transaction).exists]
            for record, inquiry in missing:
                transaction.create(record, inquiry.model_dump())
            return bool(missing)

        return bool(run(self.client.transaction()))

    def owners(self, bid: str) -> list[str]:
        try:
            ref = self.businesses.document(document_id(bid, "Not found."))
        except HTTPException:
            return []
        snapshot = ref.get()
        return list((snapshot.to_dict() or {}).get("owners") or []) if snapshot.exists else []

    def public_shop(self, bid: str) -> dict[str, Any] | None:
        try:
            ref = self.businesses.document(document_id(bid, "Not found."))
        except HTTPException:
            return None
        snapshot = ref.get()
        data = snapshot.to_dict() if snapshot.exists else None
        if not data or not data.get("public"):
            return None
        rows = [s.to_dict() or {} for s in ref.collection("inventory").limit(500).stream()]
        rows.sort(key=lambda row: row.get("created", 0))
        return {
            **public_projection(ref.id, data["fields"], [row["fields"] for row in rows]),
            "last_confirmed": data.get("last_confirmed"),
            "gallery": data.get("gallery") or [],
            "icon": data.get("icon"),
        }

    def subscribe_stock(self, bid: str, body: StockAlertInput) -> StockAlertReceipt:
        business = self.businesses.document(document_id(bid, "Shop not available."))
        ref = business.collection("stock_alerts").document(alert_key(body))

        @firestore.transactional
        def run(transaction: Any) -> StockAlertReceipt:
            parent = business.get(transaction=transaction).to_dict() or {}
            items = list(business.collection("inventory").stream(transaction=transaction))
            check_item(
                {"products": [(p.to_dict() or {})["fields"] for p in items]}
                if parent.get("public") and not parent.get("deleting")
                else None,
                body,
            )
            alerts = list(business.collection("stock_alerts").stream(transaction=transaction))
            now = time.time()
            live = [p for p in alerts if (p.to_dict() or {})["expires"] > now]
            for alert in alerts:
                if (alert.to_dict() or {})["expires"] <= now:
                    transaction.delete(alert.reference)
            prior = next((p for p in live if p.id == ref.id), None)
            if prior:
                return StockAlertReceipt(expires=(prior.to_dict() or {})["expires"])
            if len(live) >= MAX_ALERTS:
                raise HTTPException(429, "Too many reminders. Try again later.")
            expires = now + ALERT_SECONDS
            # Serialize capacity checks for distinct devices on the same shop, including
            # requests handled by different server processes. This is subscription metadata.
            transaction.update(
                business, {"stock_alert_revision": parent.get("stock_alert_revision", 0) + 1}
            )
            transaction.set(
                ref,
                {
                    "device_id": str(body.device_id),
                    "name": body.name,
                    "unit": body.unit,
                    "expires": expires,
                    "ready": False,
                },
            )
            return StockAlertReceipt(expires=expires)

        # Prevent same-process read-lock upgrades from starving each other's retries.
        # The shared parent write still enforces the limit across server processes.
        with self.stock_alert_lock:
            return run(self.client.transaction())

    def stock_alerts(self, bid: str, device_id: str) -> list[dict[str, Any]]:
        business = self.businesses.document(document_id(bid, "Shop not available."))

        @firestore.transactional
        def run(transaction: Any) -> list[dict[str, Any]]:
            parent = business.get(transaction=transaction).to_dict() or {}
            if not parent.get("public") or parent.get("deleting"):
                raise HTTPException(404, "Shop not available.")
            alerts = list(business.collection("stock_alerts").stream(transaction=transaction))
            result = []
            now = time.time()
            for snapshot in alerts:
                data = snapshot.to_dict() or {}
                if data["expires"] <= now:
                    transaction.delete(snapshot.reference)
                elif data["device_id"] == device_id:
                    result.append({key: data[key] for key in ("name", "unit", "expires", "ready")})
            return result

        return run(self.client.transaction())

    def sales_history(self, uid: str, bid: str) -> list[dict[str, Any]]:
        ref = self.businesses.document(document_id(bid, "Business not found."))

        @firestore.transactional
        def run(transaction: Any) -> list[dict[str, Any]]:
            self.owned(ref.get(transaction=transaction), uid)
            days = list(ref.collection("sales_days").stream(transaction=transaction))
            return [
                sale
                for day in sorted(days, key=lambda d: d.id)
                for sale in (day.to_dict() or {})["sales"]
            ]

        return run(self.client.transaction())

    def prepare_sales(self, uid: str, bid: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
        ref = self.businesses.document(document_id(bid, "Business not found."))
        pending = ref.collection("sales_imports").document(hashlib.sha256(uid.encode()).hexdigest())

        @firestore.transactional
        def run(transaction: Any) -> dict[str, Any]:
            business = self.owned(ref.get(transaction=transaction), uid)
            proposal = prepare_import({"id": bid, **business}, rows)
            transaction.set(
                pending, {"uid": uid, "proposal": json.dumps(proposal, ensure_ascii=False)}
            )
            return proposal

        return run(self.client.transaction())

    def save_sales(self, uid: str, bid: str, iid: str, digest: str) -> dict[str, Any]:
        ref = self.businesses.document(document_id(bid, "Business not found."))
        iid = document_id(iid, "Sales import not found.")
        pending = ref.collection("sales_imports").document(hashlib.sha256(uid.encode()).hexdigest())

        @firestore.transactional
        def run(transaction: Any) -> dict[str, Any]:
            business = self.owned(ref.get(transaction=transaction), uid)
            data = pending.get(transaction=transaction).to_dict()
            if not data or data["uid"] != uid:
                raise HTTPException(404, "Sales import not found.")
            proposal = json.loads(data["proposal"])
            if proposal["id"] != iid:
                raise HTTPException(404, "Sales import not found.")
            check_import(proposal, digest, business["revision"])
            if proposal.get("receipt"):
                return dict(proposal["receipt"])
            incoming = sales_days(proposal["snapshot"]["sales"])
            prior = list(ref.collection("sales_days").stream(transaction=transaction))
            retained = [
                sale
                for day in prior
                if day.id not in incoming
                for sale in (day.to_dict() or {})["sales"]
            ]
            validate_capacity(retained + proposal["snapshot"]["sales"])
            for day, sales in incoming.items():
                transaction.set(ref.collection("sales_days").document(day), {"sales": sales})
            transaction.update(ref, {"revision": business["revision"] + 1})
            receipt = {"business_id": bid, "import_id": iid, "saved": True, "days": len(incoming)}
            proposal["receipt"] = receipt
            transaction.set(
                pending, {"uid": uid, "proposal": json.dumps(proposal, ensure_ascii=False)}
            )
            return receipt

        return run(self.client.transaction())

    def confirm_menu(self, uid: str, bid: str) -> dict[str, Any]:
        ref = self.businesses.document(document_id(bid, "Business not found."))

        @firestore.transactional
        def run(transaction: Any) -> dict[str, Any]:
            business = self.owned(ref.get(transaction=transaction), uid)
            day = today_for(business["fields"]).isoformat()
            transaction.update(ref, {"last_confirmed": day})
            return {"business_id": bid, "last_confirmed": day}

        return run(self.client.transaction())

    def set_notes(self, uid: str, bid: str, notes: list[dict[str, Any]]) -> list[dict[str, Any]]:
        ref = self.businesses.document(document_id(bid, "Business not found."))

        @firestore.transactional
        def run(transaction: Any) -> list[dict[str, Any]]:
            self.owned(ref.get(transaction=transaction), uid)
            transaction.update(ref, {"coach_notes": notes})
            return notes

        return cast(list[dict[str, Any]], run(self.client.transaction()))

    def playbook(self, uid: str, bid: str) -> dict[str, Any] | None:
        # Businesses saved before playbooks simply have no field (lazy migration on first use).
        stored = migrate_stored(self.owned_business(uid, bid).get("playbook"))
        return stored.model_dump() if stored else None

    def set_playbook(self, uid: str, bid: str, value: dict[str, Any] | None) -> None:
        ref = self.businesses.document(document_id(bid, "Business not found."))
        snapshot = ref.get()
        self.owned(snapshot, uid)
        # Precondition on the read version: an ownership change in between fails the write.
        ref.update(
            {"playbook": value if value else firestore.DELETE_FIELD},
            option=self.client.write_option(last_update_time=snapshot.update_time),
        )

    def set_icon(self, uid: str, bid: str, icon: str | None) -> str | None:
        ref = self.businesses.document(document_id(bid, "Business not found."))

        @firestore.transactional
        def run(transaction: Any) -> str | None:
            self.owned(ref.get(transaction=transaction), uid)
            transaction.update(ref, {"icon": icon})
            return icon

        return cast(str | None, run(self.client.transaction()))

    def set_gallery(self, uid: str, bid: str, photos: list[str]) -> list[str]:
        ref = self.businesses.document(document_id(bid, "Business not found."))

        @firestore.transactional
        def run(transaction: Any) -> list[str]:
            self.owned(ref.get(transaction=transaction), uid)
            transaction.update(ref, {"gallery": photos})
            return photos

        return cast(list[str], run(self.client.transaction()))

    def analytics_shops(self, limit: int) -> list[tuple[str, str]]:
        return [
            (str(data["owners"][0]), snapshot.id)
            for snapshot in self.businesses.select(["owners", "deleting"]).limit(limit).stream()
            if (data := snapshot.to_dict() or {}).get("owners") and not data.get("deleting")
        ]

    def recap_signals(self, uid: str, bid: str) -> dict[str, Any]:
        ref = self.businesses.document(document_id(bid, "Business not found."))

        @firestore.transactional
        def run(transaction: Any) -> dict[str, Any]:
            business = self.owned(ref.get(transaction=transaction), uid)
            return {
                "fields": business["fields"],
                "sold_out": {
                    s.id: (s.to_dict() or {})["count"]
                    for s in ref.collection("sold_out_days").stream(transaction=transaction)
                },
                "questions": [
                    s.to_dict() or {}
                    for s in ref.collection("inquiries").stream(transaction=transaction)
                ],
            }

        return run(self.client.transaction())

    def recap_cache(
        self, uid: str, bid: str, key: str, value: dict[str, Any] | None = None
    ) -> dict[str, Any] | None:
        ref = self.businesses.document(document_id(bid, "Business not found."))
        cache = ref.collection("recaps").document(hashlib.sha256(key.encode()).hexdigest())

        @firestore.transactional
        def run(transaction: Any) -> dict[str, Any] | None:
            self.owned(ref.get(transaction=transaction), uid)
            if value is not None:
                transaction.set(cache, value)
                return value
            data = cache.get(transaction=transaction).to_dict()
            return dict(data) if data else None

        return run(self.client.transaction())

    # Contact records never enter public projections, ADK tools or merchant revisions.
    def supplier_orders(self, uid: str, bid: str) -> list[dict[str, Any]]:
        ref = self.businesses.document(document_id(bid, "Business not found."))
        self.owned(ref.get(), uid)
        rows = [s.to_dict() or {} for s in ref.collection("supplier_orders").limit(200).stream()]
        rows.sort(key=lambda row: row.get("created", 0), reverse=True)
        return rows[:100]

    def save_supplier_order(self, uid: str, bid: str, order: dict[str, Any]) -> dict[str, Any]:
        ref = self.businesses.document(document_id(bid, "Business not found."))
        item = ref.collection("supplier_orders").document(
            document_id(order["id"], "Order not found.")
        )

        @firestore.transactional
        def run(transaction: Any) -> dict[str, Any]:
            self.owned(ref.get(transaction=transaction), uid)
            snapshot = item.get(transaction=transaction)
            stored = (snapshot.to_dict() or {}).get("version", 0) if snapshot.exists else 0
            if order["version"] != stored + 1:
                raise HTTPException(409, "This order changed. Reload it.")
            transaction.set(item, order)
            return order

        return cast(dict[str, Any], run(self.client.transaction()))

    def add_inquiry(self, bid: str, body: InquiryInput) -> InquiryReceipt:
        business = self.businesses.document(document_id(bid, "Shop not found."))
        data, token = new_thread(body)
        ref = business.collection("inquiries").document(data["id"])
        block = business.collection("inquiry_blocks").document(contact_hash(body.contact))

        @firestore.transactional
        def run(transaction: Any) -> InquiryReceipt:
            shop = business.get(transaction=transaction).to_dict() or {}
            blocked = block.get(transaction=transaction).exists
            if not shop.get("public"):
                raise HTTPException(404, "This shop page is not available.")
            if blocked:
                raise HTTPException(409, "This conversation is closed.")
            transaction.create(ref, data)
            return InquiryReceipt(id=ref.id, token=token)

        with self.inquiry_lock:
            return run(self.client.transaction())

    def inquiries(self, uid: str, bid: str) -> list[Inquiry]:
        self.owned_business(uid, bid)
        query = self.businesses.document(document_id(bid, "Business not found.")).collection(
            "inquiries"
        )
        records = [Inquiry.model_validate(snapshot.to_dict()) for snapshot in query.stream()]
        return sorted(
            records,
            key=lambda r: (
                not (r.unread and not r.done),
                -r.messages[-1].created if r.messages else -r.created,
            ),
        )[:100]

    def complete_inquiry(self, uid: str, bid: str, iid: str) -> Inquiry:
        return self.thread_action(uid, bid, iid, "", "close")

    def thread_action(
        self, uid: str | None, bid: str, iid: str, token: str, action: str, text: str = ""
    ) -> Inquiry:
        business = self.businesses.document(document_id(bid, "Business not found."))
        ref = business.collection("inquiries").document(document_id(iid, "Conversation not found."))

        @firestore.transactional
        def run(transaction: Any) -> Inquiry:
            shop = business.get(transaction=transaction)
            if uid is not None:
                self.owned(shop, uid)
            elif not shop.exists or (shop.to_dict() or {}).get("deleting"):
                raise HTTPException(404, "Conversation not found.")
            data = ref.get(transaction=transaction).to_dict()
            if data is None:
                raise HTTPException(404, "Conversation not found.")
            block = business.collection("inquiry_blocks").document(contact_hash(data["contact"]))
            blocked = block.get(transaction=transaction).exists
            record = change_thread(data, uid, token, action, text, blocked)
            if action == "delete":
                transaction.delete(ref)
            elif action != "get":
                transaction.set(ref, {**data, **record.model_dump()})
                if action == "unblock":
                    transaction.delete(block)
                    if data.get("token_hash"):
                        transaction.delete(
                            business.collection("inquiry_blocks").document(data["token_hash"])
                        )
                if action == "block":
                    transaction.set(block, {"blocked": True})
                    if data.get("token_hash"):
                        transaction.set(
                            business.collection("inquiry_blocks").document(data["token_hash"]),
                            {"blocked": True},
                        )
            return record

        with self.inquiry_lock:
            return run(self.client.transaction())

    def planning(
        self, uid: str, bid: str, pid: str, action: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        from datetime import date

        from .planning import change

        business_ref = self.businesses.document(document_id(bid, "Business not found."))
        if not re.fullmatch(r"[0-9a-f]{64}", pid):
            raise HTTPException(404, "Product not found.")
        item_ref = business_ref.collection("inventory").document(pid)
        ref = business_ref.collection("planning").document(pid)

        @firestore.transactional
        def run(transaction: Any) -> dict[str, Any]:
            business = self.owned(business_ref.get(transaction=transaction), uid)
            if not item_ref.get(transaction=transaction).exists:
                raise HTTPException(404, "Product not found.")
            change_payload = payload
            state = ref.get(transaction=transaction).to_dict() or {}
            if action != "read":
                if action == "prepare":
                    change_payload = {
                        **payload,
                        "business_id": bid,
                        "product_id": pid,
                        "revision": business["revision"],
                    }
                elif (
                    state.get("pending", {}).get("snapshot", {}).get("revision")
                    != business["revision"]
                ):
                    raise HTTPException(409, "Business changed. Review planning again.")
                state = change(state, action, change_payload, date.today())
                transaction.set(ref, state)
            return dict(state)

        return run(self.client.transaction())

    def get_connector_mapping(self, uid: str, bid: str, source_label: str) -> dict[str, Any] | None:
        self.owned_business(uid, bid)
        ref = self.businesses.document(document_id(bid, "Business not found."))
        doc = ref.collection("connector_mappings").document(source_label.lower().strip()).get()
        return doc.to_dict() if doc.exists else None

    def list_connector_mappings(self, uid: str, bid: str) -> list[dict[str, Any]]:
        self.owned_business(uid, bid)
        ref = self.businesses.document(document_id(bid, "Business not found."))
        docs = ref.collection("connector_mappings").stream()
        return [doc.to_dict() for doc in docs]

    def save_connector_mapping(self, uid: str, bid: str, mapping: dict[str, Any]) -> dict[str, Any]:
        self.owned_business(uid, bid)
        ref = self.businesses.document(document_id(bid, "Business not found."))
        now = time.time()
        source_label = mapping["source_label"]
        doc_ref = ref.collection("connector_mappings").document(source_label.lower().strip())
        record = {
            "source_label": source_label,
            "fields": mapping,
            "last_synced": None,
            "updated": now,
        }
        doc_ref.set(record)
        return record

    def record_connector_sync(self, uid: str, bid: str, source_label: str) -> None:
        self.owned_business(uid, bid)
        ref = self.businesses.document(document_id(bid, "Business not found."))
        now = time.time()
        doc_ref = ref.collection("connector_mappings").document(source_label.lower().strip())
        doc = doc_ref.get()
        if doc.exists:
            doc_ref.update({"last_synced": now})
