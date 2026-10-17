"""Two authored, fictional neighbourhoods. No place lookup or model call is needed."""

from .demo_catalogue import DemoShop, item, shop
from .merchant import Understanding
from .money import to_minor
from .region import profile
from .vendor_profile import allowed_facts, infer_profile

_INDIA = profile("IN")
_SINGAPORE = profile("SG")
CENTRES = {
    "bengaluru": (12.9718, 77.6412, _INDIA.currency, _INDIA.timezone, "Indiranagar, Bengaluru"),
    "singapore": (
        1.3052,
        103.9045,
        _SINGAPORE.currency,
        _SINGAPORE.timezone,
        "Katong, Singapore",
    ),
}


def local_shop(
    city: str,
    slug: str,
    name: str,
    category: str,
    story: str,
    hours: str,
    menu: list[tuple[str, float, str]],
    index: int,
) -> DemoShop:
    lat, lng, currency, zone, area = CENTRES[city]
    profile = infer_profile(category, story)
    allowed = allowed_facts({"profile": profile.model_dump()})
    products = [item(n, to_minor(p, currency), u, category=category) for n, p, u in menu]
    if category == "Bakery":
        for product in products:
            product.category = (
                "Bread" if any(w in product.name.lower() for w in ("bread", "loaf")) else "Bakes"
            )
    products[-1].available = False
    products[0].stock = 4  # A concrete, actionable low-stock row on Today.
    if index == 0:
        products[4].stock = 1  # Tea leaves / coffee beans link the pulse to a supplier order.
    return shop(
        f"demo-story-{city}-{slug}",
        city=city,
        name=name,
        category=category,
        profile=profile,
        description=story,
        location=f"{index + 1} Demo Lane, {area} (fictional address)",
        lat=lat + (index // 3 - 1) * 0.003,
        lng=lng + (index % 3 - 1) * 0.003,
        pin_label=f"{area} · approximate demo pin",
        currency=currency,
        timezone=zone,
        hours=hours,
        payment_methods=["cash", "UPI" if currency == "INR" else "paynow"],
        delivery="none" if "delivery" in allowed else None,
        vegetarian_options=True
        if "vegetarian_options" in allowed and category == "Home kitchen"
        else None,
        locally_made=(category in {"Tea stall", "Kopitiam", "Bakery", "Home kitchen", "Florist"})
        if "locally_made" in allowed
        else None,
        busy_hours="07:30–09:30" if index == 0 else "17:00–19:00",
        reward_text={
            "Tailor": "Free button repair",
            "Mobile repair": "Free port clean",
            "Phone repair": "Free port clean",
            "Florist": "A free stem",
            "Helmet cleaning": "A free visor wipe",
            "Grocery / Kirana": "A free cloth bag",
            "Bakery": "A free bun",
            "Home kitchen": "A free chapati set",
            "Hawker stall": "A free teh",
        }.get(category, "A free chai" if currency == "INR" else "A free kopi"),
        stamps_needed=8,
        understanding=Understanding(
            focus="less_waste" if index == 0 else "more_customers",
            regulars="Morning commuters and neighbours on their way home",
        ),
        custom_facts=[
            *(
                [
                    {
                        "key": "demo_verified",
                        "label": "Demo badge",
                        "value": "Simulated badge; no identity or business check was performed.",
                    }
                ]
                if index == 0
                else []
            ),
            {"key": "story", "label": "Why go", "value": story},
            {
                "key": "languages",
                "label": "Languages",
                "value": "Hindi, English"
                if currency == "INR"
                else "English, Mandarin, Malay, Tamil",
            },
        ],
        products=products,
    )


def catalogue() -> list[DemoShop]:
    india: list[tuple[str, str, str, str, str, list[tuple[str, float, str]]]] = [
        (
            "chai",
            "Lantern Chai Corner",
            "Tea stall",
            "Ginger chai brewed in small pots; bun maska warmed to order.",
            "06:30–21:00",
            [
                ("Masala chai", 20, "cup"),
                ("Ginger chai", 25, "cup"),
                ("Bun maska", 35, "piece"),
                ("Samosa", 20, "piece"),
                ("Tea leaves", 320, "kg"),
                ("Ragi biscuit", 15, "piece"),
            ],
        ),
        (
            "bakery",
            "Butter Window Bakery",
            "Bakery",
            "Vegetarian-only puffs leave the oven at four; ask for the warm tray.",
            "07:00–21:00",
            [
                ("Vegetable puff", 35, "piece"),
                ("Butter croissant", 95, "piece"),
                ("Milk bread", 55, "piece"),
                ("Coconut bun", 30, "piece"),
                ("Khari biscuits", 80, "pack"),
                ("Plum cake", 140, "slice"),
            ],
        ),
        (
            "tailor",
            "Needle Courtyard",
            "Tailor",
            "Trouser hems ready the same evening; fittings by appointment.",
            "10:00–20:00",
            [
                ("Trouser hemming", 150, "service"),
                ("Zip replacement", 180, "service"),
                ("Shirt fitting", 250, "service"),
                ("Kurta stitching", 850, "service"),
                ("Button repair", 40, "service"),
                ("Curtain shortening", 200, "piece"),
            ],
        ),
        (
            "phone",
            "Pocket Fix Workshop",
            "Mobile repair",
            "A written quote before every repair; data stays on your phone.",
            "10:00–21:00",
            [
                ("Screen replacement", 1800, "service"),
                ("Battery replacement", 950, "service"),
                ("Charging port clean", 150, "service"),
                ("Screen protector", 180, "piece"),
                ("USB-C cable", 250, "piece"),
                ("Speaker repair", 650, "service"),
            ],
        ),
        (
            "flowers",
            "Petal Pocket",
            "Florist",
            "Jasmine strings tied each morning; paper-wrapped bouquets on request.",
            "07:00–20:30",
            [
                ("Jasmine string", 40, "piece"),
                ("Marigold garland", 120, "piece"),
                ("Rose bouquet", 450, "bunch"),
                ("Sunflower", 80, "piece"),
                ("Orchid bunch", 650, "bunch"),
                ("Festival flower basket", 300, "item"),
            ],
        ),
        (
            "helmet",
            "Fresh Helmet Stop",
            "Helmet cleaning",
            "Self-service helmet cleaning beside the cycle stand; a ten-minute stop.",
            "08:00–22:00",
            [
                ("Helmet clean", 79, "service"),
                ("Deep liner clean", 149, "service"),
                ("Visor polish", 49, "service"),
                ("Two helmet cleans", 139, "set"),
                ("Helmet liner", 199, "piece"),
                ("Rain cover", 99, "piece"),
            ],
        ),
        (
            "kitchen",
            "Tiffin Window",
            "Home kitchen",
            "Twenty vegetarian-only lunch boxes cooked each morning; order before ten.",
            "08:00–20:00",
            [
                ("Vegetarian thali", 120, "plate"),
                ("Lemon rice", 70, "plate"),
                ("Chapati set", 40, "set"),
                ("Curd rice", 65, "plate"),
                ("Dal", 50, "pack"),
                ("Weekend biryani", 150, "plate"),
            ],
        ),
        (
            "kirana",
            "Little Lantern Kirana",
            "Grocery / Kirana",
            "Bring a container for rice and lentils; small quantities welcome.",
            "07:00–22:00",
            [
                ("Sona masoori rice", 65, "kg"),
                ("Toor dal", 155, "kg"),
                ("Atta", 58, "kg"),
                ("Tea leaves", 280, "kg"),
                ("Milk", 28, "pack"),
                ("Jaggery", 85, "pack"),
            ],
        ),
    ]
    singapore: list[tuple[str, str, str, str, str, list[tuple[str, float, str]]]] = [
        (
            "kopi",
            "Sunny Side Kopitiam",
            "Kopitiam",
            "Kopi ground at dawn, kaya toast grilled when you order.",
            "06:30–20:00",
            [
                ("Kopi", 1.7, "cup"),
                ("Kopi O", 1.5, "cup"),
                ("Kaya toast set", 5.2, "set"),
                ("Soft-boiled eggs", 1.8, "set"),
                ("Coffee beans", 18, "kg"),
                ("Curry puff", 1.8, "piece"),
            ],
        ),
        (
            "hawker",
            "Serai Sunrise Kitchen",
            "Hawker stall",
            "Small-batch coconut rice and house sambal, ready for the lunch queue.",
            "07:00–20:00",
            [
                ("Nasi lemak", 3.5, "plate"),
                ("Chicken wing set", 5.5, "plate"),
                ("Otah", 1.5, "piece"),
                ("Teh tarik", 1.6, "cup"),
                ("Sambal egg", 1.2, "piece"),
                ("Rendang set", 6.5, "plate"),
            ],
        ),
        (
            "flowers",
            "Petal Studio Katong",
            "Florist",
            "Seasonal stems wrapped in reused paper; small bunches welcome.",
            "09:00–20:00",
            [
                ("Small bouquet", 28, "bunch"),
                ("Sunflower", 6, "piece"),
                ("Orchid pot", 38, "item"),
                ("Rose trio", 15, "bunch"),
                ("Dried flower jar", 22, "item"),
                ("Graduation bouquet", 55, "bunch"),
            ],
        ),
        (
            "bakery",
            "Crumb & Courtyard",
            "Bakery",
            "Vegetarian-only bakes; pandan chiffon and sourdough sliced to order.",
            "07:00–21:00",
            [
                ("Butter croissant", 4.5, "piece"),
                ("Pandan chiffon", 3.8, "slice"),
                ("Sourdough loaf", 12, "piece"),
                ("Kaya bun", 2.8, "piece"),
                ("Kouign-amann", 5.2, "piece"),
                ("Earl Grey cake", 58, "piece"),
            ],
        ),
        (
            "phone",
            "Pocket Circuit Repair",
            "Phone repair",
            "Upfront repair quotes and a bench you can watch from the counter.",
            "10:00–21:00",
            [
                ("Screen replacement", 98, "service"),
                ("Battery replacement", 48, "service"),
                ("Port clean", 12, "service"),
                ("Screen protector", 10, "piece"),
                ("USB-C cable", 12, "piece"),
                ("Speaker repair", 38, "service"),
            ],
        ),
    ]
    return [
        local_shop(city, slug, name, kind, story, hours, menu, index)
        for city, specs in (("bengaluru", india), ("singapore", singapore))
        for index, (slug, name, kind, story, hours, menu) in enumerate(specs)
    ]


TOUR_SHOPS = catalogue()
