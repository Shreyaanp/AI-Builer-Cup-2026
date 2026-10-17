"""Deterministic tour fixtures, shared by the CLI, local dev and the in-app tour.

Only labelled demo records are written. Normal reruns preserve replies, stock, rewards and
order progress. Reset is scoped to the dedicated fixture owner, never the visiting owner.
"""

from __future__ import annotations

import secrets
from datetime import date, datetime, time, timedelta
from typing import Any
from uuid import NAMESPACE_URL, uuid5
from zoneinfo import ZoneInfo

from . import rescue
from . import supply_chain as supply
from .community import Community, Documents, Tip, thread_key
from .customer import Inquiry, ThreadMessage
from .demo_catalogue import DemoShop
from .demo_data import sales_history
from .forecast import weekday_average
from .games import issue_scratch
from .merchant import MerchantRepository
from .passport import PassportState, Visit, apply_rescue, apply_visit
from .playbook import gather_inputs, offline_draft, stored_from
from .sales import today_for
from .supply_docs import SupplyDoc, render
from .supply_rules import ItemRule, PriceTier, RuleSet
from .threads import token_hash
from .tour_catalogue import TOUR_SHOPS
from .tour_media import photo_id, seed_gallery

SEED_OWNER = "chalkboard-tour-story-owner"


class SeedInquiry(Inquiry):
    """Internal persistence shape; the capability is never included in public responses."""

    token_hash: str


def history(demo: DemoShop, day: date) -> list[dict[str, Any]]:
    rows = sales_history(demo, day, 56)
    products = {p.name: p for p in demo.products}
    for row in rows:
        product = products[row["item"]]
        if product.unit == "kg":
            row["quantity"] = round(row["quantity"] / 20, 1)
        elif product.unit == "cup":
            row["quantity"] *= 3
        row["revenue"] = round(row["quantity"] * product.price)
    return rows


def stable(value: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"chalkboard-tour-story/{value}"))


def stamp(day: date, zone: str, hour: int = 12) -> float:
    return datetime.combine(day, time(hour), ZoneInfo(zone)).timestamp()


def put_once(
    docs: Documents, kind: str, key: str, scope: str, at: float, data: dict[str, Any]
) -> None:
    def change(old: dict[str, Any] | None) -> tuple[float, dict[str, Any]] | None:
        return (at, data) if old is None else None

    docs.update(kind, key, scope, change)


def inquiries(demo: DemoShop, day: date) -> list[Inquiry]:
    item = demo.products[0].name
    result = []
    for index, (name, question, answer) in enumerate(
        [
            (
                "Asha",
                f"[Demo] Can I collect two {item} at five?",
                "Yes, I'll keep two for you at the counter. See you at five!",
            ),
            (
                "Wei",
                "[Demo] Can I pay at the counter?",
                "Yes, cash and the listed local payment method are welcome.",
            ),
            ("Priya", f"[Demo] Is {item} available this afternoon?", ""),
        ]
    ):
        at = stamp(day - timedelta(days=2 - index), demo.fields.timezone, 0 if index == 2 else 10)
        iid = stable(f"{demo.id}/inquiry/{index}")
        messages = [
            ThreadMessage(id=stable(iid + "/ask"), author="customer", text=question, created=at)
        ]
        if answer:
            messages.append(
                ThreadMessage(
                    id=stable(iid + "/reply"),
                    author="owner",
                    kind="demo",
                    text=answer,
                    created=at + 300,
                )
            )
        result.append(
            Inquiry(
                id=iid,
                name=f"{name} (Demo)",
                contact=f"tour-{index}@example.invalid",
                message=question,
                messages=messages,
                created=at,
                unread=not bool(answer),
            )
        )
    return result


def seed_shop(
    store: MerchantRepository,
    uid: str,
    demo: DemoShop,
    day: date,
    *,
    public: bool = True,
) -> None:
    owned = {b["id"]: b for b in store.list_businesses(uid)}
    if demo.id not in owned:
        store.seed_demo_shop(uid, demo.id, demo.fields, demo.products, public=public)
    elif not owned[demo.id]["fields"].get("demo"):
        raise ValueError("Tour seed cannot replace an unlabelled shop.")
    previous = {r["date"] for r in store.sales_history(uid, demo.id)}
    rows = [r for r in history(demo, day) if r["date"] not in previous]
    if rows:
        pending = store.prepare_sales(uid, demo.id, rows)
        store.save_sales(uid, demo.id, pending["id"], pending["digest"])
    store.seed_demo_inquiries(uid, demo.id, inquiries(demo, day))
    seed_gallery(store, uid, demo)
    # Today consumes two aggregate days. Eight weeks of per-item closes live in sales_days;
    # avoid hundreds of redundant per-document commits during a first tour on a phone.
    for ago in (1, 0):
        local_day = day - timedelta(days=ago)
        put_once(
            store.feature_docs,
            "shop_daily",
            f"{demo.id}:{local_day}",
            demo.id,
            stamp(local_day, demo.fields.timezone),
            {
                "views": 32 + local_day.toordinal() % 19,
                "stamps": 7 + ago % 5,
                "returning": 3 + ago % 3,
            },
        )
    context = store.context(uid, demo.id)
    if store.playbook(uid, demo.id) is None:
        inputs = gather_inputs(
            context["business"],
            context["inventory"],
            store.sales_history(uid, demo.id),
            [q.model_dump() for q in store.inquiries(uid, demo.id)],
            day,
        )
        book = stored_from(
            offline_draft(inputs),
            "offline",
            inputs,
            "en",
            None,
            datetime.fromtimestamp(stamp(day, demo.fields.timezone), ZoneInfo("UTC")),
        )
        store.set_playbook(uid, demo.id, book.model_dump())


def seed_reviews(community: Community, demo: DemoShop, day: date) -> None:
    details = (
        f"{demo.products[0].name} matched the menu price. I'd come back.",
        f"Asked about {demo.products[1].name}; the owner replied before I walked over.",
    )
    for index, text in enumerate(details):
        tip = Tip(
            id=f"demo-{index}",
            name=("Asha", "Wei")[index] + " (Demo)",
            text=text,
            rating=5 - index,
            demo=True,
            created=stamp(day - timedelta(days=index + 2), demo.fields.timezone),
        )
        put_once(
            community.docs, "tip", f"{demo.id}\0{tip.id}", demo.id, tip.created, tip.model_dump()
        )


def seed_rescue(store: MerchantRepository, demo: DemoShop, day: date) -> None:
    """One calendar-day sample, including early-morning viewing; never a real offer."""
    if demo.fields.category not in {
        "Tea stall",
        "Kopitiam",
        "Bakery",
        "Home kitchen",
        "Hawker stall",
    }:
        return
    product = demo.products[2]
    opens = stamp(day, demo.fields.timezone, 0)
    ends = stamp(day + timedelta(days=1), demo.fields.timezone, 0)
    rid = stable(f"{demo.id}/rescue/{day}")
    state = store.feature_docs.get("rescue", demo.id) or {}
    # Preserve holds and owner edits on today's fixture; refresh only after it expires.
    previous = [entry for entry in state.get("deals", []) if "data" in entry]
    if any(d["data"].get("day") == day.isoformat() for d in previous):
        return
    deal = {
        "id": rid,
        "shop_id": demo.id,
        "day": day.isoformat(),
        "currency": demo.fields.currency,
        "starts": opens,
        "ends": ends,
        "status": "live",
        "demo": True,
        "pickup_note": "Demo only · collect during listed shop hours; nothing is reserved.",
        "holds": {},
        "fingerprint": "demo-seed",
        "items": [
            {
                "name": product.name,
                "qty": 6,
                "qty_left": 6,
                "price": round(product.price * 0.7),
                "was": product.price,
                "unit": product.unit,
            }
        ],
    }
    entry = {"id": rid, "digest": stable(rid + "/digest"), "data": deal}
    store.feature_docs.put(
        "rescue", demo.id, demo.id, opens, {**state, "deals": [entry, *previous][:20]}
    )
    rescue.publish_update(store, deal)


def seed_supply(store: MerchantRepository, uid: str, demo: DemoShop, day: date) -> None:
    """A linked, offline forecast → PO → ORDRSP → DESADV → invoice, awaiting receipt."""
    bid = demo.id
    po_id = stable(f"{bid}/purchase-order")
    if store.feature_docs.get(supply.ORDERS, supply._key(bid, po_id)):
        return
    product = demo.products[4]
    sid = f"demo-story-{demo.city}-supplier"
    supplier_name = (
        "Lantern Tea Wholesale (Demo)" if demo.city == "bengaluru" else "Dawn Bean Supply (Demo)"
    )
    fields = demo.fields.model_copy(
        update={
            "name": supplier_name,
            "category": "Wholesaler",
            "supplier": True,
            "supplies": [product.name],
            "reward_text": "",
            "description": "Fictional supplier; no order leaves this demo.",
        }
    )
    supplier_product = product.model_copy(
        update={"price": round(product.price * 0.7), "stock": 500}
    )
    if store.public_shop(sid) is None:
        store.seed_demo_shop(SEED_OWNER, sid, fields, [supplier_product])
    at = stamp(day - timedelta(days=2), fields.timezone)
    rules = RuleSet(
        system_format="idoc",
        terms_days=7,
        credit_limit=100_000_000,
        items=[
            ItemRule(
                item=product.name,
                unit=product.unit,
                moq=5,
                pack=5,
                lead_days=1,
                tiers=[PriceTier(min_quantity=10, price=supplier_product.price)],
            )
        ],
    )
    relationship = {
        "supplier": {"id": sid, "name": supplier_name, "demo": True},
        "currency": fields.currency,
        "rules": rules.model_dump(),
        "suggested": False,
        "pending": None,
        "created": at,
        "version": 1,
    }
    put_once(store.feature_docs, supply.RULES, supply._key(bid, sid), bid, at, relationship)
    rows = store.sales_history(uid, bid)
    predictions = weekday_average(rows, day)
    forecast = {
        "method": "weekday_average",
        # The general supplier matcher also relates chai to tea leaves. This sample PO
        # replenishes the exact kg item, so cups must not enter its quantity calculation.
        "predictions": [p.model_dump(mode="json") for p in predictions if p.item == product.name],
    }
    need = supply.need_from_forecast(product.model_dump(), forecast, product.name, day)
    wanted = max(5, round(need["daily"] * 9 - need["stock"]))
    candidate = {"row": relationship, "product": supplier_product.model_dump()}
    best = supply.quote(store, bid, candidate, product.name, product.unit, wanted, "", day)
    assert best is not None
    po: dict[str, Any] = {
        "id": po_id,
        "number": "4500000001",
        "status": "draft",
        "sent": False,
        "auto_sent": False,
        "created": at,
        "currency": fields.currency,
        "buyer": {"id": bid, "name": demo.fields.name, "system": "json"},
        "supplier": best["supplier"],
        "terms_days": 7,
        "lines": [best["line"]],
        "total": 0,
        "need_by": "",
        "delivery": "",
        "alternatives": [],
        "faster_supplier": None,
        "documents": [],
        "backorders": [],
        "received": False,
        "simulated": True,
        "version": 1,
        "reason": {
            **need,
            "item": product.name,
            "unit": product.unit,
            "wanted": wanted,
            "owner_quantity": False,
            "on_time": best["on_time"],
            "headroom": best["headroom"],
            "tier_min": best["tier_min"],
            "options": 1,
        },
    }
    supply.recheck(store, bid, po, day)
    original = supply.po_document(po)
    for index, kind in enumerate(("ORDERS", "ORDRSP", "DESADV", "INVOIC")):
        doc = SupplyDoc.model_validate(
            {
                **original.model_dump(),
                "kind": kind,
                "number": po["number"] if index == 0 else str(7100000000 + index),
                "ref": "" if index == 0 else po["number"],
                "note": "Simulated demo document; no external system connected.",
            }
        )
        entry = supply.document_entry(
            doc,
            "buyer" if index == 0 else "supplier",
            render(doc, "json" if index == 0 else "idoc"),
            "json" if index == 0 else "idoc",
            render(doc, "idoc" if index == 0 else "json"),
            "idoc" if index == 0 else "json",
            [],
            "parser",
        )
        entry.update(id=stable(f"{bid}/{kind}"), at=at + index * 3600, simulated=True)
        po["documents"].append(entry)
        if index:
            supply.apply_document(store, bid, po, doc, [])
    po.update(sent=True, sent_at=at, status="invoiced", version=4)
    store.feature_docs.put(supply.ORDERS, supply._key(bid, po_id), bid, at, po)
    put_once(store.feature_docs, supply.SEQUENCE, bid, bid, at, {"po": 1})


def seed_customer_threads(
    store: MerchantRepository,
    community: Community,
    uid: str,
    demos: list[DemoShop],
    day: date,
    *,
    reset: bool,
) -> None:
    """Restore missing demo conversations while keeping existing replies and ownership."""
    for city in dict.fromkeys(d.city for d in demos):
        demo = next(d for d in demos if d.city == city)
        iid = stable(f"{uid}/{demo.id}/thread")
        existing = {q.id for q in store.inquiries(SEED_OWNER, demo.id)}
        if not reset and iid in existing and community.docs.get("thread", thread_key(uid, iid)):
            continue
        capability = secrets.token_urlsafe(32)
        thread = SeedInquiry(
            **{**inquiries(demo, day)[0].model_dump(), "id": iid}, token_hash=token_hash(capability)
        )
        if iid in existing:
            store.thread_action(SEED_OWNER, demo.id, iid, "", "delete")
        store.seed_demo_inquiries(SEED_OWNER, demo.id, [thread])
        community.docs.put(
            "thread",
            thread_key(uid, iid),
            uid,
            thread.created,
            {
                "bid": demo.id,
                "iid": iid,
                "token": capability,
                "seen": thread.messages[0].id,
                "created": thread.created,
            },
        )


def seed_customer(
    store: MerchantRepository,
    community: Community,
    uid: str,
    demos: list[DemoShop],
    day: date,
    *,
    reset: bool = False,
) -> None:
    """Attach demo activity once to an empty passport; never replace real customer history."""
    old = community.docs.get("passport", uid)
    # Taking the owner tour must still work if this account has a real customer passport.
    if old and old.get("stamps") and not reset and any(not s.get("demo") for s in old["stamps"]):
        return
    if old and (old.get("points") or any(not s.get("demo") for s in old.get("stamps", []))):
        raise ValueError("Reset refused: this customer has non-demo passport activity.")
    seed_customer_threads(store, community, uid, demos, day, reset=reset)
    if old and old.get("stamps") and not reset:
        return
    state = PassportState(name="Demo neighbour")
    for index, demo in enumerate(demos):
        shop = store.public_shop(demo.id)
        if not shop:
            continue
        if demo.id == next(s.id for s in demos if s.city == demo.city):
            # One fictional traveller: Bengaluru first, Singapore later, never visits in
            # different countries a few minutes apart just to fill both stamp cards.
            visits = (56, 49, 42, 35, 28) if demo.city == "bengaluru" else (21, 14, 7, 3, 1)
            for ago in visits:
                at = stamp(day - timedelta(days=ago), demo.fields.timezone, 8)
                apply_visit(state, Visit(shop_id=demo.id, shop=shop, at=at))
                record = state.stamps[0]
                record.id = stable(f"{demo.id}/visit/{ago}")
                ticket = issue_scratch(state, record, demo.fields.reward_text, below=lambda _: 0)
                ticket.id = stable(f"{demo.id}/scratch/{ago}")
            apply_rescue(
                state,
                demo.id,
                shop,
                stable(demo.id + "/collected"),
                stamp(
                    day - timedelta(days=26 if demo.city == "bengaluru" else 1),
                    demo.fields.timezone,
                ),
                round(demo.products[2].price * 0.3),
            )
            state.stamps[0].id = stable(demo.id + "/collected-stamp")
        else:
            apply_visit(
                state,
                Visit(
                    shop_id=demo.id,
                    shop=shop,
                    at=stamp(
                        day - timedelta(days=27 + index // 4 if demo.city == "bengaluru" else 2),
                        demo.fields.timezone,
                    ),
                ),
            )
            state.stamps[0].id = stable(demo.id + "/first")
        if demo.id not in community.profile(uid).follows:
            community.follow(uid, demo.id, True)
    at = stamp(day, demos[0].fields.timezone)
    community.docs.put("passport", uid, uid, at, state.model_dump())


def seed_story(
    store: MerchantRepository,
    community: Community,
    *,
    owner_uid: str | None = None,
    customer_uid: str | None = None,
    today: date | None = None,
    reset: bool = False,
) -> list[str]:
    """Seed the two public worlds. Owner access is explicit; reruns keep user actions."""
    if reset and customer_uid:
        old = community.docs.get("passport", customer_uid) or {}
        if old.get("points") or any(not s.get("demo") for s in old.get("stamps", [])):
            raise ValueError("Reset refused: this customer has non-demo passport activity.")
    if reset:
        owned = store.list_businesses(SEED_OWNER)
        expected = {s.id for s in TOUR_SHOPS} | {
            f"demo-story-{city}-supplier" for city in ("bengaluru", "singapore")
        }
        if any(b["id"] not in expected or not b["fields"].get("demo") for b in owned):
            raise ValueError("Reset refused: fixture owner has records outside the tour.")
        store.erase_owner(SEED_OWNER)
    for demo in TOUR_SHOPS:
        day = today or today_for(demo.fields.model_dump())
        seed_shop(store, SEED_OWNER, demo, day)
        seed_reviews(community, demo, day)
        seed_rescue(store, demo, day)
    owners = [next(s for s in TOUR_SHOPS if s.city == city) for city in ("bengaluru", "singapore")]
    for demo in owners:
        day = today or today_for(demo.fields.model_dump())
        seed_supply(store, SEED_OWNER, demo, day)
        if owner_uid:
            seed_workspace(store, owner_uid, demo.city, today, reset=reset)
    if customer_uid:
        seed_customer(
            store,
            community,
            customer_uid,
            TOUR_SHOPS,
            today or today_for(owners[0].fields.model_dump()),
            reset=reset,
        )
    return [s.id for s in TOUR_SHOPS]


def tour_id(uid: str, city: str) -> str:
    # Keep both coach transports' ordinary business-ID contract without changing them.
    return stable(f"workspace/{uid}/{city}")


def seed_workspace(
    store: MerchantRepository,
    uid: str,
    city: str,
    today: date | None = None,
    *,
    reset: bool = False,
) -> tuple[str, bool]:
    """One private, explicitly fictional owner shop per world and account."""
    bid = tour_id(uid, city)
    existing = next((b for b in store.list_businesses(uid) if b["id"] == bid), None)
    original = next(s for s in TOUR_SHOPS if s.city == city)
    fields = original.fields.model_copy(update={"name": original.fields.name + " (Tour)"})
    if city == "bengaluru":
        # An invalid provider is deliberate: the sample QR must never route real money.
        fields.upi_id = "chalkboard-demo@example.invalid"
    demo = DemoShop(bid, fields, original.products, city)
    day = today or today_for(fields.model_dump())
    if existing and reset:
        if not existing["fields"].get("demo"):
            raise ValueError("Reset refused: this shop is not labelled demo.")
        store.seed_demo_shop(uid, bid, fields, original.products, public=False)
        for inquiry in store.inquiries(uid, bid):
            store.thread_action(uid, bid, inquiry.id, "", "delete")
        for kind in ("rescue", "shop_daily", *supply.SUPPLY_KINDS):
            store.feature_docs.delete_scope(kind, bid)
        store.set_playbook(uid, bid, None)
        pending = store.prepare_sales(uid, bid, history(demo, day))
        store.save_sales(uid, bid, pending["id"], pending["digest"])
    seed_shop(store, uid, demo, day, public=False)
    # Private copies reuse the bundled world's artwork. Keep any owner-selected gallery
    # on normal reruns; only reset restores the sample image.
    gallery = store.context(uid, bid)["business"].get("gallery")
    if reset or gallery == [photo_id(demo)]:
        store.set_gallery(uid, bid, [photo_id(original)])
    seed_rescue(store, demo, day)
    # A private tour uses the public world's supplier; only the PO belongs to the visitor.
    seed_supply(store, uid, demo, day)
    store.share(uid, bid, False)
    return bid, existing is None
