import argparse
import difflib
import json
import math
import sys
import unicodedata
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont


ATLAS_SIZE = 2048
ATLAS_MARGIN = 20
ATLAS_GUTTER = 14
TILE_HEADER = 34
DETECTOR_THRESHOLD = 0.28
EFFECT_DETECTOR_THRESHOLD = 0.05


def clamp(value, low, high):
    return max(low, min(high, value))


def clamp_box(box, width, height):
    x1, y1, x2, y2 = box
    x1 = int(clamp(round(x1), 0, max(0, width - 1)))
    y1 = int(clamp(round(y1), 0, max(0, height - 1)))
    x2 = int(clamp(round(x2), x1 + 1, width))
    y2 = int(clamp(round(y2), y1 + 1, height))
    return [x1, y1, x2, y2]


def box_area(box):
    return max(0, box[2] - box[0]) * max(0, box[3] - box[1])


def box_iou(a, b):
    ix1 = max(a[0], b[0])
    iy1 = max(a[1], b[1])
    ix2 = min(a[2], b[2])
    iy2 = min(a[3], b[3])
    intersection = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    union = box_area(a) + box_area(b) - intersection
    return intersection / union if union else 0.0


def overlap_fraction(inner, outer):
    ix1 = max(inner[0], outer[0])
    iy1 = max(inner[1], outer[1])
    ix2 = min(inner[2], outer[2])
    iy2 = min(inner[3], outer[3])
    intersection = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    area = box_area(inner)
    return intersection / area if area else 0.0


def expand_box(box, amount_x, amount_y, width, height):
    return clamp_box(
        [box[0] - amount_x, box[1] - amount_y, box[2] + amount_x, box[3] + amount_y],
        width,
        height,
    )


def union_box(a, b, width, height):
    return clamp_box(
        [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])],
        width,
        height,
    )


def center_distance(a, b, width, height):
    ax = (a[0] + a[2]) / 2
    ay = (a[1] + a[3]) / 2
    bx = (b[0] + b[2]) / 2
    by = (b[1] + b[3]) / 2
    return math.hypot((ax - bx) / max(1, width), (ay - by) / max(1, height))


def deduplicate_boxes(scored_boxes, iou_threshold=0.72, containment_threshold=0.88):
    kept = []
    for box, score in sorted(scored_boxes, key=lambda item: item[1], reverse=True):
        if box_area(box) < 16:
            continue
        duplicate = False
        for kept_box, _ in kept:
            if box_iou(box, kept_box) >= iou_threshold:
                duplicate = True
                break
            if overlap_fraction(box, kept_box) >= containment_threshold:
                duplicate = True
                break
        if not duplicate:
            kept.append((box, score))
    return kept


def merge_nearby_effect_boxes(boxes, width, height):
    merged = [list(box) for box in boxes]
    changed = True
    while changed:
        changed = False
        for left_index in range(len(merged)):
            left = merged[left_index]
            left_margin = max(8, min(72, round(max(left[2] - left[0], left[3] - left[1]) * 0.30)))
            left_expanded = expand_box(left, left_margin, left_margin, width, height)
            for right_index in range(left_index + 1, len(merged)):
                right = merged[right_index]
                right_margin = max(8, min(72, round(max(right[2] - right[0], right[3] - right[1]) * 0.30)))
                right_expanded = expand_box(right, right_margin, right_margin, width, height)
                if box_iou(left_expanded, right_expanded) <= 0:
                    continue
                combined = union_box(left, right, width, height)
                if box_area(combined) / max(1, width * height) > 0.028:
                    continue
                merged[left_index] = combined
                del merged[right_index]
                changed = True
                break
            if changed:
                break
    return merged


def detect_comic_regions(image, model_path):
    import onnxruntime as ort

    height, width = image.shape[:2]
    resized = cv2.resize(image, (640, 640), interpolation=cv2.INTER_LINEAR)
    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
    tensor = rgb.transpose(2, 0, 1)[None].astype(np.float32) / 255.0
    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    labels, boxes, scores = session.run(
        None,
        {
            "images": tensor,
            "orig_target_sizes": np.array([[width, height]], dtype=np.int64),
        },
    )

    bubble_boxes = []
    text_boxes = []
    effect_boxes = []
    for label, box, score in zip(labels[0], boxes[0], scores[0]):
        confidence = float(score)
        label = int(label)
        threshold = EFFECT_DETECTOR_THRESHOLD if label == 2 else DETECTOR_THRESHOLD
        if confidence < threshold:
            continue
        clean_box = clamp_box(box.tolist(), width, height)
        if label == 0:
            bubble_boxes.append((clean_box, confidence))
        elif label == 1:
            text_boxes.append((clean_box, confidence))
        elif label == 2:
            effect_boxes.append((clean_box, confidence))

    return (
        [box for box, _ in deduplicate_boxes(bubble_boxes)],
        [box for box, _ in deduplicate_boxes(text_boxes)],
        merge_nearby_effect_boxes(
            [
                box
                for box, _ in deduplicate_boxes(
                    effect_boxes,
                    iou_threshold=0.62,
                    containment_threshold=0.86,
                )
            ],
            width,
            height,
        ),
    )


def detect_easyocr_boxes(image_path, width, height):
    try:
        import easyocr

        reader = easyocr.Reader(["ja", "en"], gpu=False, verbose=False)
        results = reader.readtext(
            str(image_path),
            detail=1,
            paragraph=False,
            text_threshold=0.5,
            low_text=0.25,
            link_threshold=0.3,
        )
    except Exception as exc:
        print(f"EasyOCR fallback unavailable: {exc}", file=sys.stderr)
        return []

    boxes = []
    for polygon, _text, confidence in results:
        xs = [point[0] for point in polygon]
        ys = [point[1] for point in polygon]
        box = clamp_box([min(xs), min(ys), max(xs), max(ys)], width, height)
        boxes.append((box, max(0.01, float(confidence))))
    return [box for box, _ in deduplicate_boxes(boxes, iou_threshold=0.82, containment_threshold=0.94)]


def detect_contrast_effect_boxes(image):
    """Find bright outlined effects on dark art without attempting OCR."""
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    local = cv2.GaussianBlur(gray, (0, 0), 18.0)
    bright_detail = ((gray.astype(np.int16) - local.astype(np.int16) > 30) & (gray > 138)).astype(np.uint8) * 255
    bright_detail = cv2.morphologyEx(
        bright_detail,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)),
    )
    grouped = cv2.dilate(
        bright_detail,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (19, 19)),
        iterations=1,
    )
    count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(grouped, 8)
    boxes = []
    image_area = max(1, width * height)
    for index in range(1, count):
        x, y, component_width, component_height, area = stats[index]
        if area < 90 or component_width < 12 or component_height < 12:
            continue
        box = clamp_box([x, y, x + component_width, y + component_height], width, height)
        fraction = box_area(box) / image_area
        if fraction > 0.018:
            continue
        core = bright_detail[box[1] : box[3], box[0] : box[2]]
        if cv2.countNonZero(core) < 32:
            continue
        boxes.append(box)
    return merge_nearby_effect_boxes(boxes, width, height)


def normalize_ocr_text(text):
    normalized = unicodedata.normalize("NFKC", str(text or ""))
    return "".join(char for char in normalized if char.isalnum() or "\u3040" <= char <= "\u30ff" or "\u3400" <= char <= "\u9fff")


def ocr_similarity(expected, recognized):
    left = normalize_ocr_text(expected)
    right = normalize_ocr_text(recognized)
    if not left or not right:
        return 0.0
    ratio = difflib.SequenceMatcher(None, left, right).ratio()
    if left in right or right in left:
        ratio = max(ratio, min(len(left), len(right)) / max(len(left), len(right)))
    return ratio


def recognize_candidate_texts(image_path, candidates, width, height, enabled):
    recognized = {}
    if not enabled or not candidates:
        return recognized, "disabled"
    try:
        from manga_ocr import MangaOcr

        reader = MangaOcr(force_cpu=True)
        image = Image.open(image_path).convert("RGB")
    except Exception as exc:
        print(f"manga-ocr content matching unavailable: {exc}", file=sys.stderr)
        return recognized, f"unavailable: {exc}"

    for box in candidates:
        key = tuple(box)
        if key in recognized:
            continue
        short_side = min(box[2] - box[0], box[3] - box[1])
        padding = max(2, round(short_side * 0.035))
        crop_box = expand_box(box, padding, padding, width, height)
        try:
            recognized[key] = reader(image.crop(tuple(crop_box)))
        except Exception as exc:
            print(f"manga-ocr skipped {box}: {exc}", file=sys.stderr)
            recognized[key] = ""
    return recognized, "manga-ocr"


def translation_items(data):
    raw_items = data.get("reading_order") or data.get("blocks") or []
    items = []
    for index, raw in enumerate(raw_items):
        target = raw.get("translated_text") or raw.get("text") or raw.get("translated_markup") or ""
        target = " ".join(str(target).split()).strip()
        if not target:
            continue
        items.append(
            {
                "index": index,
                "id": f"T{index + 1:02d}",
                "source_text": str(raw.get("source_text") or ""),
                "target_text": target,
                "container_type": str(raw.get("container_type") or "other"),
                "text_color_hint": str(raw.get("text_color_hint") or "none"),
                "region": raw.get("region"),
                "region_verified": raw.get("region_verified"),
            }
        )
    return items


def normalized_region_to_box(region, width, height):
    if not isinstance(region, dict):
        return None
    try:
        x = float(region.get("x"))
        y = float(region.get("y"))
        box_width = float(region.get("width"))
        box_height = float(region.get("height"))
    except (TypeError, ValueError):
        return None
    if box_width <= 0 or box_height <= 0:
        return None
    scale = 1000.0 if max(abs(x), abs(y), abs(box_width), abs(box_height)) > 1.5 else 1.0
    return clamp_box(
        [x / scale * width, y / scale * height, (x + box_width) / scale * width, (y + box_height) / scale * height],
        width,
        height,
    )


def region_box_candidates(region, width, height):
    if not isinstance(region, dict):
        return []
    try:
        x = float(region.get("x"))
        y = float(region.get("y"))
        box_width = float(region.get("width"))
        box_height = float(region.get("height"))
    except (TypeError, ValueError):
        return []
    if box_width <= 0 or box_height <= 0:
        return []

    candidates = []
    normalized = clamp_box(
        [x / 1000.0 * width, y / 1000.0 * height, (x + box_width) / 1000.0 * width, (y + box_height) / 1000.0 * height],
        width,
        height,
    )
    candidates.append((normalized, "normalized"))
    if x < width and y < height:
        pixel = clamp_box([x, y, x + box_width, y + box_height], width, height)
        if box_iou(pixel, normalized) < 0.9:
            candidates.append((pixel, "pixel"))
    return candidates


def sort_text_boxes(boxes, preset):
    if not boxes:
        return []
    median_height = float(np.median([max(1, box[3] - box[1]) for box in boxes]))
    row_height = max(24.0, median_height * 0.75)
    rows = []
    for box in sorted(boxes, key=lambda value: (value[1] + value[3]) / 2):
        cy = (box[1] + box[3]) / 2
        row = next((entry for entry in rows if abs(entry["cy"] - cy) <= row_height), None)
        if row is None:
            row = {"cy": cy, "boxes": []}
            rows.append(row)
        row["boxes"].append(box)
        row["cy"] = sum((item[1] + item[3]) / 2 for item in row["boxes"]) / len(row["boxes"])
    ordered = []
    for row in sorted(rows, key=lambda entry: entry["cy"]):
        reverse = preset == "manga_jp"
        ordered.extend(sorted(row["boxes"], key=lambda value: (value[0] + value[2]) / 2, reverse=reverse))
    return ordered


def choose_detected_box(predictions, candidates, bubbles, used, item, width, height, recognized):
    if not predictions or not candidates:
        return None
    dialogue_like = item["container_type"] in ("speech", "caption", "narration") and len(item["source_text"].strip()) >= 5
    available = [(index, candidate) for index, candidate in enumerate(candidates) if index not in used]
    if dialogue_like:
        contained = [(index, candidate) for index, candidate in available if choose_bubble(candidate, bubbles) is not None]
        if contained:
            available = contained
    elif item["container_type"] == "sound_effect":
        outside_large_bubbles = []
        for index, candidate in available:
            if box_area(candidate) / max(1, width * height) > 0.022:
                continue
            candidate_bubble = choose_bubble(candidate, bubbles)
            bubble_fraction = box_area(candidate_bubble) / max(1, width * height) if candidate_bubble else 0.0
            if bubble_fraction <= 0.025:
                outside_large_bubbles.append((index, candidate))
        if outside_large_bubbles:
            available = outside_large_bubbles
    ranked = []
    for index, candidate in available:
        recognized_text = recognized.get(tuple(candidate), "")
        content_score = ocr_similarity(item["source_text"], recognized_text)
        best_prediction = None
        best_score = -999.0
        best_distance = 999.0
        best_overlap = 0.0
        for predicted, scale_name in predictions:
            overlap = box_iou(predicted, candidate)
            containment = max(overlap_fraction(predicted, candidate), overlap_fraction(candidate, predicted))
            distance = center_distance(predicted, candidate, width, height)
            area_ratio = max(box_area(predicted), box_area(candidate)) / max(1, min(box_area(predicted), box_area(candidate)))
            score = (
                overlap * 4.0
                + containment * 2.0
                + content_score * 5.0
                - distance
                - min(1.2, abs(math.log(area_ratio)) * 0.16)
            )
            candidate_bubble = choose_bubble(candidate, bubbles)
            inside_bubble = candidate_bubble is not None
            if dialogue_like:
                score += 0.45 if inside_bubble else -0.2
            elif inside_bubble:
                bubble_fraction = box_area(candidate_bubble) / max(1, width * height)
                score -= 3.0 if bubble_fraction > 0.025 else 0.35
            if score > best_score:
                best_prediction = scale_name
                best_score = score
                best_distance = distance
                best_overlap = max(overlap, containment)
        ranked.append(
            (
                best_score,
                content_score,
                best_distance,
                best_overlap,
                index,
                candidate,
                best_prediction,
                recognized_text,
            )
        )
    if not ranked:
        return None
    score, content_score, distance, overlap, index, candidate, scale_name, recognized_text = max(
        ranked,
        key=lambda entry: entry[0],
    )
    source_length = len(normalize_ocr_text(item["source_text"]))
    content_threshold = 0.56 if source_length >= 4 else 0.50
    geometry_is_strong = overlap >= 0.36 or distance <= 0.055
    if content_score < content_threshold and not geometry_is_strong:
        return None
    used.add(index)
    return candidate, scale_name, recognized_text, content_score


def choose_bubble(text_box, bubbles):
    best = None
    best_score = 0.0
    for bubble in bubbles:
        contained = overlap_fraction(text_box, bubble)
        overlap = box_iou(text_box, bubble)
        score = contained * 5.0 + overlap
        if score > best_score:
            best = bubble
            best_score = score
    return best if best_score >= 1.0 else None


def build_regions(items, text_boxes, effect_boxes, bubbles, easy_boxes, width, height, preset, recognized):
    candidates = deduplicate_boxes(
        [(box, 1.0) for box in text_boxes]
        + [(box, 0.86) for box in effect_boxes]
        + [(box, 0.7) for box in easy_boxes],
        iou_threshold=0.72,
        containment_threshold=0.88,
    )
    candidates = [box for box, _ in candidates]
    ordered = sort_text_boxes(candidates, preset)
    effect_order = [
        candidate
        for candidate in ordered
        if choose_bubble(candidate, bubbles) is None
        and any(
            box_iou(candidate, effect) >= 0.2
            or overlap_fraction(candidate, effect) >= 0.55
            or overlap_fraction(effect, candidate) >= 0.55
            for effect in effect_boxes
        )
    ]
    used = set()
    regions = []

    for item_index, item in enumerate(items):
        if item.get("region_verified") is True:
            text_box = normalized_region_to_box(item.get("region"), width, height)
            if text_box is None:
                continue
            recognized_text = item["source_text"]
            content_score = 1.0
            origin = "gpt_verified"
        elif item.get("region_verified") is False:
            continue
        else:
            text_box = None

        predictions = region_box_candidates(item.get("region"), width, height)
        if text_box is not None:
            pass
        elif predictions:
            match = choose_detected_box(
                predictions,
                candidates,
                bubbles,
                used,
                item,
                width,
                height,
                recognized,
            )
            if match is None:
                if item["container_type"] != "sound_effect":
                    continue
                pool = [
                    candidate
                    for candidate in effect_order
                    if candidates.index(candidate) not in used
                    and box_area(candidate) / max(1, width * height) <= 0.022
                ]
                if not pool:
                    continue
                text_box = pool[0]
                used.add(candidates.index(text_box))
                scale_name = "reading_order"
                recognized_text = recognized.get(tuple(text_box), "")
                content_score = ocr_similarity(item["source_text"], recognized_text)
                origin = "ocr_effect_reading_order"
            else:
                text_box, scale_name, recognized_text, content_score = match
                origin = f"ocr_{scale_name}+local"
        elif ordered:
            dialogue_like = item["container_type"] in ("speech", "caption", "narration") and len(item["source_text"].strip()) >= 5
            pool = [
                candidate
                for candidate in ordered
                if candidates.index(candidate) not in used
                and ((choose_bubble(candidate, bubbles) is not None) == dialogue_like)
            ]
            if not pool:
                pool = [candidate for candidate in ordered if candidates.index(candidate) not in used]
            if not pool:
                continue
            text_box = pool[0]
            used.add(candidates.index(text_box))
            recognized_text = recognized.get(tuple(text_box), "")
            content_score = ocr_similarity(item["source_text"], recognized_text)
            origin = "legacy_local_order"
        else:
            continue

        if (
            item["container_type"] == "sound_effect"
            and item.get("region_verified") is not True
            and box_area(text_box) / max(1, width * height) > 0.022
        ):
            continue

        bubble = choose_bubble(text_box, bubbles)
        text_width = max(1, text_box[2] - text_box[0])
        text_height = max(1, text_box[3] - text_box[1])
        container_type = item["container_type"]
        use_bubble = bubble is not None and container_type in ("speech", "caption", "narration", "other")

        if use_bubble:
            bubble_width = max(1, bubble[2] - bubble[0])
            bubble_height = max(1, bubble[3] - bubble[1])
            inset_x = max(5, round(bubble_width * 0.055))
            inset_y = max(5, round(bubble_height * 0.055))
            bubble_inner = clamp_box(
                [bubble[0] + inset_x, bubble[1] + inset_y, bubble[2] - inset_x, bubble[3] - inset_y],
                width,
                height,
            )
            expanded_text = expand_box(
                text_box,
                max(12, round(bubble_width * 0.18)),
                max(10, round(bubble_height * 0.12)),
                width,
                height,
            )
            edit_box = [
                max(bubble_inner[0], expanded_text[0]),
                max(bubble_inner[1], expanded_text[1]),
                min(bubble_inner[2], expanded_text[2]),
                min(bubble_inner[3], expanded_text[3]),
            ]
            edit_box = clamp_box(edit_box, width, height)
            context_base = bubble
        else:
            edit_box = expand_box(
                text_box,
                max(10, round(text_width * 0.22)),
                max(10, round(text_height * 0.22)),
                width,
                height,
            )
            context_base = edit_box

        context_width = context_base[2] - context_base[0]
        context_height = context_base[3] - context_base[1]
        crop_box = expand_box(
            context_base,
            max(36, round(context_width * 0.28)),
            max(36, round(context_height * 0.28)),
            width,
            height,
        )
        crop_box = union_box(crop_box, edit_box, width, height)
        regions.append(
            {
                **item,
                "source_text_box": text_box,
                "bubble_box": bubble,
                "edit_box": edit_box,
                "crop_box": crop_box,
                "region_origin": origin,
                "recognized_source_text": recognized_text,
                "source_match_score": round(float(content_score), 4),
            }
        )
    return regions


def build_source_erase_mask(crop, source_text_box, crop_box, has_bubble):
    crop_height, crop_width = crop.shape[:2]
    x1 = int(clamp(source_text_box[0] - crop_box[0], 0, crop_width - 1))
    y1 = int(clamp(source_text_box[1] - crop_box[1], 0, crop_height - 1))
    x2 = int(clamp(source_text_box[2] - crop_box[0], x1 + 1, crop_width))
    y2 = int(clamp(source_text_box[3] - crop_box[1], y1 + 1, crop_height))
    roi = crop[y1:y2, x1:x2]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)

    if has_bubble:
        _threshold, core = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        core[gray > 205] = 0
    else:
        smooth = cv2.GaussianBlur(roi, (0, 0), 4.5)
        detail = np.max(cv2.absdiff(roi, smooth), axis=2)
        saturation = hsv[:, :, 1]
        value = hsv[:, :, 2]
        dark_ink = gray < 82
        colored_ink = (saturation > 72) & (detail > 13)
        outlined_ink = (detail > 22) & (value < 242)
        core = ((dark_ink | colored_ink | outlined_ink).astype(np.uint8) * 255)

    count, labels, stats, _centroids = cv2.connectedComponentsWithStats(core, 8)
    filtered = np.zeros_like(core)
    roi_area = max(1, core.shape[0] * core.shape[1])
    for component in range(1, count):
        left, top, comp_width, comp_height, area = stats[component]
        if area < 3 or area > roi_area * 0.58:
            continue
        touches_edge = left <= 0 or top <= 0 or left + comp_width >= core.shape[1] or top + comp_height >= core.shape[0]
        if touches_edge and area > roi_area * 0.08:
            continue
        filtered[labels == component] = 255

    radius = max(1, min(4, round(min(roi.shape[:2]) * 0.018)))
    filtered = cv2.dilate(filtered, np.ones((radius * 2 + 1, radius * 2 + 1), np.uint8), iterations=1)
    local_mask = np.zeros((crop_height, crop_width), dtype=np.uint8)
    local_mask[y1:y2, x1:x2] = filtered

    bright_neutral = (gray >= 205) & (hsv[:, :, 1] <= 45)
    preserve_light_container = bool(np.count_nonzero(bright_neutral) / max(1, bright_neutral.size) >= 0.22)
    return local_mask, preserve_light_container


def find_font(bold=False):
    windows_fonts = Path("C:/Windows/Fonts")
    candidates = [
        windows_fonts / ("malgunbd.ttf" if bold else "malgun.ttf"),
        windows_fonts / "malgun.ttf",
        windows_fonts / "arial.ttf",
    ]
    for path in candidates:
        if path.exists():
            return str(path)
    return None


def wrap_text(draw, text, font, max_width):
    paragraphs = text.split("\n")
    lines = []
    for paragraph in paragraphs:
        paragraph = paragraph.strip()
        if not paragraph:
            lines.append("")
            continue
        current = ""
        for char in paragraph:
            candidate = current + char
            if current and draw.textlength(candidate, font=font) > max_width:
                lines.append(current)
                current = char
            else:
                current = candidate
        if current:
            lines.append(current)
    return lines


def fit_text(draw, text, rect, bold=False):
    x1, y1, x2, y2 = rect
    width = max(8, x2 - x1 - 10)
    height = max(8, y2 - y1 - 8)
    font_path = find_font(bold)
    max_size = max(12, min(92, round(min(height * 0.48, width * 0.30))))
    for size in range(max_size, 9, -1):
        font = ImageFont.truetype(font_path, size) if font_path else ImageFont.load_default()
        lines = wrap_text(draw, text, font, width)
        line_height = max(1, round(size * 1.18))
        if lines and line_height * len(lines) <= height:
            return font, lines, line_height
    font = ImageFont.truetype(font_path, 10) if font_path else ImageFont.load_default()
    return font, wrap_text(draw, text, font, width), 12


def draw_centered_text(draw, text, rect, bold=False, fill=(25, 25, 25)):
    font, lines, line_height = fit_text(draw, text, rect, bold=bold)
    x1, y1, x2, y2 = rect
    total_height = line_height * len(lines)
    y = y1 + max(0, (y2 - y1 - total_height) // 2)
    for line in lines:
        line_width = draw.textlength(line, font=font)
        x = x1 + max(0, (x2 - x1 - line_width) / 2)
        draw.text((x, y), line, font=font, fill=fill, stroke_width=0)
        y += line_height


def atlas_grid(count):
    columns = max(1, math.ceil(math.sqrt(count)))
    rows = max(1, math.ceil(count / columns))
    return columns, rows


def build_localization_candidates(args):
    image_path = Path(args.image)
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not read source image: {image_path}")
    height, width = image.shape[:2]
    _bubbles, detector_text, detector_effects = detect_comic_regions(image, Path(args.model))
    easy_boxes = detect_easyocr_boxes(image_path, width, height)
    contrast_effects = detect_contrast_effect_boxes(image)

    proposals = []
    seen = []

    def add_candidates(boxes, kind, prefix):
        for box in boxes:
            if box_area(box) < 24:
                continue
            duplicate = next(
                (
                    existing
                    for existing in seen
                    if box_iou(box, existing) >= 0.92
                    or (
                        overlap_fraction(box, existing) >= 0.96
                        and overlap_fraction(existing, box) >= 0.80
                    )
                ),
                None,
            )
            if duplicate is not None:
                continue
            clean_box = list(box)
            seen.append(clean_box)
            proposals.append(
                {
                    "id": f"{prefix}{len(proposals) + 1:02d}",
                    "kind": kind,
                    "box": clean_box,
                }
            )

    # Detector geometry is the preferred source. EasyOCR contributes extra
    # line-level proposals, but its recognized text is never trusted here.
    add_candidates(detector_text, "text", "C")
    add_candidates(detector_effects, "effect", "C")
    add_candidates(easy_boxes, "ocr_geometry", "C")
    add_candidates(contrast_effects, "contrast_effect", "C")
    if not proposals:
        raise RuntimeError("No localization candidates were detected.")

    columns, rows = atlas_grid(len(proposals))
    sheet = np.full((ATLAS_SIZE, ATLAS_SIZE, 3), 247, dtype=np.uint8)
    usable_width = ATLAS_SIZE - ATLAS_MARGIN * 2 - ATLAS_GUTTER * (columns - 1)
    usable_height = ATLAS_SIZE - ATLAS_MARGIN * 2 - ATLAS_GUTTER * (rows - 1)
    tile_width = usable_width // columns
    tile_height = usable_height // rows

    for index, proposal in enumerate(proposals):
        row = index // columns
        column = index % columns
        tile_x = ATLAS_MARGIN + column * (tile_width + ATLAS_GUTTER)
        tile_y = ATLAS_MARGIN + row * (tile_height + ATLAS_GUTTER)
        box = proposal["box"]
        box_width = max(1, box[2] - box[0])
        box_height = max(1, box[3] - box[1])
        context_box = expand_box(
            box,
            max(28, round(box_width * 0.55)),
            max(28, round(box_height * 0.55)),
            width,
            height,
        )
        crop = image[context_box[1] : context_box[3], context_box[0] : context_box[2]]
        cv2.rectangle(sheet, (tile_x, tile_y), (tile_x + tile_width, tile_y + tile_height), (105, 105, 105), 2)
        cv2.rectangle(sheet, (tile_x + 2, tile_y + 2), (tile_x + tile_width - 2, tile_y + TILE_HEADER), (238, 246, 255), -1)
        cv2.putText(
            sheet,
            f"{proposal['id']} {proposal['kind']}",
            (tile_x + 8, tile_y + 24),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.54,
            (125, 55, 15),
            2,
            cv2.LINE_AA,
        )
        max_width = tile_width - 12
        max_height = tile_height - TILE_HEADER - 10
        scale = min(max_width / crop.shape[1], max_height / crop.shape[0])
        rendered_width = max(1, int(round(crop.shape[1] * scale)))
        rendered_height = max(1, int(round(crop.shape[0] * scale)))
        rendered_x = tile_x + (tile_width - rendered_width) // 2
        rendered_y = tile_y + TILE_HEADER + (max_height - rendered_height) // 2
        rendered = cv2.resize(crop, (rendered_width, rendered_height), interpolation=cv2.INTER_LANCZOS4)
        sheet[rendered_y : rendered_y + rendered_height, rendered_x : rendered_x + rendered_width] = rendered
        rect = map_source_box_to_atlas(box, context_box, [rendered_x, rendered_y, rendered_width, rendered_height])
        cv2.rectangle(sheet, (rect[0], rect[1]), (rect[2], rect[3]), (35, 35, 235), 3)
        proposal["context_box"] = context_box

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    sheet_path = output_dir / "localization-candidates.png"
    metadata_path = output_dir / "localization-candidates.json"
    cv2.imwrite(str(sheet_path), sheet)
    metadata = {
        "version": 1,
        "source_size": [width, height],
        "candidate_count": len(proposals),
        "candidates": proposals,
    }
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                "sheet": str(sheet_path),
                "metadata": str(metadata_path),
                "candidate_count": len(proposals),
            },
            ensure_ascii=False,
        )
    )


def map_source_box_to_atlas(box, crop_box, content_rect):
    cx1, cy1, cx2, cy2 = crop_box
    ax, ay, aw, ah = content_rect
    scale_x = aw / max(1, cx2 - cx1)
    scale_y = ah / max(1, cy2 - cy1)
    return [
        int(round(ax + (box[0] - cx1) * scale_x)),
        int(round(ay + (box[1] - cy1) * scale_y)),
        int(round(ax + (box[2] - cx1) * scale_x)),
        int(round(ay + (box[3] - cy1) * scale_y)),
    ]


def build_atlas(args):
    image_path = Path(args.image)
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not read source image: {image_path}")
    height, width = image.shape[:2]
    data = json.loads(Path(args.translations).read_text(encoding="utf-8"))
    items = translation_items(data)
    if not items:
        raise RuntimeError("No translated text blocks were found.")

    bubbles, detector_text, detector_effects = detect_comic_regions(image, Path(args.model))
    easy_boxes = detect_easyocr_boxes(image_path, width, height)
    candidate_boxes = [
        box
        for box, _score in deduplicate_boxes(
            [(box, 1.0) for box in detector_text]
            + [(box, 0.86) for box in detector_effects]
            + [(box, 0.7) for box in easy_boxes],
            iou_threshold=0.72,
            containment_threshold=0.88,
        )
    ]
    recognized, recognition_engine = recognize_candidate_texts(
        image_path,
        candidate_boxes,
        width,
        height,
        args.preset == "manga_jp" and any(item.get("region_verified") is None for item in items),
    )
    regions = build_regions(
        items,
        detector_text,
        detector_effects,
        bubbles,
        easy_boxes,
        width,
        height,
        args.preset,
        recognized,
    )
    if not regions:
        raise RuntimeError("No usable text regions were detected for the patch atlas.")

    columns, rows = atlas_grid(len(regions))
    usable_width = ATLAS_SIZE - ATLAS_MARGIN * 2 - ATLAS_GUTTER * (columns - 1)
    usable_height = ATLAS_SIZE - ATLAS_MARGIN * 2 - ATLAS_GUTTER * (rows - 1)
    tile_width = usable_width // columns
    tile_height = usable_height // rows
    atlas = np.full((ATLAS_SIZE, ATLAS_SIZE, 3), 246, dtype=np.uint8)
    mask = np.full((ATLAS_SIZE, ATLAS_SIZE, 4), 255, dtype=np.uint8)
    erase_mask = np.zeros((ATLAS_SIZE, ATLAS_SIZE), dtype=np.uint8)

    metadata_tiles = []
    for index, region in enumerate(regions):
        row = index // columns
        column = index % columns
        tile_x = ATLAS_MARGIN + column * (tile_width + ATLAS_GUTTER)
        tile_y = ATLAS_MARGIN + row * (tile_height + ATLAS_GUTTER)
        cv2.rectangle(atlas, (tile_x, tile_y), (tile_x + tile_width, tile_y + tile_height), (90, 90, 90), 2)
        cv2.rectangle(atlas, (tile_x + 2, tile_y + 2), (tile_x + tile_width - 2, tile_y + TILE_HEADER), (235, 246, 255), -1)
        cv2.putText(
            atlas,
            region["id"],
            (tile_x + 10, tile_y + 25),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.68,
            (130, 70, 20),
            2,
            cv2.LINE_AA,
        )

        crop_box = region["crop_box"]
        crop = image[crop_box[1] : crop_box[3], crop_box[0] : crop_box[2]]
        source_erase_mask, preserve_light_container = build_source_erase_mask(
            crop,
            region["source_text_box"],
            crop_box,
            region["bubble_box"] is not None,
        )
        cleaned_crop = cv2.inpaint(crop, source_erase_mask, 3, cv2.INPAINT_TELEA)
        if region["bubble_box"] is not None:
            clear_box = expand_box(region["bubble_box"], 10, 10, width, height)
        else:
            edit_width = region["edit_box"][2] - region["edit_box"][0]
            edit_height = region["edit_box"][3] - region["edit_box"][1]
            clear_box = expand_box(
                region["edit_box"],
                max(16, round(edit_width * 0.12)),
                max(16, round(edit_height * 0.12)),
                width,
                height,
            )
        clear_box = [
            max(crop_box[0], clear_box[0]),
            max(crop_box[1], clear_box[1]),
            min(crop_box[2], clear_box[2]),
            min(crop_box[3], clear_box[3]),
        ]
        local_clear = [
            clear_box[0] - crop_box[0],
            clear_box[1] - crop_box[1],
            clear_box[2] - crop_box[0],
            clear_box[3] - crop_box[1],
        ]
        model_crop = np.full_like(crop, 238)
        model_crop[local_clear[1] : local_clear[3], local_clear[0] : local_clear[2]] = cleaned_crop[
            local_clear[1] : local_clear[3], local_clear[0] : local_clear[2]
        ]
        content_max_width = tile_width - 12
        content_max_height = tile_height - TILE_HEADER - 10
        scale = min(content_max_width / crop.shape[1], content_max_height / crop.shape[0])
        content_width = max(1, int(round(crop.shape[1] * scale)))
        content_height = max(1, int(round(crop.shape[0] * scale)))
        content_x = tile_x + (tile_width - content_width) // 2
        content_y = tile_y + TILE_HEADER + (content_max_height - content_height) // 2
        resized = cv2.resize(model_crop, (content_width, content_height), interpolation=cv2.INTER_LANCZOS4)
        atlas[content_y : content_y + content_height, content_x : content_x + content_width] = resized
        resized_erase_mask = cv2.resize(
            source_erase_mask,
            (content_width, content_height),
            interpolation=cv2.INTER_NEAREST,
        )
        erase_mask[
            content_y : content_y + content_height,
            content_x : content_x + content_width,
        ] = np.maximum(
            erase_mask[content_y : content_y + content_height, content_x : content_x + content_width],
            resized_erase_mask,
        )

        content_rect = [content_x, content_y, content_width, content_height]
        atlas_edit_box = map_source_box_to_atlas(region["edit_box"], crop_box, content_rect)
        atlas_text_box = map_source_box_to_atlas(region["source_text_box"], crop_box, content_rect)
        cv2.rectangle(
            mask,
            (atlas_edit_box[0], atlas_edit_box[1]),
            (atlas_edit_box[2], atlas_edit_box[3]),
            (255, 255, 255, 0),
            -1,
        )
        metadata_tiles.append(
            {
                **region,
                "clear_context_box": clear_box,
                "atlas_tile": [tile_x, tile_y, tile_width, tile_height],
                "atlas_content": content_rect,
                "atlas_edit_box": atlas_edit_box,
                "atlas_source_text_box": atlas_text_box,
                "preserve_light_container": preserve_light_container,
            }
        )

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    atlas_path = output_dir / "atlas.png"
    mask_path = output_dir / "mask.png"
    erase_mask_path = output_dir / "erase-mask.png"
    guide_path = output_dir / "guide.png"
    metadata_path = output_dir / "metadata.json"
    cv2.imwrite(str(atlas_path), atlas)
    cv2.imwrite(str(mask_path), mask)
    cv2.imwrite(str(erase_mask_path), erase_mask)

    guide_rgb = cv2.addWeighted(atlas, 0.22, np.full_like(atlas, 255), 0.78, 0)
    guide_image = Image.fromarray(cv2.cvtColor(guide_rgb, cv2.COLOR_BGR2RGB))
    guide_draw = ImageDraw.Draw(guide_image)
    for tile in metadata_tiles:
        rect = tile["atlas_edit_box"]
        guide_draw.rectangle(rect, outline=(225, 40, 120), width=3)
        draw_centered_text(
            guide_draw,
            tile["target_text"],
            rect,
            bold=tile["container_type"] == "sound_effect",
            fill=(20, 20, 20),
        )
    guide_image.save(guide_path, format="PNG")

    metadata = {
        "version": 1,
        "atlas_size": [ATLAS_SIZE, ATLAS_SIZE],
        "source_size": [width, height],
        "preset": args.preset,
        "detector": {
            "model": str(args.model),
            "bubble_count": len(bubbles),
            "text_count": len(detector_text),
            "effect_count": len(detector_effects),
            "easyocr_fallback_count": len(easy_boxes),
            "recognition_engine": recognition_engine,
        },
        "tiles": metadata_tiles,
    }
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        json.dumps(
            {
                "atlas": str(atlas_path),
                "mask": str(mask_path),
                "erase_mask": str(erase_mask_path),
                "guide": str(guide_path),
                "metadata": str(metadata_path),
                "tile_count": len(metadata_tiles),
                "detector_text_count": len(detector_text),
                "detector_effect_count": len(detector_effects),
                "detector_bubble_count": len(bubbles),
                "easyocr_fallback_count": len(easy_boxes),
                "rejected_region_count": len(items) - len(metadata_tiles),
            },
            ensure_ascii=False,
        )
    )


def local_color_correct(original, generated, edit_mask):
    guard = cv2.bitwise_not(edit_mask)
    guard = cv2.erode(guard, np.ones((5, 5), np.uint8), iterations=1)
    difference = cv2.absdiff(original, generated)
    stable = (np.max(difference, axis=2) < 48).astype(np.uint8) * 255
    sample_mask = cv2.bitwise_and(guard, stable)
    if cv2.countNonZero(sample_mask) < 64:
        return generated, [0, 0, 0]
    offsets = []
    corrected = generated.astype(np.int16)
    for channel in range(3):
        delta = original[:, :, channel].astype(np.int16) - generated[:, :, channel].astype(np.int16)
        offset = int(np.clip(np.median(delta[sample_mask > 0]), -14, 14))
        offsets.append(offset)
        corrected[:, :, channel] += offset
    return np.clip(corrected, 0, 255).astype(np.uint8), offsets


def composite_atlas(args):
    source = cv2.imread(str(args.image), cv2.IMREAD_COLOR)
    atlas_input = cv2.imread(str(args.atlas_input), cv2.IMREAD_COLOR)
    generated = cv2.imread(str(args.generated), cv2.IMREAD_COLOR)
    atlas_erase_mask = cv2.imread(str(args.erase_mask), cv2.IMREAD_GRAYSCALE)
    metadata = json.loads(Path(args.metadata).read_text(encoding="utf-8"))
    if source is None or atlas_input is None or generated is None or atlas_erase_mask is None:
        raise RuntimeError("Could not read source, input atlas, erase mask, or generated atlas image.")
    atlas_width, atlas_height = metadata["atlas_size"]
    if atlas_input.shape[1] != atlas_width or atlas_input.shape[0] != atlas_height:
        raise RuntimeError("Input atlas dimensions do not match its metadata.")
    if generated.shape[1] != atlas_width or generated.shape[0] != atlas_height:
        generated = cv2.resize(generated, (atlas_width, atlas_height), interpolation=cv2.INTER_LANCZOS4)

    output = source.copy()
    total_changed = 0
    tile_stats = []
    for tile in metadata["tiles"]:
        sx1, sy1, sx2, sy2 = tile["crop_box"]
        ax, ay, aw, ah = tile["atlas_content"]
        baseline_tile = atlas_input[ay : ay + ah, ax : ax + aw]
        generated_tile = generated[ay : ay + ah, ax : ax + aw]
        crop_width = sx2 - sx1
        crop_height = sy2 - sy1
        generated_patch = cv2.resize(generated_tile, (crop_width, crop_height), interpolation=cv2.INTER_LANCZOS4)
        original_patch = source[sy1:sy2, sx1:sx2]
        erase_tile = atlas_erase_mask[ay : ay + ah, ax : ax + aw]
        erase_patch = cv2.resize(erase_tile, (crop_width, crop_height), interpolation=cv2.INTER_NEAREST)

        # Detect only edits introduced by the model. Comparing against the full-size
        # source here would mistake the atlas down/up-sampling itself for an edit.
        atlas_delta = np.max(cv2.absdiff(baseline_tile, generated_tile), axis=2)
        atlas_change_mask = ((atlas_delta >= 24).astype(np.uint8) * 255)
        change_mask = cv2.resize(
            atlas_change_mask,
            (crop_width, crop_height),
            interpolation=cv2.INTER_NEAREST,
        )

        edit = tile["edit_box"]
        ex1 = int(clamp(edit[0] - sx1, 0, crop_width - 1))
        ey1 = int(clamp(edit[1] - sy1, 0, crop_height - 1))
        ex2 = int(clamp(edit[2] - sx1, ex1 + 1, crop_width))
        ey2 = int(clamp(edit[3] - sy1, ey1 + 1, crop_height))
        allowed = np.zeros((crop_height, crop_width), dtype=np.uint8)
        cv2.rectangle(allowed, (ex1, ey1), (ex2, ey2), 255, -1)

        corrected_patch, offsets = local_color_correct(original_patch, generated_patch, allowed)
        change_mask = cv2.bitwise_and(change_mask, allowed)
        change_mask = cv2.morphologyEx(change_mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        change_mask = cv2.dilate(change_mask, np.ones((3, 3), np.uint8), iterations=1)
        change_mask = cv2.bitwise_and(change_mask, allowed)
        erase_patch = cv2.bitwise_and(erase_patch, allowed)

        if tile.get("preserve_light_container"):
            generated_hsv = cv2.cvtColor(corrected_patch, cv2.COLOR_BGR2HSV)
            generated_gray = cv2.cvtColor(corrected_patch, cv2.COLOR_BGR2GRAY)
            foreground_core = (
                ((generated_gray < 188) | (generated_hsv[:, :, 1] > 58)).astype(np.uint8) * 255
            )
            foreground_guard = cv2.dilate(foreground_core, np.ones((7, 7), np.uint8), iterations=1)
            change_mask = cv2.bitwise_and(change_mask, foreground_guard)

        changed = cv2.countNonZero(change_mask)
        allowed_pixels = max(1, cv2.countNonZero(allowed))
        changed_fraction = changed / allowed_pixels
        rejected_reason = None
        if changed_fraction > 0.55:
            change_mask[:] = 0
            changed = 0
            rejected_reason = "excessive_area_change"
        if changed:
            region = output[sy1:sy2, sx1:sx2]
            erased = cv2.countNonZero(erase_patch)
            if erased:
                cleaned_original = cv2.inpaint(original_patch, erase_patch, 3, cv2.INPAINT_TELEA)
                region[erase_patch > 0] = cleaned_original[erase_patch > 0]
            region[change_mask > 0] = corrected_patch[change_mask > 0]
            output[sy1:sy2, sx1:sx2] = region
        else:
            erased = 0
        total_changed += changed
        tile_stats.append(
            {
                "id": tile["id"],
                "changed_pixels": int(changed),
                "erased_source_pixels": int(erased),
                "changed_fraction": round(changed_fraction, 4),
                "color_offset_bgr": offsets,
                "rejected_reason": rejected_reason,
            }
        )

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output_path), output, [cv2.IMWRITE_PNG_COMPRESSION, 3])
    print(
        json.dumps(
            {
                "output": str(output_path),
                "changed_pixels": int(total_changed),
                "tiles": tile_stats,
            },
            ensure_ascii=False,
        )
    )


def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    build = subparsers.add_parser("build")
    build.add_argument("--image", required=True)
    build.add_argument("--translations", required=True)
    build.add_argument("--model", required=True)
    build.add_argument("--preset", default="comic")
    build.add_argument("--output-dir", required=True)

    candidates = subparsers.add_parser("candidates")
    candidates.add_argument("--image", required=True)
    candidates.add_argument("--model", required=True)
    candidates.add_argument("--output-dir", required=True)

    composite = subparsers.add_parser("composite")
    composite.add_argument("--image", required=True)
    composite.add_argument("--atlas-input", required=True)
    composite.add_argument("--erase-mask", required=True)
    composite.add_argument("--generated", required=True)
    composite.add_argument("--metadata", required=True)
    composite.add_argument("--output", required=True)

    args = parser.parse_args()
    if args.command == "build":
        build_atlas(args)
    elif args.command == "candidates":
        build_localization_candidates(args)
    else:
        composite_atlas(args)


if __name__ == "__main__":
    main()
