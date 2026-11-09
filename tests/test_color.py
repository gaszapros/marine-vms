import unittest
from datetime import datetime

import numpy as np

from app.detectors import moving_color_mask
from app.rules import evaluate_rule, mask_ratio


def _road() -> np.ndarray:
    frame = np.full((360, 640, 3), (90, 90, 90), np.uint8)
    return frame


def _motion_on(frame: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray:
    mask = np.zeros(frame.shape[:2], np.uint8)
    x, y, w, h = box
    mask[y : y + h, x : x + w] = 255
    return mask


class RedVehicleTests(unittest.TestCase):
    def test_moving_red_car_counts(self):
        frame = _road()
        box = (250, 160, 120, 70)
        x, y, w, h = box
        frame[y : y + h, x : x + w] = (35, 35, 185)
        mask = moving_color_mask(frame, _motion_on(frame, box), "red")
        self.assertGreater(mask_ratio(mask, None), 0.004)

    def test_parked_red_car_does_not_count(self):
        frame = _road()
        box = (250, 160, 120, 70)
        x, y, w, h = box
        frame[y : y + h, x : x + w] = (35, 35, 185)
        mask = moving_color_mask(frame, np.zeros(frame.shape[:2], np.uint8), "red")
        self.assertEqual(mask_ratio(mask, None), 0.0)

    def test_taillight_and_blue_car_do_not_count(self):
        frame = _road()
        frame[200:208, 300:312] = (30, 30, 210)
        light = (300, 200, 12, 8)
        mask = moving_color_mask(frame, _motion_on(frame, light), "red")
        self.assertEqual(int(np.count_nonzero(mask)), 0)

        blue = (80, 140, 110, 60)
        x, y, w, h = blue
        frame[y : y + h, x : x + w] = (180, 70, 30)
        mask = moving_color_mask(frame, _motion_on(frame, blue), "red")
        self.assertEqual(int(np.count_nonzero(mask)), 0)

    def test_rule_requires_red_car(self):
        rule = {
            "match_mode": "all",
            "conditions": [
                {"type": "armed"},
                {"type": "color", "color": "red", "min_ratio": 0.004},
            ],
        }
        ctx = {"now": datetime(2026, 11, 9, 21, 0), "speed_kn": 0.3, "armed": True}
        quiet, _ = evaluate_rule(rule, ctx, [], [0.001])
        self.assertFalse(quiet)
        fired, reason = evaluate_rule(rule, ctx, [], [0.02])
        self.assertTrue(fired)
        self.assertIn("красный автомобиль", reason)
        disarmed, _ = evaluate_rule(rule, {**ctx, "armed": False}, [], [0.02])
        self.assertFalse(disarmed)


if __name__ == "__main__":
    unittest.main()
