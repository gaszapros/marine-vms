"""Детектор движения по скользящему фону. Возвращает бинарную маску."""

from __future__ import annotations

import cv2
import numpy as np


class MotionDetector:
    def __init__(self, learning: float = 0.08, threshold: int = 28) -> None:
        self.learning = learning
        self.threshold = threshold
        self.avg: np.ndarray | None = None

    def reset(self) -> None:
        self.avg = None

    def feed(self, frame: np.ndarray) -> np.ndarray:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (7, 7), 0)
        if self.avg is None:
            self.avg = gray.astype(np.float32)
            return np.zeros_like(gray)
        cv2.accumulateWeighted(gray, self.avg, self.learning)
        delta = cv2.absdiff(gray, cv2.convertScaleAbs(self.avg))
        _, mask = cv2.threshold(delta, self.threshold, 255, cv2.THRESH_BINARY)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        return mask


# Доля кадра: кузов на перекрёстке, а не стоп-сигнал и не светофор.
_MIN_VEHICLE_AREA = 0.0018


def moving_color_mask(frame: np.ndarray, motion: np.ndarray, color: str = "red") -> np.ndarray:
    """Красные пиксели, которые ещё и движутся, и крупнее огня фары."""
    height, width = frame.shape[:2]
    empty = np.zeros((height, width), np.uint8)
    if color != "red" or motion.size == 0:
        return empty
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    red = cv2.bitwise_or(
        cv2.inRange(hsv, (0, 60, 45), (12, 255, 255)),
        cv2.inRange(hsv, (168, 60, 45), (180, 255, 255)),
    )
    red = cv2.morphologyEx(red, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    red = cv2.morphologyEx(red, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    gate = cv2.dilate(motion, np.ones((9, 9), np.uint8))
    red = cv2.bitwise_and(red, gate)
    contours, _ = cv2.findContours(red, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    kept = empty
    min_area = _MIN_VEHICLE_AREA * height * width
    for contour in contours:
        if cv2.contourArea(contour) < min_area:
            continue
        _, _, box_w, box_h = cv2.boundingRect(contour)
        if box_w < 14 or box_h < 10:
            continue
        cv2.drawContours(kept, [contour], -1, 255, -1)
    return kept
