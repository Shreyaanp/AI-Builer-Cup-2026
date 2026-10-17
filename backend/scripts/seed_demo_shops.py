"""Seed labelled fictional shops, six weeks of sales and sample customer activity.

Every shop is fictional: invented names, non-contactable sample numbers, approximate pins, and
the "Demo shop" label on every customer-facing surface. Re-running is safe (idempotent).

Usage (from backend/):
  FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 uv run python -m scripts.seed_demo_shops --owner-uid UID
  uv run python -m scripts.seed_demo_shops --owner-uid UID --sqlite .data/merchant.sqlite3
  uv run python -m scripts.seed_demo_shops --owner-uid UID --dry-run
A real project is only touched with an explicit --project (never by default).
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import Counter
from datetime import date
from typing import Any

from app.demo_data import SHOPS, customer_activity, sales_history
from app.merchant import MerchantRepository
from app.sales import today_for

EMULATOR_PROJECT = "demo-ogoogle-local"


def seed(
    store: MerchantRepository,
    seed_owner_uid: str = "demo-world-owner",
    *,
    owner_uid: str | None = None,
    city: str | None = None,
    today: date | None = None,
) -> list[tuple[str, bool]]:
    """Use normal sealed sales imports. Reruns preserve revisions and customer replies.

    The seed owner retains access; the optional real account gets one shop per city.
    Existing demo IDs owned by someone else are still rejected by seed_demo_shop.
    """
    attached: set[str] = set()
    results = []
    for demo in SHOPS:
        if city and demo.city != city:
            continue
        day = today or today_for(demo.fields.model_dump())
        changed = store.seed_demo_shop(seed_owner_uid, demo.id, demo.fields, demo.products)
        existing = store.sales_history(seed_owner_uid, demo.id)
        expected = sales_history(demo, day)
        # Only changed/new days go through import approval. No duplicate receipts/revisions.
        previous = {r["date"]: [] for r in existing}
        for row in existing:
            previous[row["date"]].append(row)
        incoming: dict[str, list[dict[str, Any]]] = {}
        for row in expected:
            incoming.setdefault(row["date"], []).append(row)
        pending = [r for d, rows in incoming.items() if previous.get(d) != rows for r in rows]
        if pending:
            proposal = store.prepare_sales(seed_owner_uid, demo.id, pending)
            store.save_sales(seed_owner_uid, demo.id, proposal["id"], proposal["digest"])
            changed = True
        changed = (
            store.seed_demo_inquiries(seed_owner_uid, demo.id, customer_activity(demo, day))
            or changed
        )
        if owner_uid and demo.city not in attached:
            changed = store.attach_demo_owner(seed_owner_uid, demo.id, owner_uid) or changed
            attached.add(demo.city)
        results.append((demo.id, changed))
    from app.demo_supply_seed import seed as seed_supply_chain

    seed_supply_chain(store, seed_owner_uid)
    return results


def open_store(args: argparse.Namespace) -> MerchantRepository:
    if args.sqlite:
        from app.merchant import MerchantStore

        return MerchantStore(args.sqlite)
    from google.cloud import firestore

    from app.merchant_firestore import FirestoreMerchantStore

    if args.project:
        client = firestore.Client(project=args.project, database=args.database)
    else:
        from google.auth.credentials import AnonymousCredentials

        client = firestore.Client(project=EMULATOR_PROJECT, credentials=AnonymousCredentials())
    return FirestoreMerchantStore(client, args.namespace)


def parse(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--owner-uid", help="Also attach one demo shop per city to this account")
    parser.add_argument(
        "--seed-owner-uid", default="demo-world-owner", help="Owner of all fixtures"
    )
    parser.add_argument("--city", type=str.casefold, choices=sorted({s.city for s in SHOPS}))
    parser.add_argument("--dry-run", action="store_true", help="Print the plan; write nothing")
    parser.add_argument("--namespace", default="ogoogle_ai_v1", help="App Firestore namespace")
    parser.add_argument("--sqlite", help="Seed a local SQLite merchant database instead")
    parser.add_argument(
        "--project",
        help="Real Google Cloud project. Required to leave the emulator; never implied.",
    )
    parser.add_argument("--database", default="(default)", help="Firestore database (--project)")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse(argv)
    if not args.seed_owner_uid.strip() or (
        args.owner_uid is not None and not args.owner_uid.strip()
    ):
        print("Owner UIDs must not be empty.", file=sys.stderr)
        return 2
    target = (
        f"SQLite {args.sqlite}"
        if args.sqlite
        else f"Firestore project {args.project} ({args.database}) / {args.namespace}"
        if args.project
        else f"Firestore emulator {os.getenv('FIRESTORE_EMULATOR_HOST')} / {args.namespace}"
    )
    if (
        not args.dry_run
        and not args.sqlite
        and not args.project
        and not os.getenv("FIRESTORE_EMULATOR_HOST")
    ):
        print(
            "Refusing: FIRESTORE_EMULATOR_HOST is not set. Start the emulator, use --sqlite, or "
            "pass --project explicitly to seed a real project.",
            file=sys.stderr,
        )
        return 2
    print(f"Target: {target}")
    selected = [s for s in SHOPS if not args.city or s.city == args.city]
    print(f"Demo shops per city: {dict(Counter(s.city for s in selected))}")
    attached: set[str] = set()
    for demo in selected:
        sold_out = sum(not p.available for p in demo.products)
        print(f"  {demo.id}: {demo.fields.name} · {len(demo.products)} items, {sold_out} sold out")
        print("    42 days of demo sales; 3 demo customer inquiries; recap uses saved records")
        if args.owner_uid and demo.city not in attached:
            print(f"    Also attach this demo shop to owner {args.owner_uid}")
            attached.add(demo.city)
    if args.dry_run:
        print("Dry run: nothing written.")
        return 0
    for bid, changed in seed(
        open_store(args),
        args.seed_owner_uid.strip(),
        owner_uid=args.owner_uid.strip() if args.owner_uid else None,
        city=args.city,
    ):
        print(f"  {bid}: {'seeded' if changed else 'already up to date'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
