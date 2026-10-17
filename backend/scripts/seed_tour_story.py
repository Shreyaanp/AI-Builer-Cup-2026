"""Seed the fictional Bengaluru and Singapore tour. No model or payment service is used."""

from __future__ import annotations

import argparse
import os
from datetime import date
from pathlib import Path

from app.community import Community, Documents, FirestoreDocuments, SqliteDocuments
from app.tour_catalogue import TOUR_SHOPS
from app.tour_story import seed_story
from scripts.seed_demo_shops import open_store


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sqlite", help="Local merchant database (no provider contact)")
    parser.add_argument("--project", help="Explicit production project; owner-run only")
    parser.add_argument("--database", default="(default)")
    parser.add_argument("--namespace", default="ogoogle_ai_v1")
    parser.add_argument("--owner-uid", help="Create a private tour shop per world for this account")
    parser.add_argument("--customer-uid", help="Fill an empty demo customer's passport and chats")
    parser.add_argument("--date", type=date.fromisoformat, help="Shop-local story date, YYYY-MM-DD")
    parser.add_argument(
        "--reset", action="store_true", help="Restore only the labelled tour fixtures"
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if args.sqlite and args.project:
        parser.error("Choose SQLite or an explicit project, not both.")
    if any(
        value is not None and not value.strip() for value in (args.owner_uid, args.customer_uid)
    ):
        parser.error("Account IDs must not be empty.")
    if args.dry_run:
        print(
            "Plan: 8 Bengaluru shops, 5 Singapore shops, 2 demo suppliers, 56 completed sales days."
        )
        print("Demo only: rewards, replied chats, reviews, rescue deals and supplier documents.")
        return 0
    if not args.sqlite and not args.project and not os.getenv("FIRESTORE_EMULATOR_HOST"):
        parser.error(
            "Use --sqlite, a local Firestore emulator, or an explicit owner-run --project."
        )
    store = open_store(args)
    docs: Documents
    if args.sqlite:
        path = Path(args.sqlite)
        docs = SqliteDocuments(str(path.with_name(path.stem + "-community.sqlite3")))
    else:
        from app.merchant_firestore import FirestoreMerchantStore

        assert isinstance(store, FirestoreMerchantStore)
        docs = FirestoreDocuments(store.client, args.namespace)
    seed_story(
        store,
        Community(docs),
        owner_uid=args.owner_uid,
        customer_uid=args.customer_uid,
        today=args.date,
        reset=args.reset,
    )
    print(f"Tour ready: {len(TOUR_SHOPS)} labelled demo shops; no model or payment was called.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
