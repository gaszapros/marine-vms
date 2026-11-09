"""Клипы уходят в релиз GitHub и не остаются на этом компьютере."""

from __future__ import annotations

import json
import logging
import os
import queue
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from app.config import GITHUB_RECORDINGS_TAG, GITHUB_REPO, MEDIA
from app import db

logger = logging.getLogger("marine")

API = "https://api.github.com"
_MAX_ASSET = 2 * 1024 * 1024 * 1024
_ATTEMPTS = 5


class GithubError(Exception):
    def __init__(self, code: int, detail: str):
        super().__init__(f"GitHub {code}: {detail[:300]}")
        self.code = code
        self.detail = detail


class _StripAuthRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new_req = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new_req is not None:
            new_req.remove_header("Authorization")
        return new_req


def _default_opener():
    return urllib.request.build_opener(_StripAuthRedirect).open


def gh_executable() -> Path:
    found = shutil.which("gh")
    if found:
        return Path(found)
    root = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages"
    matches = sorted(root.glob("GitHub.cli*/bin/gh.exe")) if root.exists() else []
    if matches:
        return matches[0]
    raise RuntimeError("GitHub CLI не найден")


def read_gh_token() -> str:
    completed = subprocess.run(
        [str(gh_executable()), "auth", "token"],
        check=False,
        capture_output=True,
        text=True,
    )
    token = (completed.stdout or "").strip()
    if completed.returncode != 0 or not token:
        raise RuntimeError("нет входа в GitHub CLI")
    return token


def parse_ref(clip_path: str | None) -> tuple[int, str] | None:
    if not clip_path or not clip_path.startswith("github:"):
        return None
    asset_id, _, name = clip_path[len("github:") :].partition("/")
    if not asset_id.isdigit() or not name or "/" in name or "\\" in name:
        return None
    return int(asset_id), name


def clip_ref(asset_id: int, name: str) -> str:
    return f"github:{asset_id}/{name}"


def github_page_url(clip_path: str | None) -> str | None:
    parsed = parse_ref(clip_path)
    if parsed is None:
        return None
    _asset_id, name = parsed
    quoted = urllib.parse.quote(name)
    return f"https://github.com/{GITHUB_REPO}/releases/download/{GITHUB_RECORDINGS_TAG}/{quoted}"


def present_event(event: dict) -> dict:
    url = github_page_url(event.get("clip_path"))
    if url:
        event["github_url"] = url
    return event


class GithubStore:
    def __init__(self, opener=None, token_provider=None):
        self.repo = GITHUB_REPO
        self.tag = GITHUB_RECORDINGS_TAG
        self._opener = opener or _default_opener()
        self._token_provider = token_provider or read_gh_token
        self._token_value: str | None = None
        self.release_id: int | None = None
        self._index: dict[str, int] | None = None
        self._lock = threading.Lock()

    def _token(self) -> str:
        if self._token_value is None:
            self._token_value = self._token_provider()
        return self._token_value

    def _open(self, method: str, url: str, data: bytes | None = None, accept: str | None = None, content_type: str | None = None, timeout: int = 180):
        headers = {
            "Authorization": f"Bearer {self._token()}",
            "Accept": accept or "application/vnd.github+json",
            "User-Agent": "marine-vms",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if content_type:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with self._opener(request, timeout=timeout) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as exc:
            raw = exc.read() if exc.fp is not None else b""
            detail = raw.decode("utf-8", "replace")
            raise GithubError(exc.code, detail) from None

    def _json(self, method: str, url: str, body: dict | None = None, timeout: int = 180):
        data = None if body is None else json.dumps(body).encode("utf-8")
        content_type = "application/json" if data is not None else None
        status, raw = self._open(method, url, data, content_type=content_type, timeout=timeout)
        if not raw:
            return status, {}
        return status, json.loads(raw.decode("utf-8"))

    def _ensure_release(self) -> int:
        if self.release_id is not None:
            return self.release_id
        tag_url = f"{API}/repos/{self.repo}/releases/tags/{self.tag}"
        try:
            _, payload = self._json("GET", tag_url)
        except GithubError as exc:
            if exc.code != 404:
                raise
            payload = None
        if payload is None:
            try:
                _, payload = self._json(
                    "POST",
                    f"{API}/repos/{self.repo}/releases",
                    {
                        "tag_name": self.tag,
                        "target_commitish": "main",
                        "name": "Записи камер",
                        "body": "Клипы Marine VMS. В ветке main только код.",
                    },
                )
            except GithubError as exc:
                if exc.code != 422:
                    raise
                _, payload = self._json("GET", tag_url)
        self.release_id = int(payload["id"])
        return self.release_id

    def _load_index(self) -> dict[str, int]:
        release_id = self._ensure_release()
        found: dict[str, int] = {}
        page = 1
        while True:
            _, payload = self._json(
                "GET",
                f"{API}/repos/{self.repo}/releases/{release_id}/assets?per_page=100&page={page}",
            )
            if not payload:
                break
            for asset in payload:
                found[asset["name"]] = int(asset["id"])
            if len(payload) < 100:
                break
            page += 1
        self._index = found
        return found

    def publish(self, path: Path) -> str:
        path = Path(path)
        name = path.name
        if not name or "/" in name or "\\" in name or name.startswith("."):
            raise GithubError(400, "некорректное имя клипа")
        size = path.stat().st_size
        if size <= 0 or size >= _MAX_ASSET:
            raise GithubError(400, "пустой клип или файл больше 2 ГБ")
        with self._lock:
            index = self._index if self._index is not None else self._load_index()
            if name in index:
                return clip_ref(index[name], name)
            release_id = self._ensure_release()
            quoted = urllib.parse.quote(name)
            url = f"https://uploads.github.com/repos/{self.repo}/releases/{release_id}/assets?name={quoted}"
            try:
                _status, raw = self._open(
                    "POST",
                    url,
                    path.read_bytes(),
                    content_type="video/x-msvideo",
                    timeout=300,
                )
                asset = json.loads(raw.decode("utf-8"))
            except GithubError as exc:
                if exc.code != 422 or "already_exists" not in exc.detail:
                    raise
                index = self._load_index()
                if name not in index:
                    raise
                return clip_ref(index[name], name)
            asset_id = int(asset["id"])
            index[name] = asset_id
            return clip_ref(asset_id, name)

    def download(self, clip_path: str, dest: Path) -> None:
        parsed = parse_ref(clip_path)
        if parsed is None:
            raise GithubError(400, "это не ссылка на клип")
        asset_id, _name = parsed
        _status, raw = self._open(
            "GET",
            f"{API}/repos/{self.repo}/releases/assets/{asset_id}",
            accept="application/octet-stream",
            timeout=300,
        )
        dest.write_bytes(raw)


def materialize_clip(event: dict, store: GithubStore | None = None) -> tuple[Path | None, bool]:
    raw = event.get("clip_path") or ""
    if raw.startswith("github:"):
        target = store or globals()["store"]
        handle, name = tempfile.mkstemp(prefix="marine-play-", suffix=".avi")
        os.close(handle)
        dest = Path(name)
        try:
            target.download(raw, dest)
        except Exception:
            dest.unlink(missing_ok=True)
            raise
        return dest, True
    path = Path(raw) if raw else None
    if path is not None and path.is_file():
        return path, False
    return None, False


class Archive:
    def __init__(self, store: GithubStore | None = None):
        self.store = store or GithubStore()
        self.queue: queue.Queue[tuple[int | None, Path]] = queue.Queue()
        self.pending: set[str] = set()
        self.failures: dict[str, int] = {}
        self.lock = threading.Lock()
        self.thread: threading.Thread | None = None

    def start(self) -> None:
        with self.lock:
            if self.thread is not None and self.thread.is_alive():
                return
            self.thread = threading.Thread(target=self._loop, name="vms-github", daemon=True)
            self.thread.start()

    def enqueue(self, event_id: int | None, path: Path) -> None:
        path = Path(path)
        with self.lock:
            if path.name in self.pending:
                return
            self.pending.add(path.name)
        self.queue.put((event_id, path))

    def _loop(self) -> None:
        while True:
            try:
                event_id, path = self.queue.get(timeout=1)
            except queue.Empty:
                continue
            self._one(event_id, path)

    def scan(self) -> None:
        if not MEDIA.exists():
            return
        files = sorted(
            (path for path in MEDIA.glob("*.avi") if path.is_file()),
            key=lambda item: item.stat().st_mtime,
            reverse=True,
        )
        logger.info("локальных клипов к отправке на GitHub: %s", len(files))
        for path in files:
            self.enqueue(db.find_event_id_by_filename(path.name), path)

    def _retry(self, path: Path) -> bool:
        count = self.failures.get(path.name, 0) + 1
        self.failures[path.name] = count
        logger.exception("не удалось отправить клип %s, попытка %s", path.name, count)
        if count >= _ATTEMPTS:
            logger.error("клип остаётся на компьютере: %s", path.name)
            return False
        time.sleep(min(30, 2**count))
        return True

    def _one(self, event_id: int | None, path: Path) -> None:
        requeue = False
        try:
            if not path.is_file():
                return
            ref = self.store.publish(path)
            if event_id is None:
                event_id = db.find_event_id_by_filename(path.name)
            if event_id is not None:
                db.set_clip_path(event_id, ref)
            path.unlink(missing_ok=True)
            self.failures.pop(path.name, None)
            logger.info("клип на GitHub: %s", path.name)
        except GithubError as exc:
            if exc.code == 400:
                logger.error("клип остаётся на компьютере: %s (%s)", path.name, exc)
            else:
                requeue = self._retry(path)
        except Exception:
            requeue = self._retry(path)
        finally:
            if requeue:
                self.queue.put((event_id, path))
            else:
                with self.lock:
                    self.pending.discard(path.name)


store = GithubStore()
archive = Archive(store)
