from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from atlas_admin_server import (  # noqa: E402
    classify_service,
    filter_visits,
    is_page_visit,
    issue_session_token,
    make_password_hash,
    read_recent_records,
    summarize_visits,
    verify_password,
    verify_session_token,
)


class PasswordTests(unittest.TestCase):
    def test_password_hash_round_trip(self) -> None:
        encoded = make_password_hash("correct horse battery staple", iterations=100_000, salt=b"0123456789abcdef")
        self.assertTrue(verify_password("correct horse battery staple", encoded))
        self.assertFalse(verify_password("wrong", encoded))

    def test_session_signature_and_expiry(self) -> None:
        secret = b"s" * 48
        token = issue_session_token(secret, ttl_seconds=60, now=1_000)
        self.assertIsNotNone(verify_session_token(secret, token, now=1_010))
        self.assertIsNone(verify_session_token(secret, token, now=1_061))
        self.assertIsNone(verify_session_token(b"x" * 48, token, now=1_010))


class VisitTests(unittest.TestCase):
    def test_service_classification(self) -> None:
        self.assertEqual(classify_service("/"), ("root", "Atlas Management"))
        self.assertEqual(classify_service("/sketchfy/room/abc"), ("sketchfy", "Sketchfy Atlas"))
        self.assertEqual(classify_service("/archive/foo"), ("archive", "Archive"))
        self.assertIsNone(classify_service("/api/health"))

    def test_page_visit_rejects_assets(self) -> None:
        page = {
            "time": "2026-08-25T18:00:00+09:00",
            "ip": "203.0.113.10",
            "method": "GET",
            "uri": "/sketchfy/room/abc",
            "status": 200,
            "fetch_dest": "document",
            "content_type": "text/html",
        }
        asset = dict(page, uri="/sketchfy/assets/app.js", fetch_dest="script", content_type="application/javascript")
        self.assertTrue(is_page_visit(page))
        self.assertFalse(is_page_visit(asset))

    def test_filter_and_summary(self) -> None:
        now = datetime.now(timezone.utc)
        recent = now.isoformat()
        records = [
            {
                "time": recent,
                "ip": "203.0.113.10",
                "method": "GET",
                "uri": "/",
                "status": 200,
                "fetch_dest": "document",
                "content_type": "text/html",
                "user_agent": "browser-a",
            },
            {
                "time": recent,
                "ip": "203.0.113.10",
                "method": "GET",
                "uri": "/travel/",
                "status": 200,
                "fetch_dest": "document",
                "content_type": "text/html",
                "user_agent": "browser-a",
            },
            {
                "time": recent,
                "ip": "198.51.100.20",
                "method": "GET",
                "uri": "/health/",
                "status": 200,
                "fetch_dest": "document",
                "content_type": "text/html",
                "user_agent": "browser-b",
            },
        ]
        visits = filter_visits(records, service="travel", limit=20)
        self.assertEqual(len(visits), 1)
        self.assertEqual(visits[0]["ip"], "203.0.113.10")

        summary = summarize_visits(records, hours=24)
        self.assertEqual(summary["visits"], 3)
        self.assertEqual(summary["unique_ips"], 2)
        self.assertEqual(summary["repeat_ips"], 1)

    def test_json_log_reading_newest_first(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "access.jsonl"
            older = {
                "time": (datetime.now(timezone.utc) - timedelta(minutes=2)).isoformat(),
                "ip": "203.0.113.1",
                "method": "GET",
                "uri": "/",
                "status": 200,
            }
            newer = dict(older, ip="203.0.113.2", time=datetime.now(timezone.utc).isoformat())
            path.write_text(json.dumps(older) + "\n" + json.dumps(newer) + "\n", encoding="utf-8")
            records = read_recent_records(path)
            self.assertEqual(records[0]["ip"], "203.0.113.2")
            self.assertEqual(records[1]["ip"], "203.0.113.1")

    def test_rotated_log_is_included(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "access.jsonl"
            current = {
                "time": datetime.now(timezone.utc).isoformat(),
                "ip": "203.0.113.2",
                "method": "GET",
                "uri": "/",
                "status": 200,
            }
            rotated = dict(current, ip="203.0.113.1", time=(datetime.now(timezone.utc) - timedelta(days=1)).isoformat())
            path.write_text(json.dumps(current) + "\n", encoding="utf-8")
            Path(f"{path}.1").write_text(json.dumps(rotated) + "\n", encoding="utf-8")
            records = read_recent_records(path)
            self.assertEqual([item["ip"] for item in records[:2]], ["203.0.113.2", "203.0.113.1"])


if __name__ == "__main__":
    unittest.main()
