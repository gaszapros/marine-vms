import unittest

from app.detectors import MotionDetector
from app.rules import mask_ratio
from app.sources import render


class ScenarioTests(unittest.TestCase):
    def test_gangway_walk_crosses_threshold(self):
        detector = MotionDetector()
        for step in range(12):
            detector.feed(render("gangway", step * 0.2))
        ratios = [mask_ratio(detector.feed(render("gangway", t)), None) for t in (7, 8, 9, 10)]
        self.assertGreater(max(ratios), 0.02)

    def test_engine_needle_stays_under_anomaly(self):
        detector = MotionDetector()
        for step in range(16):
            detector.feed(render("engine", step * 0.2))
        ratio = mask_ratio(detector.feed(render("engine", 4.0)), None)
        self.assertLess(ratio, 0.08)

    def test_engine_plume_is_anomaly(self):
        detector = MotionDetector()
        for step in range(10):
            detector.feed(render("engine", 30 + step * 0.2))
        ratio = mask_ratio(detector.feed(render("engine", 42)), None)
        self.assertGreater(ratio, 0.08)

    def test_deck_motion_exists(self):
        detector = MotionDetector()
        for step in range(10):
            detector.feed(render("deck", step * 0.2))
        ratio = mask_ratio(detector.feed(render("deck", 8)), None)
        self.assertGreater(ratio, 0.02)


if __name__ == "__main__":
    unittest.main()
