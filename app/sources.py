"""Источники кадров: имитатор судовых камер, файл, веб-камера, RTSP."""

from __future__ import annotations

import os
import time

import cv2
import numpy as np

from app.config import FRAME_H, FRAME_W

KINDS = ("bridge", "deck", "gangway", "engine")


def error_frame(text: str) -> np.ndarray:
    img = np.zeros((FRAME_H, FRAME_W, 3), np.uint8)
    img[:] = (28, 24, 20)
    cv2.putText(
        img,
        text[:70],
        (16, FRAME_H // 2),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.55,
        (80, 170, 220),
        1,
        cv2.LINE_AA,
    )
    return img


def _person(img: np.ndarray, x: int, y: int, scale: float = 1.0) -> None:
    body_w = int(36 * scale)
    body_h = int(92 * scale)
    cv2.rectangle(img, (x, y), (x + body_w, y + body_h), (45, 52, 70), -1)
    cv2.rectangle(img, (x + 4, y + 8), (x + body_w - 4, y + int(40 * scale)), (190, 175, 70), -1)
    cv2.circle(img, (x + body_w // 2, y - int(14 * scale)), int(14 * scale), (190, 200, 210), -1)


def render(kind: str, t: float, size: tuple[int, int] = (FRAME_W, FRAME_H)) -> np.ndarray:
    """Кадр имитатора. `t` — секунды от старта источника. Сцены зациклены."""
    width, height = size
    img = np.zeros((height, width, 3), np.uint8)

    if kind == "bridge":
        img[:] = (42, 36, 28)
        cv2.rectangle(img, (0, 0), (width, int(height * 0.42)), (90, 70, 48), -1)
        cv2.rectangle(img, (40, int(height * 0.55)), (width - 40, height - 16), (24, 28, 32), -1)
        phase = t % 40
        if 10 <= phase <= 18:
            progress = (phase - 10) / 8
            _person(img, int(80 + progress * (width - 220)), int(height * 0.48), 1.35)
    elif kind == "deck":
        img[:] = (70, 62, 48)
        cv2.rectangle(img, (0, int(height * 0.62)), (width, height), (110, 78, 40), -1)
        cv2.line(img, (0, int(height * 0.62)), (width, int(height * 0.62)), (160, 140, 90), 2)
        phase = t % 25
        if 4 <= phase <= 14:
            progress = (phase - 4) / 10
            x = int(30 + progress * (width - 220))
            y = int(height * 0.28)
            cv2.rectangle(img, (x, y), (x + 170, y + 110), (40, 140, 200), -1)
    elif kind == "gangway":
        img[:] = (48, 50, 52)
        for i in range(8):
            y = 30 + i * 40
            cv2.line(img, (int(width * 0.2), y), (int(width * 0.8), y + 20), (90, 96, 100), 3)
        phase = t % 30
        if 6 <= phase <= 14:
            progress = (phase - 6) / 8
            _person(img, int(width * 0.22 + progress * width * 0.45), int(height * 0.34), 1.7)
    elif kind == "engine":
        img[:] = (32, 30, 28)
        cv2.rectangle(img, (30, 40), (200, height - 30), (55, 58, 60), -1)
        cv2.circle(img, (420, 160), 70, (50, 54, 58), 8)
        needle = int(20 * np.sin(t * 2.2))
        cv2.line(img, (420, 160), (420 + needle, 100), (180, 180, 180), 2)
        phase = t % 50
        if 40 <= phase <= 48:
            cv2.ellipse(img, (330, 190), (150, 100), 0, 0, 360, (210, 220, 230), -1)
    else:
        return error_frame(f"unknown synthetic: {kind}")

    return img


class FrameSource:
    def read(self) -> np.ndarray:
        raise NotImplementedError

    def close(self) -> None:
        return None

    @property
    def healthy(self) -> bool:
        return True


class SyntheticSource(FrameSource):
    def __init__(self, kind: str) -> None:
        self.kind = kind if kind in KINDS else "bridge"
        self.started = time.monotonic()

    def read(self) -> np.ndarray:
        return render(self.kind, time.monotonic() - self.started)


# TCP и таймаут открытия: через NAT судовой сети UDP часто не доходит, а зависший RTSP
# не должен держать поток камеры десятки секунд. stimeout — микросекунды FFmpeg.
_RTSP_FFMPEG = "rtsp_transport;tcp|stimeout;8000000"


class CaptureSource(FrameSource):
    def __init__(self, uri: str, loop: bool) -> None:
        self.loop = loop
        self.uri = uri
        self.cap = self._open()

    def _open(self) -> cv2.VideoCapture:
        target: int | str
        if self.uri.isdigit() and not self.loop:
            target = int(self.uri)
            cap = cv2.VideoCapture(target)
        else:
            target = self.uri
            if target.lower().startswith("rtsp://"):
                os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = _RTSP_FFMPEG
                cap = cv2.VideoCapture(target, cv2.CAP_FFMPEG)
            else:
                cap = cv2.VideoCapture(target)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        return cap

    def read(self) -> np.ndarray:
        if self.cap is None or not self.cap.isOpened():
            if not self.loop:
                self.cap = self._open()
            if self.cap is None or not self.cap.isOpened():
                return error_frame("no signal")
        ok, frame = self.cap.read()
        if not ok or frame is None:
            if self.loop and self.cap is not None:
                self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ok, frame = self.cap.read()
            if not ok or frame is None:
                if not self.loop:
                    self.close()
                return error_frame("no signal")
        return cv2.resize(frame, (FRAME_W, FRAME_H))

    def close(self) -> None:
        if self.cap is not None:
            self.cap.release()
            self.cap = None

    @property
    def healthy(self) -> bool:
        return self.cap is not None and self.cap.isOpened()


def open_source(source_type: str, source_uri: str) -> FrameSource:
    if source_type == "synthetic":
        return SyntheticSource(source_uri or "bridge")
    if source_type == "file":
        return CaptureSource(source_uri, loop=True)
    if source_type in ("webcam", "rtsp"):
        return CaptureSource(source_uri or "0", loop=False)
    return SyntheticSource("bridge")
