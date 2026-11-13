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
CONFIDENCE = 0.5
CAR_CONFIDENCE = 0.45
NMS = 0.5
BINS = 8


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


def freight_size(box_w: int, box_h: int, frame_w: int, frame_h: int, car: tuple[float, float] | None) -> bool:
    """Грузовик крупнее легкового на том же участке кадра. car — (высота, ширина) типичной легковушки."""
    if frame_w <= 0 or frame_h <= 0 or box_w <= 0 or box_h <= 0:
        return False
    if car:
        car_h, car_w = car
        if car_h <= 0 or car_w <= 0:
            return False
        return car_h * 1.55 <= box_h <= car_h * 3.2 and car_w * 1.2 <= box_w <= car_w * 4.2
    height_frac = box_h / frame_h
    width_frac = box_w / frame_w
    return 0.08 <= height_frac <= 0.5 and 0.045 <= width_frac <= 0.55


def keep_freight(
    candidates: np.ndarray,
    frame_shape: tuple[int, int],
    ratio: float,
    scales: list[tuple[float, float] | None] | None = None,
) -> list[tuple[int, int, int, int, str]]:
    """Оставляет грузовой транспорт. candidates: x, y, w, h, score, class в координатах letterbox."""
    height, width = frame_shape
    marks: list[tuple[int, int, int, int, str]] = []
    if candidates.size == 0:
        return marks
    for index, row in enumerate(candidates):
        if int(row[5]) != TRUCK or float(row[4]) < CONFIDENCE:
            continue
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
        car = None if scales is None else scales[index]
        if not freight_size(box_w, box_h, width, height, car):
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
        self._cars: dict[object, list[list[tuple[float, float]]]] = {}

    def _note_car(self, camera_id: object, y_frac: float, box_h: float, box_w: float) -> None:
        bins = self._cars.setdefault(camera_id, [[] for _ in range(BINS)])
        index = min(BINS - 1, max(0, int(y_frac * BINS)))
        bins[index].append((box_h, box_w))
        if len(bins[index]) > 12:
            del bins[index][0]

    def _car_scale(self, camera_id: object, y_frac: float) -> tuple[float, float] | None:
        bins = self._cars.get(camera_id)
        if not bins:
            return None
        index = min(BINS - 1, max(0, int(y_frac * BINS)))
        samples: list[tuple[float, float]] = []
        for shift in (-1, 0, 1):
            slot = index + shift
            if 0 <= slot < BINS:
                samples.extend(bins[slot])
        if len(samples) < 4:
            return None
        heights = sorted(item[0] for item in samples)
        widths = sorted(item[1] for item in samples)
        mid = max(0, int((len(heights) - 1) * 0.35))
        return heights[mid], widths[mid]

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
        best = np.argmax(scores, axis=1)
        frame_h = frame_shape[0]
        car_hits = np.flatnonzero((best == CAR) & (car >= CAR_CONFIDENCE))
        if car_hits.size:
            order = car_hits[np.argsort(car[car_hits])[::-1][:8]]
            for hit in order:
                box_h = float(boxes[hit, 3]) / ratio
                box_w = float(boxes[hit, 2]) / ratio
                center_y = (float(boxes[hit, 1]) + float(boxes[hit, 3]) / 2.0) / ratio
                if frame_h <= 0 or not (0.02 * frame_h <= box_h <= 0.4 * frame_h):
                    continue
                self._note_car(camera_id, center_y / frame_h, box_h, box_w)
        wanted = np.flatnonzero((best == TRUCK) & (truck >= CONFIDENCE) & (truck >= car + 0.06) & (truck >= bus))
        if wanted.size == 0:
            return []
        truck_boxes = boxes[wanted]
        truck_scores = truck[wanted]
        keep = cv2.dnn.NMSBoxes(truck_boxes.tolist(), truck_scores.tolist(), CONFIDENCE, NMS)
        if keep is None or len(keep) == 0:
            return []
        chosen = np.asarray(keep).reshape(-1)
        packed = np.concatenate(
            [truck_boxes[chosen], truck_scores[chosen, None], np.full((chosen.size, 1), TRUCK, np.float32)],
            axis=1,
        )
        scales: list[tuple[float, float] | None] = []
        for row in packed:
            center_y = (float(row[1]) + float(row[3]) / 2.0) / ratio / frame_h
            scales.append(self._car_scale(camera_id, center_y))
        return keep_freight(packed, frame_shape, ratio, scales)


finder = HeavyFinder()
