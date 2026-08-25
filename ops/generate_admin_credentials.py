#!/usr/bin/env python3
"""Generate Atlas Management admin credentials without storing plaintext secrets."""

from __future__ import annotations

from getpass import getpass
from pathlib import Path
import secrets
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from atlas_admin_server import make_password_hash  # noqa: E402


def main() -> int:
    password = getpass("Atlas admin password: ")
    confirm = getpass("Confirm password: ")
    if not password:
        print("Password must not be empty.", file=sys.stderr)
        return 2
    if password != confirm:
        print("Passwords do not match.", file=sys.stderr)
        return 2
    print(f"ATLAS_ADMIN_PASSWORD_HASH='{make_password_hash(password)}'")
    print(f"ATLAS_ADMIN_SESSION_SECRET='{secrets.token_urlsafe(48)}'")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
