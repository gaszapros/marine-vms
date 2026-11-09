import unittest
from datetime import datetime

import numpy as np

from app.rules import evaluate_rule, mask_ratio, schedule_matches, speed_matches


class ScheduleTests(unittest.TestCase):
    def test_overnight_window(self):
        cond = {"start": "18:00", "end": "06:00", "days": [0]}
        self.assertTrue(schedule_matches(cond, datetime(2026, 11, 9, 23, 10)))
        self.assertTrue(schedule_matches(cond, datetime(2026, 11, 9, 5, 0)))
        self.assertFalse(schedule_matches(cond, datetime(2026, 11, 9, 12, 0)))
        self.assertFalse(schedule_matches(cond, datetime(2026, 11, 10, 23, 0)))

    def test_speed(self):
        self.assertTrue(speed_matches({"op": "lt", "knots": 3}, 0.4))
        self.assertFalse(speed_matches({"op": "lt", "knots": 3}, 14))
        self.assertTrue(speed_matches({"op": "between", "knots": 4, "knots_max": 8}, 5))

    def test_all_and_any(self):
        rule = {
            "match_mode": "all",
            "conditions": [
                {"type": "armed"},
                {"type": "motion", "min_ratio": 0.02},
                {"type": "speed", "op": "lt", "knots": 3},
            ],
        }
        ctx = {"now": datetime(2026, 11, 9, 20, 0), "speed_kn": 0.3, "armed": True}
        fired, _ = evaluate_rule(rule, ctx, [0.05])
        self.assertTrue(fired)
        quiet, _ = evaluate_rule(rule, {**ctx, "speed_kn": 14}, [0.05])
        self.assertFalse(quiet)
        rule["match_mode"] = "any"
        fired_any, _ = evaluate_rule(rule, {**ctx, "armed": False, "speed_kn": 14}, [0.0])
        self.assertFalse(fired_any)
        fired_motion, _ = evaluate_rule(rule, {**ctx, "armed": False, "speed_kn": 14}, [0.2])
        self.assertTrue(fired_motion)

    def test_zone_ratio(self):
        mask = np.zeros((100, 100), np.uint8)
        mask[10:30, 10:30] = 255
        whole = mask_ratio(mask, None)
        zone = mask_ratio(mask, {"x": 0.0, "y": 0.0, "w": 0.4, "h": 0.4})
        self.assertAlmostEqual(whole, 0.04)
        self.assertGreater(zone, whole)


if __name__ == "__main__":
    unittest.main()
