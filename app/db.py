"""SQLite: камеры, правила, журнал, телеметрия судна."""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from app.config import DB_PATH, ensure_dirs

_lock = threading.Lock()


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    ensure_dirs()
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with _lock, connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS cameras (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                location TEXT NOT NULL DEFAULT '',
                source_type TEXT NOT NULL,
                source_uri TEXT NOT NULL DEFAULT '',
                enabled INTEGER NOT NULL DEFAULT 1,
                fps REAL NOT NULL DEFAULT 8
            );
            CREATE TABLE IF NOT EXISTS rules (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                camera_id INTEGER,
                enabled INTEGER NOT NULL DEFAULT 1,
                match_mode TEXT NOT NULL DEFAULT 'all',
                conditions_json TEXT NOT NULL,
                pre_roll_sec REAL NOT NULL DEFAULT 3,
                post_roll_sec REAL NOT NULL DEFAULT 4,
                cooldown_sec REAL NOT NULL DEFAULT 8,
                max_clip_sec REAL NOT NULL DEFAULT 90
            );
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY,
                camera_id INTEGER,
                camera_name TEXT,
                rule_id INTEGER,
                rule_name TEXT,
                started_at TEXT,
                ended_at TEXT,
                reason TEXT,
                clip_path TEXT,
                thumb_path TEXT,
                peak_ratio REAL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        if conn.execute("SELECT COUNT(*) AS n FROM settings WHERE key = 'armed'").fetchone()["n"] == 0:
            conn.execute("INSERT INTO settings (key, value) VALUES ('armed', '1')")
        if conn.execute("SELECT COUNT(*) AS n FROM settings WHERE key = 'telemetry'").fetchone()["n"] == 0:
            payload = {
                "speed_kn": 0.3,
                "heading": 42,
                "lat": 59.9343,
                "lon": 30.3351,
                "mode": "alongside",
            }
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('telemetry', ?)",
                (json.dumps(payload),),
            )


def _row(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    return dict(row)


def list_cameras(enabled_only: bool = False) -> list[dict]:
    sql = "SELECT * FROM cameras"
    if enabled_only:
        sql += " WHERE enabled = 1"
    sql += " ORDER BY id"
    with _lock, connect() as conn:
        return [dict(row) for row in conn.execute(sql)]


def get_camera(camera_id: int) -> dict | None:
    with _lock, connect() as conn:
        return _row(conn.execute("SELECT * FROM cameras WHERE id = ?", (camera_id,)).fetchone())


def create_camera(data: dict) -> dict:
    with _lock, connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO cameras (name, location, source_type, source_uri, enabled, fps)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                data["name"],
                data.get("location", ""),
                data["source_type"],
                data.get("source_uri", ""),
                1 if data.get("enabled", True) else 0,
                float(data.get("fps", 8)),
            ),
        )
        return dict(conn.execute("SELECT * FROM cameras WHERE id = ?", (cur.lastrowid,)).fetchone())


def update_camera(camera_id: int, data: dict) -> dict | None:
    current = get_camera(camera_id)
    if current is None:
        return None
    merged = {**current, **data}
    with _lock, connect() as conn:
        conn.execute(
            """
            UPDATE cameras
               SET name = ?, location = ?, source_type = ?, source_uri = ?, enabled = ?, fps = ?
             WHERE id = ?
            """,
            (
                merged["name"],
                merged.get("location", ""),
                merged["source_type"],
                merged.get("source_uri", ""),
                1 if merged.get("enabled", True) else 0,
                float(merged.get("fps", 8)),
                camera_id,
            ),
        )
        return dict(conn.execute("SELECT * FROM cameras WHERE id = ?", (camera_id,)).fetchone())


def delete_camera(camera_id: int) -> None:
    with _lock, connect() as conn:
        conn.execute("DELETE FROM cameras WHERE id = ?", (camera_id,))


def _decode_rule(row: sqlite3.Row) -> dict:
    item = dict(row)
    item["conditions"] = json.loads(item.pop("conditions_json"))
    item["enabled"] = bool(item["enabled"])
    return item


def list_rules() -> list[dict]:
    with _lock, connect() as conn:
        return [_decode_rule(row) for row in conn.execute("SELECT * FROM rules ORDER BY id")]


def get_rule(rule_id: int) -> dict | None:
    with _lock, connect() as conn:
        row = conn.execute("SELECT * FROM rules WHERE id = ?", (rule_id,)).fetchone()
        return _decode_rule(row) if row else None


def create_rule(data: dict) -> dict:
    with _lock, connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO rules (
                name, camera_id, enabled, match_mode, conditions_json,
                pre_roll_sec, post_roll_sec, cooldown_sec, max_clip_sec
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["name"],
                data.get("camera_id"),
                1 if data.get("enabled", True) else 0,
                data.get("match_mode", "all"),
                json.dumps(data["conditions"], ensure_ascii=False),
                float(data.get("pre_roll_sec", 3)),
                float(data.get("post_roll_sec", 4)),
                float(data.get("cooldown_sec", 8)),
                float(data.get("max_clip_sec", 90)),
            ),
        )
        row = conn.execute("SELECT * FROM rules WHERE id = ?", (cur.lastrowid,)).fetchone()
        return _decode_rule(row)


def update_rule(rule_id: int, data: dict) -> dict | None:
    current = get_rule(rule_id)
    if current is None:
        return None
    merged = {**current, **data}
    with _lock, connect() as conn:
        conn.execute(
            """
            UPDATE rules
               SET name = ?, camera_id = ?, enabled = ?, match_mode = ?, conditions_json = ?,
                   pre_roll_sec = ?, post_roll_sec = ?, cooldown_sec = ?, max_clip_sec = ?
             WHERE id = ?
            """,
            (
                merged["name"],
                merged.get("camera_id"),
                1 if merged.get("enabled", True) else 0,
                merged.get("match_mode", "all"),
                json.dumps(merged["conditions"], ensure_ascii=False),
                float(merged.get("pre_roll_sec", 3)),
                float(merged.get("post_roll_sec", 4)),
                float(merged.get("cooldown_sec", 8)),
                float(merged.get("max_clip_sec", 90)),
                rule_id,
            ),
        )
        row = conn.execute("SELECT * FROM rules WHERE id = ?", (rule_id,)).fetchone()
        return _decode_rule(row)


def delete_rule(rule_id: int) -> None:
    with _lock, connect() as conn:
        conn.execute("DELETE FROM rules WHERE id = ?", (rule_id,))


def is_armed() -> bool:
    with _lock, connect() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = 'armed'").fetchone()
        return row is not None and row["value"] == "1"


def set_armed(armed: bool) -> bool:
    with _lock, connect() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('armed', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("1" if armed else "0",),
        )
    return armed


def get_telemetry() -> dict[str, Any]:
    with _lock, connect() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = 'telemetry'").fetchone()
        data = json.loads(row["value"]) if row else {}
    data.setdefault("speed_kn", 0.0)
    data.setdefault("heading", 0)
    data.setdefault("lat", 0.0)
    data.setdefault("lon", 0.0)
    data.setdefault("mode", "manual")
    return data


def set_telemetry(data: dict) -> dict:
    current = get_telemetry()
    current.update(data)
    with _lock, connect() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('telemetry', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (json.dumps(current),),
        )
    return current


def create_event(data: dict) -> int:
    with _lock, connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO events (
                camera_id, camera_name, rule_id, rule_name, started_at, reason, clip_path, thumb_path, peak_ratio
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["camera_id"],
                data["camera_name"],
                data.get("rule_id"),
                data.get("rule_name", ""),
                data["started_at"],
                data.get("reason", ""),
                data["clip_path"],
                data.get("thumb_path", ""),
                float(data.get("peak_ratio", 0)),
            ),
        )
        return int(cur.lastrowid)


def finish_event(event_id: int, ended_at: str, peak_ratio: float, reason: str) -> None:
    with _lock, connect() as conn:
        conn.execute(
            "UPDATE events SET ended_at = ?, peak_ratio = ?, reason = ? WHERE id = ?",
            (ended_at, peak_ratio, reason, event_id),
        )


def set_clip_path(event_id: int, clip_path: str) -> None:
    with _lock, connect() as conn:
        conn.execute("UPDATE events SET clip_path = ? WHERE id = ?", (clip_path, event_id))


def find_event_id_by_filename(name: str) -> int | None:
    with _lock, connect() as conn:
        rows = conn.execute(
            "SELECT id, clip_path FROM events WHERE clip_path IS NOT NULL AND clip_path NOT LIKE 'github:%'"
        ).fetchall()
    for row in rows:
        if Path(row["clip_path"]).name == name:
            return int(row["id"])
    return None


def list_events(limit: int = 50) -> list[dict]:
    with _lock, connect() as conn:
        rows = conn.execute(
            "SELECT * FROM events ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(row) for row in rows]


def get_event(event_id: int) -> dict | None:
    with _lock, connect() as conn:
        return _row(conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone())


def seed_if_empty() -> None:
    if list_cameras():
        return
    bridge = create_camera(
        {
            "name": "Мостик",
            "location": "ходовая рубка",
            "source_type": "synthetic",
            "source_uri": "bridge",
        }
    )
    deck = create_camera(
        {
            "name": "Палуба",
            "location": "главная палуба, бак",
            "source_type": "synthetic",
            "source_uri": "deck",
        }
    )
    gangway = create_camera(
        {
            "name": "Трап",
            "location": "правый борт",
            "source_type": "synthetic",
            "source_uri": "gangway",
        }
    )
    engine = create_camera(
        {
            "name": "Машинное",
            "location": "машинное отделение",
            "source_type": "synthetic",
            "source_uri": "engine",
        }
    )
    create_rule(
        {
            "name": "Трап: проход",
            "camera_id": gangway["id"],
            "match_mode": "all",
            "conditions": [
                {"type": "armed"},
                {"type": "motion", "min_ratio": 0.02},
            ],
        }
    )
    create_rule(
        {
            "name": "Палуба только у причала",
            "camera_id": deck["id"],
            "match_mode": "all",
            "conditions": [
                {"type": "armed"},
                {"type": "motion", "min_ratio": 0.02},
                {"type": "speed", "op": "lt", "knots": 3},
            ],
        }
    )
    create_rule(
        {
            "name": "Мостик: человек у пульта",
            "camera_id": bridge["id"],
            "match_mode": "all",
            "conditions": [
                {"type": "armed"},
                {
                    "type": "motion",
                    "min_ratio": 0.04,
                    "zone": {"x": 0.08, "y": 0.4, "w": 0.84, "h": 0.5},
                },
            ],
        }
    )
    create_rule(
        {
            "name": "Машинное: аномалия",
            "camera_id": engine["id"],
            "match_mode": "all",
            "conditions": [
                {"type": "armed"},
                {"type": "motion", "min_ratio": 0.08},
            ],
            "cooldown_sec": 12,
        }
    )
