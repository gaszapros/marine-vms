"""Грузовой транспорт: фура и грузовик. Легковые и автобусы не считаются."""

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

# COCO: car=2 легковой, bus=5 автобус, truck=7 грузовой.
CAR = 2
BUS = 5
TRUCK = 7
INPUT = 640
STRIDES = (8, 16, 32)
NMS = 0.5

# Высота и ширина легковой на дальней и ближней кромке дороги, доля кадра.
# Грузовой — заметно крупнее этой линии либо уверенно отмечен как грузовик.
FORMULAS = {
    "cuomo": {"y0": 0.45, "y1": 0.98, "carH0": 0.024, "carH1": 0.058, "carW0": 0.018, "carW1": 0.038, "mul": 1.65, "mild": 1.15, "score": 0.18},
    "i66": {"y0": 0.12, "y1": 0.98, "carH0": 0.02, "carH1": 0.11, "carW0": 0.015, "carW1": 0.09, "mul": 1.6, "mild": 1.2, "score": 0.2},
    "i66-61": {"y0": 0.28, "y1": 0.98, "carH0": 0.02, "carH1": 0.07, "carW0": 0.016, "carW1": 0.045, "mul": 1.55, "mild": 1.2, "score": 0.2},
    "i10": {"y0": 0.18, "y1": 0.58, "carH0": 0.04, "carH1": 0.055, "carW0": 0.045, "carW1": 0.065, "mul": 1.4, "mild": 1.15, "score": 0.28},
    "i10-whiskey": {"y0": 0.08, "y1": 0.96, "carH0": 0.015, "carH1": 0.09, "carW0": 0.012, "carW1": 0.07, "mul": 1.6, "mild": 1.2, "score": 0.2},
    "i10-henderson": {"y0": 0.15, "y1": 0.62, "carH0": 0.055, "carH1": 0.09, "carW0": 0.04, "carW1": 0.06, "mul": 1.75, "mild": 1.6, "score": 0.4},
    "i10-scott": {"y0": 0.15, "y1": 0.98, "carH0": 0.05, "carH1": 0.16, "carW0": 0.04, "carW1": 0.12, "mul": 1.35, "mild": 1.15, "score": 0.22},
    "i10-lafayette": {"y0": 0.38, "y1": 0.98, "carH0": 0.028, "carH1": 0.1, "carW0": 0.028, "carW1": 0.09, "mul": 1.45, "mild": 1.15, "score": 0.2},
    "default": {"y0": 0.2, "y1": 0.98, "carH0": 0.03, "carH1": 0.1, "carW0": 0.02, "carW1": 0.07, "mul": 1.6, "mild": 1.25, "score": 0.28},
}


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


def _lerp(y: float, y0: float, y1: float, start: float, end: float) -> float:
    span = y1 - y0
    share = 0.0 if span <= 0 else min(1.0, max(0.0, (y - y0) / span))
    return start + (end - start) * share


def box_is_freight(camera_id: object, y: float, height: float, width: float, truck: float, car: float, bus: float) -> bool:
    """Отдельная формула камеры: линия легковых и порог грузовика на этой глубине."""
    formula = FORMULAS.get(str(camera_id), FORMULAS["default"])
    if y < formula["y0"] or y > formula["y1"] or height <= 0 or width <= 0:
        return False
    if height > 0.72 or width > 0.85:
        return False
    car_h = _lerp(y, formula["y0"], formula["y1"], formula["carH0"], formula["carH1"])
    car_w = _lerp(y, formula["y0"], formula["y1"], formula["carW0"], formula["carW1"])
    big = (
        height >= car_h * formula["mul"]
        and width >= car_w * formula["mul"]
        and not (car >= 0.45 and truck < 0.08 and height < car_h * (formula["mul"] + 0.35))
    )
    labeled = (
        truck >= formula["score"]
        and truck >= car
        and height >= car_h * formula["mild"]
        and width >= car_w * formula["mild"]
    )
    confused = (
        bus >= formula["score"]
        and truck >= formula["score"] * 0.45
        and height >= car_h * formula["mul"]
        and width >= car_w * formula["mild"]
    )
    return big or labeled or confused


def keep_freight(
    candidates: np.ndarray,
    frame_shape: tuple[int, int],
    ratio: float,
    camera_id: object = "default",
) -> list[tuple[int, int, int, int, str]]:
    """Оставляет грузовой транспорт. candidates: x, y, w, h, score, class в координатах letterbox."""
    height, width = frame_shape
    marks: list[tuple[int, int, int, int, str]] = []
    if candidates.size == 0 or height <= 0 or width <= 0:
        return marks
    for row in candidates:
        kind = int(row[5])
        score = float(row[4])
        truck = score if kind == TRUCK else 0.0
        car = score if kind == CAR else 0.0
        bus = score if kind == BUS else 0.0
        x = int(round(float(row[0]) / ratio))
        y = int(round(float(row[1]) / ratio))
        box_w = int(round(float(row[2]) / ratio))
        box_h = int(round(float(row[3]) / ratio))
        if box_w > width * 0.92 and box_h > height * 0.92:
            continue
        x = min(width - 1, max(0, x))
        y = min(height - 1, max(0, y))
        box_w = min(width - x, box_w)
        box_h = min(height - y, box_h)
        center_y = (y + box_h / 2) / height
        if not box_is_freight(camera_id, center_y, box_h / height, box_w / width, truck, car, bus):
            continue
        marks.append((x, y, box_w, box_h, "грузовой"))
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

    def find(self, frame_bgr: np.ndarray, camera_id: object = None) -> list[tuple[int, int, int, int, str]]:
        with self._lock:
            self._load()
            if self.net is None:
                return []
            rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
            padded, ratio = _letterbox(rgb)
            blob = np.transpose(padded, (2, 0, 1))[np.newaxis, :, :, :]
            self.net.setInput(blob)
            outputs = self.net.forward(self.net.getUnconnectedOutLayersNames())
            return self._decode(outputs[0], frame_bgr.shape[:2], ratio, camera_id)

    def _decode(
        self,
        outputs: np.ndarray,
        frame_shape: tuple[int, int],
        ratio: float,
        camera_id: object = None,
    ) -> list[tuple[int, int, int, int, str]]:
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
        truck = scores[:, TRUCK]
        car = scores[:, CAR]
        bus = scores[:, BUS]
        frame_h, frame_w = frame_shape
        if frame_h <= 0 or frame_w <= 0:
            return []
        signal = np.maximum(np.maximum(truck, bus), car)
        order = np.argsort(signal)[::-1][:48]
        picked_boxes = []
        picked_scores = []
        for hit in order:
            if float(signal[hit]) < 0.15:
                continue
            box_w = float(boxes[hit, 2]) / ratio / frame_w
            box_h = float(boxes[hit, 3]) / ratio / frame_h
            center_y = (float(boxes[hit, 1]) + float(boxes[hit, 3]) / 2.0) / ratio / frame_h
            if not box_is_freight(camera_id, center_y, box_h, box_w, float(truck[hit]), float(car[hit]), float(bus[hit])):
                continue
            picked_boxes.append(boxes[hit].tolist())
            picked_scores.append(float(max(truck[hit], bus[hit], 0.2)))
        if not picked_boxes:
            return []
        keep = cv2.dnn.NMSBoxes(picked_boxes, picked_scores, 0.15, NMS)
        if keep is None or len(keep) == 0:
            return []
        chosen = np.asarray(keep).reshape(-1)
        marks: list[tuple[int, int, int, int, str]] = []
        for index in chosen:
            row = picked_boxes[int(index)]
            x = min(frame_w - 1, max(0, int(round(row[0] / ratio))))
            y = min(frame_h - 1, max(0, int(round(row[1] / ratio))))
            box_w = min(frame_w - x, max(1, int(round(row[2] / ratio))))
            box_h = min(frame_h - y, max(1, int(round(row[3] / ratio))))
            marks.append((x, y, box_w, box_h, "грузовой"))
        return marks


finder = HeavyFinder()
