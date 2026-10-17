"""Bundled demo menu artwork. Never fetched from an external image service."""

from pathlib import Path

from .demo_catalogue import DemoShop
from .merchant import MerchantRepository


def photo_id(demo: DemoShop) -> str:
    from .tour_story import stable

    return stable("gallery/" + demo.id)


def seed_gallery(store: MerchantRepository, uid: str, demo: DemoShop) -> None:
    if not store.context(uid, demo.id)["business"].get("gallery"):
        store.set_gallery(uid, demo.id, [photo_id(demo)])


def bundled_photo(photo: str) -> bytes | None:
    from .tour_catalogue import TOUR_SHOPS

    for demo in TOUR_SHOPS:
        if photo_id(demo) == photo:
            return (Path(__file__).parent / "demo_media" / f"{demo.id}.jpg").read_bytes()
    return None
