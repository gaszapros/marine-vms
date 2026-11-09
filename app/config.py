from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
MEDIA = DATA / "media"
THUMBS = DATA / "thumbs"
DB_PATH = DATA / "marine.db"

FRAME_W = 640
FRAME_H = 360


def ensure_dirs() -> None:
    MEDIA.mkdir(parents=True, exist_ok=True)
    THUMBS.mkdir(parents=True, exist_ok=True)
