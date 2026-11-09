import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
MEDIA = DATA / "media"
THUMBS = DATA / "thumbs"
DB_PATH = DATA / "marine.db"

FRAME_W = 640
FRAME_H = 360

GITHUB_REPO = os.environ.get("MARINE_GITHUB_REPO", "gaszapros/marine-vms")
GITHUB_RECORDINGS_TAG = os.environ.get("MARINE_GITHUB_TAG", "recordings")
# Клипы пока не пишутся и на GitHub не отправляются. Включить: MARINE_RECORDINGS=1
RECORDINGS_ENABLED = os.environ.get("MARINE_RECORDINGS", "0") == "1"


def ensure_dirs() -> None:
    MEDIA.mkdir(parents=True, exist_ok=True)
    THUMBS.mkdir(parents=True, exist_ok=True)
