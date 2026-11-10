"""Чистая оценка правил записи. Без камер и без OpenCV — её покрывают тесты."""

from __future__ import annotations

from datetime import datetime, time
from typing import Any

import numpy as np


def mask_ratio(mask: np.ndarray, zone: dict | None) -> float:
    if mask.size == 0:
        return 0.0
    height, width = mask.shape[:2]
    area = mask
    if zone:
        x1 = min(width, max(0, int(float(zone["x"]) * width)))
        y1 = min(height, max(0, int(float(zone["y"]) * height)))
        x2 = min(width, max(x1 + 1, int((float(zone["x"]) + float(zone["w"])) * width)))
        y2 = min(height, max(y1 + 1, int((float(zone["y"]) + float(zone["h"])) * height)))
        area = mask[y1:y2, x1:x2]
    if area.size == 0:
        return 0.0
    return float(np.count_nonzero(area)) / float(area.size)


def _parse_hhmm(value: str) -> time:
    hour, minute = value.split(":")
    return time(int(hour), int(minute))


def schedule_matches(cond: dict, now: datetime) -> bool:
    days = cond.get("days", list(range(7)))
    if now.weekday() not in [int(day) for day in days]:
        return False
    start = _parse_hhmm(cond["start"])
    end = _parse_hhmm(cond["end"])
    current = now.time().replace(second=0, microsecond=0)
    if start <= end:
        return start <= current <= end
    return current >= start or current <= end


def speed_matches(cond: dict, speed_kn: float) -> bool:
    op = cond.get("op", "gt")
    knots = float(cond["knots"])
    upper = cond.get("knots_max")
    if op == "gt":
        return speed_kn > knots
    if op == "gte":
        return speed_kn >= knots
    if op == "lt":
        return speed_kn < knots
    if op == "lte":
        return speed_kn <= knots
    if op == "between":
        return knots <= speed_kn <= float(upper)
    return False


def eval_condition(cond: dict, ctx: dict[str, Any]) -> tuple[bool, str]:
    kind = cond.get("type")
    if kind == "motion":
        ratio = float(ctx["ratio"])
        need = float(cond.get("min_ratio", 0.02))
        met = ratio >= need
        where = "в зоне" if cond.get("zone") else "в кадре"
        return met, f"движение {ratio * 100:.1f}% {where}, порог {need * 100:.1f}%"
    if kind == "schedule":
        met = schedule_matches(cond, ctx["now"])
        return met, f"окно {cond.get('start')}–{cond.get('end')}" + ("" if met else " не активно")
    if kind == "speed":
        speed = float(ctx["speed_kn"])
        met = speed_matches(cond, speed)
        extra = f"…{cond.get('knots_max')}" if cond.get("op") == "between" else ""
        return met, f"скорость {speed:.1f} уз {cond.get('op')} {cond.get('knots')}{extra}"
    if kind == "armed":
        met = bool(ctx["armed"])
        return met, "вахта принята" if met else "вахта снята"
    if kind == "color":
        ratio = float(ctx.get("color_ratio") or 0)
        need = float(cond.get("min_ratio", 0.004))
        met = cond.get("color", "red") == "red" and ratio >= need
        where = "в зоне" if cond.get("zone") else "в кадре"
        return met, f"красный автомобиль {ratio * 100:.1f}% {where}, порог {need * 100:.1f}%"
    if kind == "heavy":
        return False, "не легковые: только показ, без записи"
    return False, f"неизвестное условие {kind}"


def evaluate_rule(
    rule: dict,
    ctx: dict[str, Any],
    ratios: list[float],
    color_ratios: list[float] | None = None,
) -> tuple[bool, str]:
    """ctx: now, speed_kn, armed. ratios — движение, color_ratios — цвет, по порядку условий."""
    conditions = rule.get("conditions") or []
    if not conditions:
        return False, "в правиле нет условий"
    color_ratios = color_ratios or []

    notes: list[str] = []
    flags: list[bool] = []
    motion_index = 0
    color_index = 0
    for cond in conditions:
        local = dict(ctx)
        if cond.get("type") == "motion":
            local["ratio"] = ratios[motion_index] if motion_index < len(ratios) else 0.0
            motion_index += 1
        elif cond.get("type") == "color":
            local["color_ratio"] = color_ratios[color_index] if color_index < len(color_ratios) else 0.0
            color_index += 1
        met, note = eval_condition(cond, local)
        flags.append(met)
        notes.append(("да" if met else "нет") + ": " + note)

    match_mode = rule.get("match_mode", "all")
    if match_mode == "any":
        fired = any(flags)
    else:
        fired = all(flags)
    return fired, "; ".join(notes)
