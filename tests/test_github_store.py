import io
import json
import tempfile
import unittest
import urllib.error
import urllib.parse
from http.client import HTTPMessage
from pathlib import Path

from app.github_store import GithubStore, github_page_url, materialize_clip, parse_ref


def _error(code: int, url: str, body: bytes = b'{"message":"no"}'):
    return urllib.error.HTTPError(url, code, "err", HTTPMessage(), io.BytesIO(body))


class _Response:
    def __init__(self, payload, status=200, raw=False):
        self.status = status
        self._raw = payload if raw else json.dumps(payload).encode("utf-8")

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class FakeGitHub:
    def __init__(self):
        self.assets = {}
        self.uploads = []
        self.release_id = None
        self.next_id = 40
        self.fail_upload_once = False

    def __call__(self, request, timeout=None):
        url = request.full_url
        method = request.method
        if method == "GET" and "/releases/tags/" in url:
            if self.release_id is None:
                raise _error(404, url)
            return _Response({"id": self.release_id, "tag_name": "recordings"})
        if method == "POST" and url.endswith("/releases"):
            self.release_id = 7
            return _Response({"id": 7, "tag_name": "recordings"}, status=201)
        if method == "GET" and "/releases/assets/" in url:
            return _Response(b"AVI-DATA", raw=True)
        if method == "GET" and "/assets?" in url:
            items = [{"id": asset_id, "name": name} for name, asset_id in self.assets.items()]
            return _Response(items)
        if method == "POST" and url.startswith("https://uploads.github.com/"):
            name = urllib.parse.unquote(url.split("name=", 1)[1])
            if self.fail_upload_once:
                self.fail_upload_once = False
                self.assets[name] = 55
                raise _error(422, url, b'{"message":"Validation Failed","errors":[{"code":"already_exists"}]}')
            self.next_id += 1
            self.assets[name] = self.next_id
            self.uploads.append((name, request.data))
            return _Response({"id": self.next_id, "name": name}, status=201)
        raise AssertionError(f"{method} {url}")


class GithubStoreTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeGitHub()
        self.store = GithubStore(opener=self.fake, token_provider=lambda: "test-token")

    def test_publish_creates_release_and_uploads_bytes(self):
        with tempfile.NamedTemporaryFile(suffix=".avi", delete=False) as handle:
            handle.write(b"frame-bytes")
            path = Path(handle.name)
        self.addCleanup(path.unlink, missing_ok=True)
        ref = self.store.publish(path)
        self.assertEqual(self.fake.release_id, 7)
        self.assertEqual(self.fake.uploads, [(path.name, b"frame-bytes")])
        self.assertEqual(ref, f"github:{self.fake.assets[path.name]}/{path.name}")
        self.assertEqual(self.store.publish(path), ref)
        self.assertEqual(len(self.fake.uploads), 1)

    def test_existing_asset_is_not_uploaded_again(self):
        self.fake.release_id = 7
        self.fake.assets["cam5_20261109_220000.avi"] = 12
        with tempfile.NamedTemporaryFile(suffix=".avi", delete=False) as handle:
            handle.write(b"frame-bytes")
            source = Path(handle.name)
        self.addCleanup(source.unlink, missing_ok=True)
        path = source.with_name("cam5_20261109_220000.avi")
        path.write_bytes(b"frame-bytes")
        self.addCleanup(path.unlink, missing_ok=True)
        self.assertEqual(self.store.publish(path), "github:12/cam5_20261109_220000.avi")
        self.assertEqual(self.fake.uploads, [])

    def test_already_exists_uses_the_asset_id(self):
        self.fake.fail_upload_once = True
        with tempfile.NamedTemporaryFile(suffix=".avi", delete=False) as handle:
            handle.write(b"frame-bytes")
            path = Path(handle.name)
        self.addCleanup(path.unlink, missing_ok=True)
        self.assertEqual(self.store.publish(path), f"github:55/{path.name}")
        self.assertEqual(self.fake.uploads, [])

    def test_page_url_and_playback_download(self):
        self.assertIsNone(parse_ref(r"C:\data\media\cam5.avi"))
        self.assertEqual(parse_ref("github:55/cam5.avi"), (55, "cam5.avi"))
        self.assertEqual(
            github_page_url("github:55/cam5.avi"),
            "https://github.com/gaszapros/marine-vms/releases/download/recordings/cam5.avi",
        )
        path, temporary = materialize_clip({"clip_path": "github:55/cam5.avi"}, self.store)
        self.assertTrue(temporary)
        try:
            self.assertEqual(path.read_bytes(), b"AVI-DATA")
        finally:
            path.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
