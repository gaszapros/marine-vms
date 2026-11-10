"""Надпечатка на кадр. Системный шрифт Windows умеет кириллицу."""

from __future__ import annotations

from functools import lru_cache

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont


@lru_cache(maxsize=4)
def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in (
        r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\arial.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def mark_boxes(frame: np.ndarray, boxes: list[tuple[int, int, int, int, str]]) -> np.ndarray:
    if not boxes:
        return frame
    img = frame
    for x, y, width, height, _label in boxes:
        cv2.rectangle(img, (x, y), (x + width, y + height), (32, 32, 230), 2)
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    pil = Image.fromarray(rgb)
    draw = ImageDraw.Draw(pil)
    font = _font(15)
    for x, y, _width, _height, label in boxes:
        text_w = int(draw.textlength(label, font=font))
        top = max(0, y - 18)
        draw.rectangle((x, top, x + text_w + 8, top + 18), fill=(210, 36, 36))
        draw.text((x + 4, top), label, font=font, fill=(255, 255, 255))
    return cv2.cvtColor(np.array(pil.convert("RGB")), cv2.COLOR_RGB2BGR)


def paint(frame: np.ndarray, lines: list[str], recording: bool) -> np.ndarray:
    img = frame.copy()
    height, width = img.shape[:2]
    if recording:
        cv2.rectangle(img, (0, 0), (width - 1, height - 1), (40, 40, 220), 4)
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    pil = Image.fromarray(rgb)
    draw = ImageDraw.Draw(pil, "RGBA")
    font = _font(16)
    bar_h = 10 + 20 * max(1, len(lines))
    draw.rectangle((0, 0, width, bar_h), fill=(8, 14, 22, 190))
    y = 6
    for line in lines:
        fill = (255, 96, 88) if recording and line.startswith("REC") else (236, 224, 196)
        draw.text((10, y), line, font=font, fill=fill)
        y += 20
    return cv2.cvtColor(np.array(pil.convert("RGB")), cv2.COLOR_RGB2BGR)
