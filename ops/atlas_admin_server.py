#!/usr/bin/env python3
"""Atlas Management access-log admin API.

This service is designed to bind to loopback and be exposed only through nginx
under /api/atlas-admin/. It never stores plaintext passwords and reads the
separate JSON access log emitted by nginx.
"""

from __future__ import annotations

import argparse
import base64
from collections import Counter, defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import hmac
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import secrets
import sys
import threading
import time
from typing import Any, Iterable
from urllib.parse import parse_qs, urlsplit

API_PREFIX = "/api/atlas-admin"
COOKIE_NAME = "atlas_admin_session"
PASSWORD_SCHEME = "pbkdf2_sha256"
DEFAULT_ITERATIONS = 310_000
DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60
MAX_BODY_BYTES = 4096
MAX_RESULT_LIMIT = 500
DEFAULT_RESULT_LIMIT = 200
MAX_SCAN_BYTES = 16 * 1024 * 1024
MAX_SCAN_LINES = 100_000
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_MAX_FAILURES = 5

SERVICE_PREFIXES: tuple[tuple[str, str, str], ...] = (
    ("/travel/", "travel", "Travel Atlas"),
    ("/jobs/", "jobs", "Incruit Atlas"),
    ("/world/", "world", "Run Atlas"),
    ("/learn/", "learn", "Learn Atlas"),
    ("/health/", "health", "Health Atlas"),
    ("/sketchfy/", "sketchfy", "Sketchfy Atlas"),
    ("/archive/", "archive", "Archive"),
)

ASSET_SUFFIXES = {
    ".avif",
    ".css",
    ".gif",
    ".ico",
    ".jpeg",
    ".jpg",
    ".js",
    ".json",
    ".map",
    ".mjs",
    ".mp3",
    ".mp4",
    ".ogg",
    ".otf",
    ".png",
    ".svg",
    ".webm",
    ".webp",
    ".woff",
    ".woff2",
    ".xml",
}


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def make_password_hash(password: str, *, iterations: int = DEFAULT_ITERATIONS, salt: bytes | None = None) -> str:
    if not password:
        raise ValueError("password must not be empty")
    if iterations < 100_000:
        raise ValueError("iterations must be at least 100000")
    salt = salt or secrets.token_bytes(18)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"{PASSWORD_SCHEME}${iterations}${_b64url_encode(salt)}${_b64url_encode(digest)}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, iteration_text, salt_text, digest_text = encoded.split("$", 3)
        if scheme != PASSWORD_SCHEME:
            return False
        iterations = int(iteration_text)
        if iterations < 100_000 or iterations > 5_000_000:
            return False
        salt = _b64url_decode(salt_text)
        expected = _b64url_decode(digest_text)
    except (ValueError, TypeError, base64.binascii.Error):
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(actual, expected)


def issue_session_token(secret: bytes, *, ttl_seconds: int = DEFAULT_SESSION_TTL_SECONDS, now: int | None = None) -> str:
    issued = int(time.time() if now is None else now)
    payload = {
        "sub": "atlas-admin",
        "iat": issued,
        "exp": issued + ttl_seconds,
        "nonce": _b64url_encode(secrets.token_bytes(12)),
    }
    payload_raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    payload_part = _b64url_encode(payload_raw)
    signature = hmac.new(secret, payload_part.encode("ascii"), hashlib.sha256).digest()
    return f"{payload_part}.{_b64url_encode(signature)}"


def verify_session_token(secret: bytes, token: str, *, now: int | None = None) -> dict[str, Any] | None:
    try:
        payload_part, signature_part = token.split(".", 1)
        expected_sig = hmac.new(secret, payload_part.encode("ascii"), hashlib.sha256).digest()
        supplied_sig = _b64url_decode(signature_part)
        if not hmac.compare_digest(expected_sig, supplied_sig):
            return None
        payload = json.loads(_b64url_decode(payload_part).decode("utf-8"))
        current = int(time.time() if now is None else now)
        if payload.get("sub") != "atlas-admin":
            return None
        if not isinstance(payload.get("exp"), int) or payload["exp"] <= current:
            return None
        if not isinstance(payload.get("iat"), int) or payload["iat"] > current + 60:
            return None
        return payload
    except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError, base64.binascii.Error):
        return None


def classify_service(uri: str) -> tuple[str, str] | None:
    path = urlsplit(uri).path or "/"
    if path == "/" or path == "/index.html":
        return ("root", "Atlas Management")
    for prefix, service_key, label in SERVICE_PREFIXES:
        if path.startswith(prefix):
            return (service_key, label)
    return None


def is_page_visit(record: dict[str, Any]) -> bool:
    service = classify_service(str(record.get("uri", "")))
    if service is None:
        return False
    method = str(record.get("method", "GET")).upper()
    if method not in {"GET", "HEAD"}:
        return False
    try:
        status = int(record.get("status", 0))
    except (TypeError, ValueError):
        return False
    if status < 200 or status >= 400:
        return False

    fetch_dest = str(record.get("fetch_dest", "")).lower()
    content_type = str(record.get("content_type", "")).lower()
    path = urlsplit(str(record.get("uri", ""))).path
    suffix = Path(path).suffix.lower()

    if fetch_dest == "document":
        return True
    if "text/html" in content_type:
        return True
    if suffix and suffix not in {".html", ".htm"}:
        return False
    if suffix in ASSET_SUFFIXES:
        return False
    return True


def parse_timestamp(value: str) -> datetime | None:
    value = value.strip()
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _rotated_log_paths(path: Path, *, rotations: int = 14) -> list[Path]:
    candidates = [path]
    for index in range(1, rotations + 1):
        plain = Path(f"{path}.{index}")
        compressed = Path(f"{path}.{index}.gz")
        if plain.exists():
            candidates.append(plain)
        elif compressed.exists():
            candidates.append(compressed)
    return candidates


def _read_lines_newest_first(path: Path, *, max_bytes: int, max_lines: int) -> list[bytes]:
    if path.suffix == ".gz":
        lines: deque[bytes] = deque(maxlen=max_lines)
        with gzip.open(path, "rb") as handle:
            for line in handle:
                lines.append(line)
        return list(reversed(lines))

    size = path.stat().st_size
    start = max(0, size - max_bytes)
    with path.open("rb") as handle:
        handle.seek(start)
        if start:
            handle.readline()
        payload = handle.read(max_bytes)
    return list(reversed(payload.splitlines()[-max_lines:]))


def read_recent_records(
    path: Path,
    *,
    max_bytes: int = MAX_SCAN_BYTES,
    max_lines: int = MAX_SCAN_LINES,
    rotations: int = 14,
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for candidate in _rotated_log_paths(path, rotations=rotations):
        if not candidate.exists() or not candidate.is_file():
            continue
        remaining = max_lines - len(result)
        if remaining <= 0:
            break
        for raw in _read_lines_newest_first(candidate, max_bytes=max_bytes, max_lines=remaining):
            if not raw.strip():
                continue
            try:
                item = json.loads(raw.decode("utf-8", errors="replace"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if isinstance(item, dict):
                result.append(item)
                if len(result) >= max_lines:
                    return result
    return result


def filter_visits(
    records: Iterable[dict[str, Any]],
    *,
    service: str | None = None,
    ip: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = DEFAULT_RESULT_LIMIT,
) -> list[dict[str, Any]]:
    visits: list[dict[str, Any]] = []
    for record in records:
        if not is_page_visit(record):
            continue
        service_info = classify_service(str(record.get("uri", "")))
        if service_info is None:
            continue
        service_key, service_label = service_info
        if service and service_key != service:
            continue
        record_ip = str(record.get("ip", ""))
        if ip and ip not in record_ip:
            continue
        dt = parse_timestamp(str(record.get("time", "")))
        if since and (dt is None or dt < since):
            continue
        if until and (dt is None or dt > until):
            continue
        visits.append(
            {
                "time": str(record.get("time", "")),
                "ip": record_ip,
                "service": service_key,
                "service_label": service_label,
                "uri": str(record.get("uri", "")),
                "status": int(record.get("status", 0) or 0),
                "method": str(record.get("method", "")),
                "user_agent": str(record.get("user_agent", "")),
            }
        )
        if len(visits) >= limit:
            break
    return visits


def summarize_visits(records: Iterable[dict[str, Any]], *, hours: int) -> dict[str, Any]:
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    service_counts: Counter[str] = Counter()
    service_labels: dict[str, str] = {}
    ips: set[str] = set()
    total = 0
    latest: str | None = None
    by_ip: defaultdict[str, int] = defaultdict(int)

    for record in records:
        if not is_page_visit(record):
            continue
        dt = parse_timestamp(str(record.get("time", "")))
        if dt is None or dt < since:
            continue
        service_info = classify_service(str(record.get("uri", "")))
        if service_info is None:
            continue
        key, label = service_info
        service_counts[key] += 1
        service_labels[key] = label
        ip = str(record.get("ip", ""))
        if ip:
            ips.add(ip)
            by_ip[ip] += 1
        total += 1
        if latest is None:
            latest = str(record.get("time", ""))

    services = [
        {"service": key, "label": service_labels.get(key, key), "visits": count}
        for key, count in service_counts.most_common()
    ]
    repeat_visitors = sum(1 for count in by_ip.values() if count > 1)
    return {
        "hours": hours,
        "visits": total,
        "unique_ips": len(ips),
        "repeat_ips": repeat_visitors,
        "latest_visit": latest,
        "services": services,
    }


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _parse_allowed_networks(raw: str | None) -> tuple[ipaddress._BaseNetwork, ...]:
    if not raw:
        return ()
    networks: list[ipaddress._BaseNetwork] = []
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        if "/" not in item:
            address = ipaddress.ip_address(item)
            item = f"{address}/{32 if address.version == 4 else 128}"
        networks.append(ipaddress.ip_network(item, strict=False))
    return tuple(networks)


@dataclass(frozen=True)
class Config:
    bind: str
    port: int
    password_hash: str
    session_secret: bytes
    access_log: Path
    cookie_secure: bool
    session_ttl_seconds: int
    allowed_networks: tuple[ipaddress._BaseNetwork, ...]

    @classmethod
    def from_env(cls) -> "Config":
        password_hash = os.environ.get("ATLAS_ADMIN_PASSWORD_HASH", "").strip()
        session_secret_text = os.environ.get("ATLAS_ADMIN_SESSION_SECRET", "").strip()
        if not password_hash:
            raise RuntimeError("ATLAS_ADMIN_PASSWORD_HASH is required")
        if not verify_password("__config_probe__", password_hash) and not password_hash.startswith(f"{PASSWORD_SCHEME}$"):
            raise RuntimeError("ATLAS_ADMIN_PASSWORD_HASH has an unsupported format")
        if len(session_secret_text) < 32:
            raise RuntimeError("ATLAS_ADMIN_SESSION_SECRET must be at least 32 characters")
        return cls(
            bind=os.environ.get("ATLAS_ADMIN_BIND", "127.0.0.1"),
            port=int(os.environ.get("ATLAS_ADMIN_PORT", "8787")),
            password_hash=password_hash,
            session_secret=session_secret_text.encode("utf-8"),
            access_log=Path(os.environ.get("ATLAS_ACCESS_LOG", "/var/log/nginx/atlas-access.jsonl")),
            cookie_secure=_env_bool("ATLAS_ADMIN_COOKIE_SECURE", True),
            session_ttl_seconds=int(os.environ.get("ATLAS_ADMIN_SESSION_TTL_SECONDS", str(DEFAULT_SESSION_TTL_SECONDS))),
            allowed_networks=_parse_allowed_networks(os.environ.get("ATLAS_ADMIN_ALLOWED_IPS")),
        )


class LoginLimiter:
    def __init__(self) -> None:
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def _prune(self, ip: str, now: float) -> deque[float]:
        events = self._events[ip]
        cutoff = now - LOGIN_WINDOW_SECONDS
        while events and events[0] < cutoff:
            events.popleft()
        return events

    def allowed(self, ip: str) -> bool:
        with self._lock:
            return len(self._prune(ip, time.time())) < LOGIN_MAX_FAILURES

    def failure(self, ip: str) -> None:
        with self._lock:
            events = self._prune(ip, time.time())
            events.append(time.time())

    def success(self, ip: str) -> None:
        with self._lock:
            self._events.pop(ip, None)


class AtlasAdminServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], config: Config) -> None:
        super().__init__(address, AtlasAdminHandler)
        self.config = config
        self.login_limiter = LoginLimiter()


class AtlasAdminHandler(BaseHTTPRequestHandler):
    server: AtlasAdminServer
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("atlas-admin: %s - %s\n" % (self.address_string(), fmt % args))

    def _client_ip(self) -> str:
        candidate = self.headers.get("X-Real-IP", "").strip()
        return candidate or self.client_address[0]

    def _ip_allowed(self) -> bool:
        networks = self.server.config.allowed_networks
        if not networks:
            return True
        try:
            address = ipaddress.ip_address(self._client_ip())
        except ValueError:
            return False
        return any(address in network for network in networks)

    def _json(self, status: int, payload: dict[str, Any], *, headers: dict[str, str] | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Pragma", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if headers:
            for name, value in headers.items():
                self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any] | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if length <= 0 or length > MAX_BODY_BYTES:
            return None
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None

    def _session_payload(self) -> dict[str, Any] | None:
        raw_cookie = self.headers.get("Cookie", "")
        if not raw_cookie:
            return None
        cookie = SimpleCookie()
        try:
            cookie.load(raw_cookie)
        except Exception:
            return None
        morsel = cookie.get(COOKIE_NAME)
        if morsel is None:
            return None
        return verify_session_token(self.server.config.session_secret, morsel.value)

    def _require_auth(self) -> dict[str, Any] | None:
        if not self._ip_allowed():
            self._json(HTTPStatus.FORBIDDEN, {"error": "admin_access_not_allowed"})
            return None
        payload = self._session_payload()
        if payload is None:
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "authentication_required"})
            return None
        return payload

    def _cookie_header(self, token: str, *, expires: int | None = None) -> str:
        parts = [f"{COOKIE_NAME}={token}", "Path=/", "HttpOnly", "SameSite=Strict"]
        if self.server.config.cookie_secure:
            parts.append("Secure")
        if expires is not None:
            parts.append(f"Max-Age={expires}")
        return "; ".join(parts)

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        path = parsed.path.rstrip("/") or "/"
        if path == f"{API_PREFIX}/health":
            self._json(HTTPStatus.OK, {"ok": True})
            return
        if path == f"{API_PREFIX}/session":
            if not self._ip_allowed():
                self._json(HTTPStatus.FORBIDDEN, {"authenticated": False, "error": "admin_access_not_allowed"})
                return
            payload = self._session_payload()
            self._json(
                HTTPStatus.OK,
                {
                    "authenticated": payload is not None,
                    "expires_at": payload.get("exp") if payload else None,
                },
            )
            return
        if path == f"{API_PREFIX}/summary":
            if self._require_auth() is None:
                return
            params = parse_qs(parsed.query)
            try:
                hours = min(max(int(params.get("hours", ["24"])[0]), 1), 24 * 31)
            except ValueError:
                self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid_hours"})
                return
            records = read_recent_records(self.server.config.access_log)
            self._json(HTTPStatus.OK, summarize_visits(records, hours=hours))
            return
        if path == f"{API_PREFIX}/visits":
            if self._require_auth() is None:
                return
            params = parse_qs(parsed.query)
            try:
                limit = min(max(int(params.get("limit", [str(DEFAULT_RESULT_LIMIT)])[0]), 1), MAX_RESULT_LIMIT)
            except ValueError:
                self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid_limit"})
                return
            service = params.get("service", [None])[0] or None
            ip_filter = params.get("ip", [None])[0] or None
            hours_raw = params.get("hours", ["24"])[0]
            since = None
            if hours_raw not in {"", "all"}:
                try:
                    hours = min(max(int(hours_raw), 1), 24 * 31)
                except ValueError:
                    self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid_hours"})
                    return
                since = datetime.now(timezone.utc) - timedelta(hours=hours)
            allowed_services = {"root", *(item[1] for item in SERVICE_PREFIXES)}
            if service and service not in allowed_services:
                self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid_service"})
                return
            records = read_recent_records(self.server.config.access_log)
            visits = filter_visits(records, service=service, ip=ip_filter, since=since, limit=limit)
            self._json(HTTPStatus.OK, {"count": len(visits), "visits": visits})
            return
        self._json(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def do_POST(self) -> None:
        parsed = urlsplit(self.path)
        path = parsed.path.rstrip("/") or "/"
        if path == f"{API_PREFIX}/login":
            if not self._ip_allowed():
                self._json(HTTPStatus.FORBIDDEN, {"error": "admin_access_not_allowed"})
                return
            client_ip = self._client_ip()
            if not self.server.login_limiter.allowed(client_ip):
                self._json(HTTPStatus.TOO_MANY_REQUESTS, {"error": "too_many_login_attempts"})
                return
            payload = self._read_json()
            password = payload.get("password") if payload else None
            if not isinstance(password, str) or not verify_password(password, self.server.config.password_hash):
                self.server.login_limiter.failure(client_ip)
                time.sleep(0.15)
                self._json(HTTPStatus.UNAUTHORIZED, {"error": "invalid_credentials"})
                return
            self.server.login_limiter.success(client_ip)
            token = issue_session_token(
                self.server.config.session_secret,
                ttl_seconds=self.server.config.session_ttl_seconds,
            )
            session = verify_session_token(self.server.config.session_secret, token)
            self._json(
                HTTPStatus.OK,
                {"authenticated": True, "expires_at": session.get("exp") if session else None},
                headers={"Set-Cookie": self._cookie_header(token, expires=self.server.config.session_ttl_seconds)},
            )
            return
        if path == f"{API_PREFIX}/logout":
            if self._require_auth() is None:
                return
            self._json(
                HTTPStatus.OK,
                {"authenticated": False},
                headers={"Set-Cookie": self._cookie_header("", expires=0)},
            )
            return
        self._json(HTTPStatus.NOT_FOUND, {"error": "not_found"})


def run_server(config: Config) -> None:
    if config.bind not in {"127.0.0.1", "::1", "localhost"}:
        raise RuntimeError("ATLAS_ADMIN_BIND must remain loopback-only")
    server = AtlasAdminServer((config.bind, config.port), config)
    print(
        f"Atlas admin API listening on http://{config.bind}:{config.port}{API_PREFIX}/ (log={config.access_log})",
        file=sys.stderr,
    )
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Atlas Management access-log admin API")
    parser.add_argument("--check-config", action="store_true", help="validate environment configuration and exit")
    args = parser.parse_args()
    try:
        config = Config.from_env()
    except (RuntimeError, ValueError) as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2
    if args.check_config:
        print("CONFIG=PASS")
        print(f"ACCESS_LOG={config.access_log}")
        print(f"COOKIE_SECURE={'YES' if config.cookie_secure else 'NO'}")
        print(f"IP_ALLOWLIST={'ENABLED' if config.allowed_networks else 'DISABLED'}")
        return 0
    run_server(config)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
