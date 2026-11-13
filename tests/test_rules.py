import unittest
from datetime import datetime

import numpy as np

from app.rules import evaluate_rule, mask_ratio, schedule_matches, speed_matches
from app.vehicles import box_is_freight, keep_freight


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

    def test_heavy_rule_never_starts_recording(self):
        rule = {"match_mode": "all", "conditions": [{"type": "heavy"}]}
        ctx = {"now": datetime(2026, 11, 10, 13, 0), "speed_kn": 0.3, "armed": True}
        fired, note = evaluate_rule(rule, ctx, [])
        self.assertFalse(fired)
        self.assertIn("без записи", note)
        rule["match_mode"] = "any"
        fired_any, _ = evaluate_rule(rule, ctx, [])
        self.assertFalse(fired_any)

    def test_keep_freight_skips_cars_and_buses(self):
        rows = np.array(
            [
                [10, 20, 40, 30, 0.9, 2],
                [100, 80, 50, 40, 0.8, 7],
                [0, 0, 620, 340, 0.95, 5],
                [200, 90, 20, 16, 0.9, 7],
            ],
            np.float32,
        )
        marks = keep_freight(rows, (360, 640), 1.0)
        self.assertEqual(marks, [(100, 80, 50, 40, "грузовой")])

    def test_each_camera_formula(self):
        self.assertFalse(box_is_freight("cuomo", 0.7, 0.05, 0.03, 0.1, 0.7, 0))
        self.assertTrue(box_is_freight("cuomo", 0.7, 0.1, 0.07, 0.1, 0.2, 0))
        self.assertTrue(box_is_freight("i66-61", 0.38, 0.084, 0.06, 0.25, 0, 0.05))
        self.assertTrue(box_is_freight("i10", 0.38, 0.074, 0.09, 0.34, 0, 0))
        self.assertFalse(box_is_freight("i10", 0.33, 0.038, 0.05, 0.01, 0.71, 0))
        self.assertFalse(box_is_freight("i10-henderson", 0.31, 0.071, 0.048, 0.2, 0.28, 0))
        self.assertFalse(box_is_freight("i10-scott", 0.8, 0.274, 0.056, 0, 0.69, 0))
        self.assertFalse(box_is_freight("i10-lafayette", 0.94, 0.115, 0.103, 0, 0.3, 0))

    def test_zone_ratio(self):
        mask = np.zeros((100, 100), np.uint8)
        mask[10:30, 10:30] = 255
        whole = mask_ratio(mask, None)
        zone = mask_ratio(mask, {"x": 0.0, "y": 0.0, "w": 0.4, "h": 0.4})
        self.assertAlmostEqual(whole, 0.04)
        self.assertGreater(zone, whole)


if __name__ == "__main__":
    unittest.main()
