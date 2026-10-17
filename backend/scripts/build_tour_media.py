"""Build local demo menu artwork. These are illustrations, never business photographs."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from app.money import to_major
from app.tour_catalogue import TOUR_SHOPS


def main() -> None:
    target = Path(__file__).resolve().parents[1] / "app" / "demo_media"
    target.mkdir(exist_ok=True)
    for demo in TOUR_SHOPS:
        image = Image.new("RGB", (960, 640), "#24372F")
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((24, 24, 936, 616), radius=20, outline="#C4D3B4", width=3)
        title = ImageFont.load_default(size=34)
        body = ImageFont.load_default(size=26)
        small = ImageFont.load_default(size=21)
        draw.text((55, 55), demo.fields.name.replace(" (Demo)", ""), font=title, fill="#F4E9CF")
        draw.text(
            (55, 110), "DEMO MENU · fictional shop · local artwork", font=small, fill="#D2DBBB"
        )
        for index, product in enumerate(demo.products):
            y = 175 + index * 54
            price = f"{demo.fields.currency} {to_major(product.price, demo.fields.currency):g}"
            draw.text((55, y), product.name, font=body, fill="#FFF7E3")
            draw.text((735, y), price, font=body, fill="#E5C877")
        draw.text(
            (55, 550),
            demo.fields.hours.replace("–", "-") + " · " + demo.fields.category,
            font=small,
            fill="#D2DBBB",
        )
        image.save(target / f"{demo.id}.jpg", quality=85, optimize=True)


if __name__ == "__main__":
    main()
