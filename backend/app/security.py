"""Request guards and secret redaction. The server binds to 127.0.0.1 only (see Makefile)."""

import re

from fastapi import HTTPException, Request

ALLOWED_HOSTS = ["localhost", "127.0.0.1"]
ALLOWED_ORIGINS = {f"http://{host}:{port}" for host in ALLOWED_HOSTS for port in (8080, 5180)}
CSRF_HEADER = "x-dashboard"

_TOKEN = re.compile(r"\bls-[A-Za-z0-9]{8,}[A-Za-z0-9-]*")
_SECRET_KEY = re.compile(r"(token|secret|password|api_?key|secret_access_key)$", re.IGNORECASE)


def csrf_guard(request: Request) -> None:
    """State-changing requests need an allowed Origin and a header a cross-site form cannot set."""
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return
    if request.headers.get("origin") not in ALLOWED_ORIGINS or CSRF_HEADER not in request.headers:
        raise HTTPException(403, "Cross-site request rejected")


def redact_text(text: str) -> str:
    return _TOKEN.sub("<redacted>", text)


def redact(value):
    """Redact auth tokens in strings, and any value stored under a secret-looking key."""
    if isinstance(value, dict):
        return {
            k: "<redacted>" if v and _SECRET_KEY.search(str(k)) else redact(v)
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, str):
        return redact_text(value)
    return value
