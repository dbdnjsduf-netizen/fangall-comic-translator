import json
import sys
from pathlib import Path

from PIL import Image


def main():
    if len(sys.argv) != 4:
        print("Usage: python crop_padded_image.py <input_png> <metadata_json> <output_image>", file=sys.stderr)
        return 2

    input_path = Path(sys.argv[1])
    metadata_path = Path(sys.argv[2])
    output_path = Path(sys.argv[3])

    with metadata_path.open("r", encoding="utf-8") as f:
        info = json.load(f)

    padded_size = int(info["padded_size"])
    original_width = int(info["original_width"])
    original_height = int(info["original_height"])
    pad_x = int(round(float(info["pad_x"])))
    pad_y = int(round(float(info["pad_y"])))
    content_width = int(round(float(info.get("content_width", original_width))))
    content_height = int(round(float(info.get("content_height", original_height))))

    pad_x = max(0, min(pad_x, padded_size - 1))
    pad_y = max(0, min(pad_y, padded_size - 1))
    content_width = max(1, min(content_width, padded_size - pad_x))
    content_height = max(1, min(content_height, padded_size - pad_y))

    output_path.parent.mkdir(parents=True, exist_ok=True)

    with Image.open(input_path) as img:
        img = img.convert("RGBA")
        if img.size != (padded_size, padded_size):
            img = img.resize((padded_size, padded_size), Image.Resampling.LANCZOS)

        cropped = img.crop((pad_x, pad_y, pad_x + content_width, pad_y + content_height))
        if cropped.size != (original_width, original_height):
            cropped = cropped.resize((original_width, original_height), Image.Resampling.LANCZOS)

        suffix = output_path.suffix.lower()
        if suffix in [".jpg", ".jpeg"]:
            cropped = cropped.convert("RGB")
            cropped.save(output_path, "JPEG", quality=95)
        else:
            cropped.save(output_path, "PNG")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
