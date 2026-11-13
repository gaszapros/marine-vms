"""Общий список камер флота: один файл проекта для всех устройств."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

ROLES = ("port-bow", "starboard-bow", "port-stern", "starboard-stern")
OWNER = "gaszapros"


def normalize_fleet(data: object) -> dict:
    if not isinstance(data, dict):
        raise ValueError("список камер повреждён")
    vessels = data.get("vessels")
    if not isinstance(vessels, list) or not 1 <= len(vessels) <= 12:
        raise ValueError("нужно от 1 до 12 судов")
    clean = []
    seen = set()
    for vessel in vessels:
        if not isinstance(vessel, dict):
            raise ValueError("судно повреждено")
        ident = _token(vessel.get("id"), 64)
        name = _text(vessel.get("name"), 80)
        if not ident or not name or ident in seen:
            raise ValueError("у судна нужны свои имя и номер")
        seen.add(ident)
        cameras = vessel.get("cameras")
        if not isinstance(cameras, dict):
            raise ValueError("у судна нет камер")
        slots = {}
        for role in ROLES:
            slot = cameras.get(role)
            if not isinstance(slot, dict):
                raise ValueError("не хватает камеры")
            slots[role] = {"src": _src(slot.get("src")), "place": _text(slot.get("place", ""), 120, empty=True)}
        clean.append({"id": ident, "name": name, "cameras": slots})
    selected = data.get("selected")
    if not isinstance(selected, str) or selected not in seen:
        selected = clean[0]["id"]
    view = data.get("view")
    if view not in ("fleet", "stand"):
        view = "fleet"
    saved_at = data.get("savedAt", 0)
    if isinstance(saved_at, bool) or not isinstance(saved_at, (int, float)):
        saved_at = 0
    saved_at = int(saved_at)
    if saved_at < 0 or saved_at > 10**13:
        raise ValueError("время сохранения повреждено")
    return {"view": view, "selected": selected, "savedAt": saved_at, "vessels": clean}


def fleet_from_issue(body: str) -> dict:
    text = body or ""
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("в сообщении нет списка камер")
    return normalize_fleet(json.loads(text[start : end + 1]))


def write_fleet(path: Path, fleet: dict) -> None:
    path.write_text(json.dumps(fleet, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def publish_working_tree(root: Path) -> None:
    """Коммитит только static/fleet.json и отправляет его на GitHub."""
    status = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
    dirty = [line[3:] for line in status.stdout.splitlines() if line[3:] != "static/fleet.json"]
    if dirty:
        raise RuntimeError("в проекте есть другие правки")
    log = subprocess.run(
        ["git", "log", "-1", "--format=%an%x00%ae"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
    name, email = log.stdout.strip().split("\x00", 1)
    subprocess.run(["git", "add", "--", "static/fleet.json"], cwd=root, check=True)
    staged = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=root)
    if staged.returncode == 0:
        return
    subprocess.run(
        ["git", "-c", f"user.name={name}", "-c", f"user.email={email}", "commit", "-m", "Update vessel camera links."],
        cwd=root,
        check=True,
    )
    subprocess.run(["git", "push", "origin", "HEAD"], cwd=root, check=True)
    subprocess.run(["gh", "workflow", "run", "Pages", "--ref", "main"], cwd=root, check=True)


def _token(value: object, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    text = value.strip()
    if not text or len(text) > limit:
        return ""
    if any(char.isspace() for char in text):
        return ""
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:_-")
    if any(char not in allowed for char in text):
        return ""
    return text


def _text(value: object, limit: int, empty: bool = False) -> str:
    if not isinstance(value, str):
        return "" if empty else ""
    text = " ".join(value.split())
    if len(text) > limit:
        raise ValueError("слишком длинное название")
    if not text and not empty:
        return ""
    return text


def _src(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("адрес камеры повреждён")
    text = value.strip()
    if len(text) > 2000 or any(char.isspace() for char in text):
        raise ValueError("адрес камеры слишком длинный")
    if not text:
        return ""
    lowered = text.lower()
    if not lowered.startswith(("http://", "https://", "rtsp://", "rtsps://")):
        raise ValueError("адрес камеры должен начинаться с http, https или rtsp")
    return text


def main() -> None:
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    note = Path("fleet-note.txt")
    note.write_text("Сохранение не выполнено.\n", encoding="utf-8")
    actor = os.environ.get("ACTOR") or event.get("sender", {}).get("login", "")
    if actor != OWNER:
        note.write_text("Сохранять камеры может только владелец проекта.\n", encoding="utf-8")
        _output("skip")
        return
    try:
        fleet = fleet_from_issue(event["issue"]["body"])
    except (ValueError, json.JSONDecodeError, KeyError):
        note.write_text("Сообщение не содержит список камер.\n", encoding="utf-8")
        _output("skip")
        return
    write_fleet(Path("static/fleet.json"), fleet)
    note.write_text("Ссылки камер сохранены в проекте.\n", encoding="utf-8")
    _output("ok")


def _output(status: str) -> None:
    handle = os.environ.get("GITHUB_OUTPUT")
    if not handle:
        return
    with open(handle, "a", encoding="utf-8") as stream:
        stream.write(f"status={status}\n")


if __name__ == "__main__":
    main()
