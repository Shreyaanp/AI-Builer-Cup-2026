"""Demo shops, their six weeks of sales and sample customer activity.

Used by the seed script and by the in-app demo workspace (guided tour). Everything is
fictional and labelled as demo data.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from random import Random
from typing import Any
from uuid import NAMESPACE_URL, uuid5
from zoneinfo import ZoneInfo

from .customer import Inquiry, ThreadMessage
from .demo_catalogue import INTERNATIONAL_SHOPS, DemoShop, item, shop

SHOPS = [
    shop(
        "demo-katong-kopitiam",
        name="Sunny Side Kopitiam",
        category="Kopitiam",
        location="East Coast Road, Katong (demo)",
        lat=1.3052,
        lng=103.9045,
        pin_label="Near Katong (approximate)",
        hours="06:30–15:00",
        phone="+65 6000 0001",
        halal="not_stated",
        payment_methods=["cash", "paynow", "nets"],
        delivery="none",
        busy_hours="07:30–09:30",
        products=[
            item("Kopi", 170, "cup"),
            item("Kopi O", 150, "cup"),
            item("Teh", 170, "cup"),
            item("Milo dinosaur", 300, "cup"),
            item("Kaya toast set", 520, "set"),
            item("Soft-boiled eggs", 180, "pair"),
            item("Mee siam", 450, "plate", available=False),
            item("Curry puff", 180, "piece"),
        ],
    ),
    shop(
        "demo-tiong-bahru-bakery",
        name="Crumb & Courtyard Bakery",
        category="Bakery",
        location="Tiong Bahru estate (demo)",
        lat=1.2853,
        lng=103.8318,
        pin_label="Near Tiong Bahru (approximate)",
        hours="08:00–18:00",
        phone="+65 6000 0002",
        halal="no",
        vegetarian_options=True,
        locally_made=True,
        payment_methods=["paynow", "card", "grabpay"],
        delivery="grab",
        preorders=True,
        preorder_lead_time="1 day ahead for whole cakes",
        products=[
            item("Kouign-amann", 520, "piece"),
            item("Butter croissant", 450, "piece"),
            item("Pandan chiffon slice", 380, "slice"),
            item("Sourdough loaf", 1200, "loaf"),
            item("Kaya bun", 280, "piece", available=False),
            item("Earl Grey cake", 5800, "whole cake"),
            item("Flat white", 600, "cup"),
        ],
    ),
    shop(
        "demo-geylang-serai-nasi-lemak",
        name="Serai Sunrise Nasi Lemak",
        category="Hawker stall · Nasi lemak",
        location="Geylang Serai (demo)",
        lat=1.3166,
        lng=103.8985,
        pin_label="Near Geylang Serai (approximate)",
        hours="07:00–14:00",
        phone="+65 6000 0003",
        halal="yes",
        payment_methods=["cash", "paynow"],
        delivery="foodpanda",
        busy_hours="11:30–13:30",
        products=[
            item("Nasi lemak (ikan bilis)", 350, "plate"),
            item("Nasi lemak with chicken wing", 550, "plate"),
            item("Nasi lemak with rendang", 650, "plate", available=False),
            item("Sambal sotong add-on", 250, "portion"),
            item("Otah", 150, "piece"),
            item("Teh tarik", 160, "cup"),
        ],
    ),
    shop(
        "demo-bugis-bubble-tea",
        name="Pearl Lane Bubble Tea",
        category="Bubble tea",
        location="Bugis (demo)",
        lat=1.3003,
        lng=103.8558,
        pin_label="Near Bugis (approximate)",
        hours="11:00–22:00",
        phone="+65 6000 0004",
        halal="not_stated",
        vegetarian_options=True,
        locally_made=True,
        payment_methods=["paynow", "card", "grabpay"],
        delivery="grab",
        busy_hours="15:00–18:00",
        products=[
            item("Brown sugar pearl milk", 520, "cup"),
            item("Jasmine green tea", 380, "cup"),
            item("Oolong milk tea", 480, "cup"),
            item("Mango yakult", 520, "cup", available=False),
            item("Taro milk tea", 500, "cup"),
            item("Lychee aloe tea", 450, "cup"),
            item("Cheese foam add-on", 100, "add-on"),
            item("Matcha latte", 560, "cup", available=False),
        ],
    ),
    shop(
        "demo-toa-payoh-hardware",
        name="Lorong Fix-It Hardware",
        category="Hardware shop",
        location="Toa Payoh (demo)",
        lat=1.3343,
        lng=103.8563,
        pin_label="Near Toa Payoh (approximate)",
        hours="09:00–19:00",
        phone="+65 6000 0005",
        payment_methods=["cash", "paynow", "nets"],
        delivery="own",
        delivery_note="Toa Payoh area, orders over $30",
        custom_facts=[
            {"key": "key_cutting", "label": "Key cutting", "value": "While you wait, about 5 min"}
        ],
        products=[
            item("LED bulb (E27, 9W)", 450, "piece"),
            item("Extension cord (3m)", 1290, "piece"),
            item("Duct tape", 380, "roll"),
            item("Cable ties (100)", 290, "pack"),
            item("Screwdriver set", 1590, "set"),
            item("PVC pipe glue", 650, "tube", available=False),
            item("Key cutting", 400, "key"),
            item("AA batteries (4)", 520, "pack"),
            item("Mosquito net repair kit", 890, "kit"),
            item("Door hinge", 350, "piece"),
        ],
    ),
    shop(
        "demo-joo-chiat-florist",
        name="Petal Studio Joo Chiat",
        category="Florist",
        location="Joo Chiat Road (demo)",
        lat=1.3135,
        lng=103.9017,
        pin_label="Near Joo Chiat (approximate)",
        hours="10:00–19:00",
        phone="+65 6000 0006",
        payment_methods=["paynow", "card"],
        delivery="own",
        delivery_note="Same-day island-wide before 2 pm",
        preorders=True,
        preorder_lead_time="2 days for large arrangements",
        products=[
            item("Hand-tied bouquet (small)", 4500, "bouquet"),
            item("Hand-tied bouquet (large)", 8800, "bouquet"),
            item("Sunflower stem", 600, "stem"),
            item("Orchid pot", 3800, "pot"),
            item("Hydrangea bunch", 3200, "bunch", available=False),
            item("Graduation bouquet", 5500, "bouquet"),
        ],
    ),
    *INTERNATIONAL_SHOPS,
]


def sales_history(demo: DemoShop, today: date, days: int = 42) -> list[dict[str, Any]]:
    """Stable per date/item: weekly seasonality, a small trend, and bounded noise.

    End yesterday in the shop's timezone; today's trading is never invented as a full day.
    Stable absolute dates also keep overlapping days identical when rerun tomorrow.
    """
    rows = []
    for offset in range(days, 0, -1):
        day = today - timedelta(days=offset)
        for index, product in enumerate(demo.products):
            rng = Random(f"{demo.id}/{product.name}/{day}")
            base = 10 + (len(demo.products) - index) * 3
            if product.unit == "service":
                base = 3 + index % 3
            pattern = (0.85, 0.90, 0.95, 1.0, 1.10, 1.35, 1.20)[day.weekday()]
            trend = 1 + (day - date(2026, 1, 1)).days * 0.0002
            quantity = max(1, round(base * pattern * max(0.5, trend) * rng.uniform(0.90, 1.10)))
            rows.append(
                {
                    "date": day.isoformat(),
                    "item": product.name,
                    "quantity": quantity,
                    "revenue": product.price * quantity,
                }
            )
    return rows


def customer_activity(demo: DemoShop, today: date) -> list[Inquiry]:
    """Two questions last week and one today, visibly fictional, with stable IDs."""
    monday = today - timedelta(days=today.weekday())
    days = [monday - timedelta(days=5), monday - timedelta(days=2), today]
    messages = [
        f"[Demo] Can I collect two {demo.products[0].name} tomorrow?",
        "[Demo] Which payment methods do you accept?",
        "[Demo] Are you open this afternoon? This is a sample inquiry.",
    ]
    return [
        Inquiry(
            id=str(uuid5(NAMESPACE_URL, f"chalkboard-demo/{demo.id}/inquiry/{i}")),
            name=f"Demo customer {i + 1}",
            contact=f"demo-customer-{i + 1}@example.invalid",
            message=message,
            created=(
                stamp := datetime.combine(
                    day, time.min if day == today else time(10, 15), ZoneInfo(demo.fields.timezone)
                ).timestamp()
            ),
            messages=[
                ThreadMessage(
                    id=str(uuid5(NAMESPACE_URL, f"chalkboard-demo/{demo.id}/message/{i}")),
                    author="customer",
                    text=message,
                    created=stamp,
                )
            ],
        )
        for i, (day, message) in enumerate(zip(days, messages, strict=True))
    ]
