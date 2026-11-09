"""Цикл камер: движение, правила, запись только пока условие держится."""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

from app.config import FRAME_H, FRAME_W, MEDIA, RECORDINGS_ENABLED, THUMBS, ensure_dirs
from app import db
from app.github_store import archive
from app.detectors import MotionDetector, moving_color_mask
from app.osd import paint
from app.rules import evaluate_rule, mask_ratio
from app.sources import FrameSource, open_source

logger = logging.getLogger("marine")


@dataclass
class CamRuntime:
    detector: MotionDetector = field(default_factory=MotionDetector)
    source: FrameSource | None = None
    source_key: tuple | None = None
    buffer: deque = field(default_factory=deque)
    writer: cv2.VideoWriter | None = None
    event_id: int | None = None
    started_mono: float = 0.0
    post_deadline: float | None = None
    cooldown_until: float = 0.0
    peak: float = 0.0
    reason: str = ""
    rule_name: str = ""
    rule_id: int | None = None
    post_roll: float = 4.0
    max_clip: float = 90.0
    cooldown: float = 8.0
    recording: bool = False
    clip_file: Path | None = None
    motion_ratio: float = 0.0
    color_ratio: float = 0.0
    watch_color: bool = False
    matched: list[str] = field(default_factory=list)
    fps: float = 0.0
    frames: int = 0
    window_start: float = field(default_factory=time.monotonic)
    error: str | None = None


def _draw_zones(frame: np.ndarray, rules: list[dict]) -> np.ndarray:
    out = frame.copy()
    height, width = out.shape[:2]
    for rule in rules:
        for cond in rule.get("conditions") or []:
            zone = cond.get("zone")
            if cond.get("type") == "motion" and zone:
                x1 = int(float(zone["x"]) * width)
                y1 = int(float(zone["y"]) * height)
                x2 = int((float(zone["x"]) + float(zone["w"])) * width)
                y2 = int((float(zone["y"]) + float(zone["h"])) * height)
                cv2.rectangle(out, (x1, y1), (x2, y2), (0, 180, 255), 1)
    return out


def _draw_color(frame: np.ndarray, color_mask: np.ndarray) -> np.ndarray:
    if color_mask is None or not np.any(color_mask):
        return frame
    contours, _ = cv2.findContours(color_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)
        cv2.rectangle(frame, (x, y), (x + width, y + height), (40, 40, 220), 2)
    return frame


def _fit(frame: np.ndarray) -> np.ndarray:
    if frame.shape[1] != FRAME_W or frame.shape[0] != FRAME_H:
        return cv2.resize(frame, (FRAME_W, FRAME_H))
    return frame


class Engine:
    def __init__(self) -> None:
        self.stop = threading.Event()
        self.supervisor: threading.Thread | None = None
        self.workers: dict[int, threading.Thread] = {}
        self.worker_stops: dict[int, threading.Event] = {}
        self.runtimes: dict[int, CamRuntime] = {}
        self.cache: dict = {"cameras": [], "rules": [], "telemetry": {}, "armed": True}
        self.frames: dict[int, bytes] = {}
        self.frame_lock = threading.Lock()
        self.state_lock = threading.Lock()

    def start(self) -> None:
        ensure_dirs()
        self.stop.clear()
        if RECORDINGS_ENABLED:
            archive.scan()
            archive.start()
        self.supervisor = threading.Thread(target=self._supervise, name="vms-supervisor", daemon=True)
        self.supervisor.start()

    def shutdown(self) -> None:
        self.stop.set()
        for event in self.worker_stops.values():
            event.set()
        for thread in list(self.workers.values()):
            thread.join(timeout=2)
        with self.state_lock:
            for runtime in self.runtimes.values():
                self._close_clip(runtime, "остановка службы")
                if runtime.source is not None:
                    runtime.source.close()

    def jpeg(self, camera_id: int) -> bytes | None:
        with self.frame_lock:
            return self.frames.get(camera_id)

    def status(self) -> dict:
        cache = self.cache
        cameras = []
        for cam in cache.get("cameras", []):
            runtime = self.runtimes.get(cam["id"])
            cameras.append(
                {
                    "id": cam["id"],
                    "name": cam["name"],
                    "location": cam["location"],
                    "source_type": cam["source_type"],
                    "source_uri": cam["source_uri"],
                    "enabled": bool(cam["enabled"]),
                    "recording": bool(runtime and runtime.recording),
                    "rule_name": runtime.rule_name if runtime and runtime.recording else "",
                    "motion_ratio": round(runtime.motion_ratio, 4) if runtime else 0,
                    "color_ratio": round(runtime.color_ratio, 4) if runtime else 0,
                    "matched": list(runtime.matched) if runtime else [],
                    "fps": round(runtime.fps, 1) if runtime else 0,
                    "error": runtime.error if runtime else None,
                }
            )
        return {
            "armed": bool(cache.get("armed")),
            "telemetry": cache.get("telemetry") or {},
            "cameras": cameras,
        }

    def camera_by_id(self, camera_id: int) -> dict | None:
        for cam in self.cache.get("cameras", []):
            if cam["id"] == camera_id and cam["enabled"]:
                return cam
        return None

    def _supervise(self) -> None:
        while not self.stop.is_set():
            try:
                cameras = db.list_cameras()
                self.cache = {
                    "cameras": cameras,
                    "rules": db.list_rules(),
                    "telemetry": db.get_telemetry(),
                    "armed": db.is_armed(),
                }
                alive = {cam["id"] for cam in cameras if cam["enabled"]}
                for camera_id in list(self.workers):
                    if camera_id not in alive:
                        self.worker_stops[camera_id].set()
                        self.workers[camera_id].join(timeout=2)
                        self.workers.pop(camera_id, None)
                        self.worker_stops.pop(camera_id, None)
                        runtime = self.runtimes.pop(camera_id, None)
                        if runtime:
                            self._close_clip(runtime, "камера отключена")
                            if runtime.source:
                                runtime.source.close()
                        with self.frame_lock:
                            self.frames.pop(camera_id, None)
                for cam in cameras:
                    if not cam["enabled"] or cam["id"] in self.workers:
                        continue
                    flag = threading.Event()
                    self.worker_stops[cam["id"]] = flag
                    thread = threading.Thread(
                        target=self._worker,
                        args=(cam["id"], flag),
                        name=f"cam-{cam['id']}",
                        daemon=True,
                    )
                    self.workers[cam["id"]] = thread
                    thread.start()
            except Exception:
                logger.exception("supervisor")
            self.stop.wait(0.6)

    def _worker(self, camera_id: int, flag: threading.Event) -> None:
        while not flag.is_set() and not self.stop.is_set():
            cam = self.camera_by_id(camera_id)
            if cam is None:
                flag.wait(0.3)
                continue
            started = time.monotonic()
            try:
                self.process(cam)
            except Exception:
                logger.exception("camera %s", camera_id)
            fps = float(cam.get("fps") or 8)
            flag.wait(max(0.0, (1.0 / fps) - (time.monotonic() - started)))

    def process(self, cam: dict) -> None:
        with self.state_lock:
            runtime = self.runtimes.get(cam["id"])
            if runtime is None:
                runtime = CamRuntime()
                self.runtimes[cam["id"]] = runtime

        key = (cam["source_type"], cam["source_uri"])
        if runtime.source is None or runtime.source_key != key:
            if runtime.source is not None:
                runtime.source.close()
            runtime.source = open_source(cam["source_type"], cam["source_uri"])
            runtime.source_key = key
            runtime.detector.reset()
            runtime.buffer.clear()

        frame = _fit(runtime.source.read())
        runtime.error = None if runtime.source.healthy else "нет сигнала"
        mask = runtime.detector.feed(frame)
        runtime.motion_ratio = mask_ratio(mask, None)
        color_mask = moving_color_mask(frame, mask, "red")
        runtime.color_ratio = mask_ratio(color_mask, None)

        rules = [
            rule
            for rule in self.cache.get("rules", [])
            if rule.get("enabled") and (rule.get("camera_id") in (None, cam["id"]))
        ]
        telemetry = self.cache.get("telemetry") or {}
        armed = bool(self.cache.get("armed"))
        ctx = {
            "now": datetime.now().astimezone(),
            "speed_kn": float(telemetry.get("speed_kn") or 0),
            "armed": armed,
        }
        matched: list[tuple[dict, str, float]] = []
        for rule in rules:
            ratios: list[float] = []
            color_ratios: list[float] = []
            for cond in rule.get("conditions") or []:
                if cond.get("type") == "motion":
                    ratios.append(mask_ratio(mask, cond.get("zone")))
                elif cond.get("type") == "color":
                    color_ratios.append(mask_ratio(color_mask, cond.get("zone")))
            fired, reason = evaluate_rule(rule, ctx, ratios, color_ratios)
            if fired:
                measured = ratios + color_ratios
                peak = max(measured) if measured else runtime.color_ratio
                matched.append((rule, reason, peak))

        runtime.matched = [rule["name"] for rule, _, _ in matched]
        runtime.watch_color = any(
            cond.get("type") == "color"
            for rule in rules
            for cond in (rule.get("conditions") or [])
        )
        now = time.monotonic()
        pre_roll = max((float(rule["pre_roll_sec"]) for rule in rules), default=3.0)
        runtime.buffer.append((now, frame))
        while runtime.buffer and now - runtime.buffer[0][0] > pre_roll:
            runtime.buffer.popleft()

        active = bool(matched) and armed
        if runtime.writer is None:
            if active and now >= runtime.cooldown_until:
                self._open_clip(runtime, cam, matched, ctx["speed_kn"])
        else:
            if active:
                runtime.post_deadline = None
                runtime.reason = " | ".join(reason for _, reason, _ in matched)
                runtime.peak = max(runtime.peak, *(peak for _, _, peak in matched))
            elif not armed:
                self._close_clip(runtime, runtime.reason)
            else:
                if runtime.post_deadline is None:
                    runtime.post_deadline = now + runtime.post_roll
                too_long = now - runtime.started_mono >= runtime.max_clip
                if too_long or now >= runtime.post_deadline:
                    self._close_clip(runtime, runtime.reason)

        shown = _draw_zones(frame, rules)
        if runtime.watch_color:
            shown = _draw_color(shown, color_mask)
        lines = self._lines(cam, ctx, runtime)
        burned = paint(shown, lines, runtime.recording)
        if runtime.writer is not None:
            runtime.writer.write(burned)
            runtime.peak = max(runtime.peak, runtime.motion_ratio)

        ok, encoded = cv2.imencode(".jpg", burned, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
        if ok:
            with self.frame_lock:
                self.frames[cam["id"]] = encoded.tobytes()

        runtime.frames += 1
        elapsed = now - runtime.window_start
        if elapsed >= 1:
            runtime.fps = runtime.frames / elapsed
            runtime.frames = 0
            runtime.window_start = now

    def _lines(self, cam: dict, ctx: dict, runtime: CamRuntime) -> list[str]:
        moment = ctx["now"].strftime("%Y-%m-%d %H:%M:%S")
        lines = [
            f"{cam['name']} · {cam.get('location') or 'судно'}",
            f"{moment}   {ctx['speed_kn']:.1f} уз",
        ]
        if runtime.recording:
            lines.append(f"REC  {runtime.rule_name}")
        elif runtime.matched:
            lines.append("условие: " + ", ".join(runtime.matched))
        else:
            line = f"ожидание  ·  движение {runtime.motion_ratio * 100:.1f}%"
            if runtime.watch_color:
                line += f"  ·  красный {runtime.color_ratio * 100:.1f}%"
            lines.append(line)
        return lines

    def _open_clip(self, runtime: CamRuntime, cam: dict, matched: list[tuple[dict, str, float]], speed_kn: float) -> None:
        if not RECORDINGS_ENABLED:
            return
        rule, reason, peak = matched[0]
        names = ", ".join(item[0]["name"] for item in matched)
        reasons = " | ".join(item[1] for item in matched)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = MEDIA / f"cam{cam['id']}_{stamp}.avi"
        thumb = THUMBS / f"cam{cam['id']}_{stamp}.jpg"
        runtime.clip_file = path
        writer = cv2.VideoWriter(
            str(path),
            cv2.VideoWriter_fourcc(*"MJPG"),
            float(cam.get("fps") or 8),
            (FRAME_W, FRAME_H),
        )
        if not writer.isOpened():
            runtime.clip_file = None
            logger.error("не открылся файл записи %s", path)
            return
        runtime.writer = writer
        runtime.recording = True
        runtime.started_mono = time.monotonic()
        runtime.post_deadline = None
        runtime.rule_id = rule["id"]
        runtime.rule_name = names
        runtime.reason = reasons
        runtime.peak = peak
        runtime.post_roll = max(float(item[0]["post_roll_sec"]) for item in matched)
        runtime.max_clip = min(float(item[0]["max_clip_sec"]) for item in matched)
        runtime.cooldown = max(float(item[0]["cooldown_sec"]) for item in matched)
        preview = paint(
            runtime.buffer[-1][1] if runtime.buffer else np.zeros((FRAME_H, FRAME_W, 3), np.uint8),
            [cam["name"], f"REC {names}", f"{speed_kn:.1f} уз"],
            True,
        )
        cv2.imwrite(str(thumb), preview)
        runtime.event_id = db.create_event(
            {
                "camera_id": cam["id"],
                "camera_name": cam["name"],
                "rule_id": rule["id"],
                "rule_name": names,
                "started_at": db.now_iso(),
                "reason": reasons,
                "clip_path": str(path),
                "thumb_path": str(thumb),
                "peak_ratio": peak,
            }
        )
        logger.info("запись %s → %s", names, path.name)
        for _, raw in list(runtime.buffer)[:-1]:
            burned = paint(_fit(raw), [cam["name"], f"REC {names}"], True)
            writer.write(burned)

    def _close_clip(self, runtime: CamRuntime, reason: str) -> None:
        if runtime.writer is None:
            runtime.recording = False
            return
        runtime.writer.release()
        runtime.writer = None
        runtime.recording = False
        runtime.cooldown_until = time.monotonic() + runtime.cooldown
        event_id = runtime.event_id
        path = runtime.clip_file
        if event_id is not None:
            db.finish_event(event_id, db.now_iso(), runtime.peak, reason)
            logger.info("клип закрыт, событие %s", event_id)
        runtime.event_id = None
        runtime.clip_file = None
        runtime.post_deadline = None
        if path is not None and path.is_file():
            archive.enqueue(event_id, path)


engine = Engine()
