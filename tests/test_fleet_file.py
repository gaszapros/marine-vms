import json
import unittest

from app.fleet_file import fleet_from_issue, normalize_fleet


def sample() -> dict:
    return {
        "view": "stand",
        "selected": "vessel-1",
        "savedAt": 10,
        "vessels": [
            {
                "id": "vessel-1",
                "name": "SHIP Name",
                "cameras": {
                    "port-bow": {"src": "https://example.test/a.m3u8", "place": "Порт"},
                    "starboard-bow": {"src": "rtsp://cam/live", "place": ""},
                    "port-stern": {"src": "", "place": ""},
                    "starboard-stern": {"src": "https://youtu.be/abc", "place": ""},
                },
            }
        ],
    }


class FleetFileTest(unittest.TestCase):
    def test_keeps_four_slots(self):
        fleet = normalize_fleet(sample())
        self.assertEqual(fleet["view"], "stand")
        self.assertEqual(fleet["vessels"][0]["cameras"]["port-stern"]["src"], "")
        self.assertEqual(fleet["vessels"][0]["cameras"]["starboard-bow"]["src"], "rtsp://cam/live")

    def test_reads_issue_body(self):
        body = "черновик\n" + json.dumps(sample(), ensure_ascii=False)
        self.assertEqual(fleet_from_issue(body)["selected"], "vessel-1")

    def test_rejects_script_url(self):
        data = sample()
        data["vessels"][0]["cameras"]["port-bow"]["src"] = "javascript:alert(1)"
        with self.assertRaises(ValueError):
            normalize_fleet(data)

    def test_rejects_empty_list(self):
        with self.assertRaises(ValueError):
            normalize_fleet({"vessels": []})


if __name__ == "__main__":
    unittest.main()
