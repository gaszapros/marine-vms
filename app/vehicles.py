"""Показ автобусов и грузовиков. Легковые не выделяются, запись не начинается."""

from __future__ import annotations

import logging
import threading
import urllib.request
from pathlib import Path

import cv2
import numpy as np

from app.config import ROOT

logger = logging.getLogger("marine")

MODEL_PATH = ROOT / "models" / "yolox.onnx"
MODEL_URL = (
    "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/"
    "models/object_detection_yolox/object_detection_yolox_2022nov.onnx"
)

# COCO: car=2 легковой (не рисуем), bus=5, truck=7.
HEAVY = {5: "автобус", 7: "грузовик"}
INPUT = 640
STRIDES = (8, 16, 32)
CONFIDENCE = 0.45
NMS = 0.5


def _anchors() -> tuple[np.ndarray, np.ndarray]:
    grids = []
    expanded = []
    for stride in STRIDES:
        size = INPUT // stride
        xv, yv = np.meshgrid(np.arange(size), np.arange(size))
        grid = np.stack((xv, yv), 2).reshape(1, -1, 2)
        grids.append(grid)
        expanded.append(np.full((1, grid.shape[1], 1), stride))
    return np.concatenate(grids, 1), np.concatenate(expanded, 1)


def _letterbox(rgb: np.ndarray) -> tuple[np.ndarray, float]:
    height, width = rgb.shape[:2]
    padded = np.full((INPUT, INPUT, 3), 114.0, np.float32)
    ratio = min(INPUT / height, INPUT / width)
    resized = cv2.resize(rgb, (int(width * ratio), int(height * ratio))).astype(np.float32)
    padded[: resized.shape[0], : resized.shape[1]] = resized
    return padded, ratio


def keep_heavy(candidates: np.ndarray, frame_shape: tuple[int, int], ratio: float) -> list[tuple[int, int, int, int, str]]:
    """Оставляет автобус и грузовик. candidates: x, y, w, h, score, class в координатах letterbox."""
    height, width = frame_shape
    marks: list[tuple[int, int, int, int, str]] = []
    if candidates.size == 0:
        return marks
    for row in candidates:
        label = HEAVY.get(int(row[5]))
        if label is None or float(row[4]) < CONFIDENCE:
            continue
        x = int(round(float(row[0]) / ratio))
        y = int(round(float(row[1]) / ratio))
        box_w = int(round(float(row[2]) / ratio))
        box_h = int(round(float(row[3]) / ratio))
        if box_w < 16 or box_h < 14:
            continue
        if box_w > width * 0.92 and box_h > height * 0.92:
            continue
        x = min(width - 1, max(0, x))
        y = min(height - 1, max(0, y))
        box_w = min(width - x, box_w)
        box_h = min(height - y, box_h)
        if box_w < 16 or box_h < 14:
            continue
        marks.append((x, y, box_w, box_h, label))
    return marks


class HeavyFinder:
    def __init__(self, path: Path = MODEL_PATH) -> None:
        self.path = path
        self.net: cv2.dnn.Net | None = None
        self.ready = False
        self.failed = False
        self._lock = threading.Lock()
        self._grids, self._strides = _anchors()

    def _load(self) -> None:
        if self.ready or self.failed:
            return
        if not self.path.is_file() or self.path.stat().st_size < 1_000_000:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            try:
                urllib.request.urlretrieve(MODEL_URL, self.path)
            except OSError:
                logger.exception("модель распознавания не скачалась")
                self.failed = True
                return
        try:
            self.net = cv2.dnn.readNet(str(self.path))
            self.ready = True
        except cv2.error:
            logger.exception("модель распознавания не открылась")
            self.failed = True

    def find(self, frame_bgr: np.ndarray) -> list[tuple[int, int, int, int, str]]:
        with self._lock:
            self._load()
            if self.net is None:
                return []
            rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
            padded, ratio = _letterbox(rgb)
            blob = np.transpose(padded, (2, 0, 1))[np.newaxis, :, :, :]
            self.net.setInput(blob)
            outputs = self.net.forward(self.net.getUnconnectedOutLayersNames())
            return self._decode(outputs[0], frame_bgr.shape[:2], ratio)

    def _decode(self, outputs: np.ndarray, frame_shape: tuple[int, int], ratio: float) -> list[tuple[int, int, int, int, str]]:
        dets = np.asarray(outputs[0], dtype=np.float32)
        if dets.ndim != 2 or dets.shape[1] < 6:
            return []
        dets = dets.copy()
        dets[:, :2] = (dets[:, :2] + self._grids[0]) * self._strides[0]
        dets[:, 2:4] = np.exp(dets[:, 2:4]) * self._strides[0]
        boxes = np.empty_like(dets[:, :4])
        boxes[:, 0] = dets[:, 0] - dets[:, 2] / 2.0
        boxes[:, 1] = dets[:, 1] - dets[:, 3] / 2.0
        boxes[:, 2] = dets[:, 2]
        boxes[:, 3] = dets[:, 3]
        scores = dets[:, 4:5] * dets[:, 5:]
        best = np.argmax(scores, axis=1)
        confidence = scores[np.arange(scores.shape[0]), best]
        wanted = np.isin(best, list(HEAVY)) & (confidence >= CONFIDENCE)
        if not np.any(wanted):
            return []
        boxes = boxes[wanted]
        confidence = confidence[wanted]
        best = best[wanted]
        keep = cv2.dnn.NMSBoxes(boxes.tolist(), confidence.tolist(), CONFIDENCE, NMS)
        if keep is None or len(keep) == 0:
            return []
        chosen = np.asarray(keep).reshape(-1)
        packed = np.concatenate(
            [boxes[chosen], confidence[chosen, None], best[chosen, None].astype(np.float32)],
            axis=1,
        )
        return keep_heavy(packed, frame_shape, ratio)


finder = HeavyFinder()
