"""HTTP-пульт Marine VMS."""

from __future__ import annotations

import csv
import io
import logging
import os
import time
from typing import Literal

import cv2
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field, model_validator
from contextlib import asynccontextmanager

from app.config import ROOT
from app import db
from app.engine import engine
from app.github_store import GithubError, materialize_clip, parse_ref, present_event
from app.sources import KINDS

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("marine")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init_db()
    db.seed_if_empty()
    engine.start()
    logger.info("Marine VMS слушает пульт")
    yield
    engine.shutdown()


app = FastAPI(title="Marine VMS", version="1.0.0", lifespan=lifespan)
app.mount("/assets", StaticFiles(directory=ROOT / "static"), name="assets")


class TelemetryIn(BaseModel):
    speed_kn: float | None = None
    heading: float | None = None
    lat: float | None = None
    lon: float | None = None
    mode: str | None = None


class ArmIn(BaseModel):
    armed: bool


class CameraIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    location: str = ""
    source_type: Literal["synthetic", "file", "webcam", "rtsp"]
    source_uri: str = ""
    enabled: bool = True
    fps: float = Field(default=8, ge=1, le=25)


class ZoneIn(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(gt=0, le=1)
    h: float = Field(gt=0, le=1)


class ConditionIn(BaseModel):
    type: Literal["motion", "schedule", "speed", "armed", "color", "heavy"]
    min_ratio: float | None = Field(default=None, ge=0, le=1)
    color: Literal["red"] | None = None
    zone: ZoneIn | None = None
    days: list[int] | None = None
    start: str | None = None
    end: str | None = None
    op: Literal["gt", "gte", "lt", "lte", "between"] | None = None
    knots: float | None = None
    knots_max: float | None = None

    @model_validator(mode="after")
    def check(self):
        if self.type == "motion" and self.min_ratio is None:
            self.min_ratio = 0.02
        if self.type == "color":
            self.color = self.color or "red"
            if self.min_ratio is None:
                self.min_ratio = 0.004
        if self.type == "schedule" and (not self.start or not self.end):
            raise ValueError("для расписания нужны start и end")
        if self.type == "speed" and (self.op is None or self.knots is None):
            raise ValueError("для скорости нужны op и knots")
        if self.type == "speed" and self.op == "between" and self.knots_max is None:
            raise ValueError("для диапазона нужен knots_max")
        if self.days is not None and any(day < 0 or day > 6 for day in self.days):
            raise ValueError("день недели: 0 понедельник … 6 воскресенье")
        return self


class RuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    camera_id: int | None = None
    enabled: bool = True
    match_mode: Literal["all", "any"] = "all"
    conditions: list[ConditionIn] = Field(min_length=1)
    pre_roll_sec: float = Field(default=3, ge=0, le=30)
    post_roll_sec: float = Field(default=4, ge=0, le=60)
    cooldown_sec: float = Field(default=8, ge=0, le=600)
    max_clip_sec: float = Field(default=90, ge=5, le=600)


def _rule_payload(body: RuleIn) -> dict:
    data = body.model_dump()
    data["conditions"] = [cond.model_dump(exclude_none=True) for cond in body.conditions]
    return data


@app.get("/")
def index() -> FileResponse:
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/app.css")
def app_css() -> FileResponse:
    return FileResponse(ROOT / "static" / "app.css", media_type="text/css")


@app.get("/app.js")
def app_js() -> FileResponse:
    return FileResponse(ROOT / "static" / "app.js", media_type="text/javascript")


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "product": "Marine VMS"}


@app.get("/api/status")
def status() -> dict:
    return engine.status()


@app.get("/api/kinds")
def kinds() -> dict:
    return {"synthetic": list(KINDS)}


@app.post("/api/arm")
def arm(body: ArmIn) -> dict:
    return {"armed": db.set_armed(body.armed)}


@app.get("/api/telemetry")
def telemetry() -> dict:
    return db.get_telemetry()


@app.post("/api/telemetry")
def update_telemetry(body: TelemetryIn) -> dict:
    patch = body.model_dump(exclude_none=True)
    return db.set_telemetry(patch)


@app.post("/api/scenario/{name}")
def scenario(name: str) -> dict:
    presets = {
        "alongside": {"speed_kn": 0.3, "mode": "alongside"},
        "sea": {"speed_kn": 14.2, "mode": "sea"},
        "maneuver": {"speed_kn": 5.0, "mode": "maneuver"},
    }
    if name not in presets:
        raise HTTPException(404, "неизвестный режим")
    return db.set_telemetry(presets[name])


@app.get("/api/cameras")
def cameras() -> list:
    rows = db.list_cameras()
    for row in rows:
        row["enabled"] = bool(row["enabled"])
    return rows


@app.post("/api/cameras")
def add_camera(body: CameraIn) -> dict:
    row = db.create_camera(body.model_dump())
    row["enabled"] = bool(row["enabled"])
    return row


@app.put("/api/cameras/{camera_id}")
def edit_camera(camera_id: int, body: CameraIn) -> dict:
    row = db.update_camera(camera_id, body.model_dump())
    if row is None:
        raise HTTPException(404, "камера не найдена")
    row["enabled"] = bool(row["enabled"])
    return row


@app.delete("/api/cameras/{camera_id}")
def remove_camera(camera_id: int) -> dict:
    if db.get_camera(camera_id) is None:
        raise HTTPException(404, "камера не найдена")
    db.delete_camera(camera_id)
    return {"ok": True}


@app.get("/api/rules")
def rules() -> list:
    return db.list_rules()


@app.post("/api/rules")
def add_rule(body: RuleIn) -> dict:
    return db.create_rule(_rule_payload(body))


@app.put("/api/rules/{rule_id}")
def edit_rule(rule_id: int, body: RuleIn) -> dict:
    row = db.update_rule(rule_id, _rule_payload(body))
    if row is None:
        raise HTTPException(404, "правило не найдено")
    return row


@app.delete("/api/rules/{rule_id}")
def remove_rule(rule_id: int) -> dict:
    if db.get_rule(rule_id) is None:
        raise HTTPException(404, "правило не найдено")
    db.delete_rule(rule_id)
    return {"ok": True}


@app.get("/api/events")
def events(limit: int = 40) -> list:
    return [present_event(event) for event in db.list_events(max(1, min(limit, 200)))]


@app.get("/api/events.csv")
def events_csv() -> Response:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "started_at", "ended_at", "camera", "rule", "peak_ratio", "reason"])
    for event in reversed(db.list_events(500)):
        writer.writerow(
            [
                event["id"],
                event["started_at"],
                event["ended_at"] or "",
                event["camera_name"],
                event["rule_name"],
                event["peak_ratio"],
                event["reason"],
            ]
        )
    return Response(
        "\ufeff" + buf.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=marine-vms-events.csv"},
    )


@app.get("/api/events/{event_id}")
def event_detail(event_id: int) -> dict:
    event = db.get_event(event_id)
    if event is None:
        raise HTTPException(404, "событие не найдено")
    return present_event(event)


def _clip_file(event_id: int):
    event = db.get_event(event_id)
    if event is None:
        raise HTTPException(404, "событие не найдено")
    try:
        path, temporary = materialize_clip(event)
    except GithubError:
        logger.exception("скачивание клипа %s", event_id)
        raise HTTPException(502, "не удалось скачать клип с GitHub")
    if path is None:
        raise HTTPException(404, "файл ещё не готов")
    parsed = parse_ref(event.get("clip_path"))
    filename = parsed[1] if parsed else path.name
    return path, temporary, filename


@app.get("/api/events/{event_id}/thumb")
def event_thumb(event_id: int) -> FileResponse:
    event = db.get_event(event_id)
    if event is None or not event.get("thumb_path"):
        raise HTTPException(404, "нет кадра")
    return FileResponse(event["thumb_path"])


@app.get("/api/events/{event_id}/clip")
def event_clip(event_id: int) -> FileResponse:
    path, temporary, filename = _clip_file(event_id)
    background = BackgroundTask(path.unlink, missing_ok=True) if temporary else None
    return FileResponse(path, filename=filename, background=background)


def _mjpeg(chunks):
    return StreamingResponse(chunks, media_type="multipart/x-mixed-replace; boundary=frame")


def _wrap(jpeg: bytes) -> bytes:
    return b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n"


@app.get("/api/cameras/{camera_id}/live")
def live(camera_id: int):
    if db.get_camera(camera_id) is None:
        raise HTTPException(404, "камера не найдена")

    def gen():
        while True:
            frame = engine.jpeg(camera_id)
            if frame:
                yield _wrap(frame)
            time.sleep(0.12)

    return _mjpeg(gen())


@app.get("/api/events/{event_id}/playback")
def playback(event_id: int):
    path, temporary, _filename = _clip_file(event_id)

    def gen():
        cap = cv2.VideoCapture(str(path))
        try:
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                encoded_ok, encoded = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
                if encoded_ok:
                    yield _wrap(encoded.tobytes())
                time.sleep(0.08)
        finally:
            cap.release()
            if temporary:
                path.unlink(missing_ok=True)

    return _mjpeg(gen())


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run("app.main:app", host="127.0.0.1", port=port, reload=False)


if __name__ == "__main__":
    main()
