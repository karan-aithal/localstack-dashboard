"""
Stack Insights: what the instance served in each run, read from its container log.

Request lines are copied into a local SQLite file, so that runs stay listed after the container
is removed. Only service, operation, status and error code are kept.
"""

import math
import re
import sqlite3
import time
from contextlib import closing
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Query

from . import instance as instances
from .instance import Selected, docker
from .logs import ANSI
from .security import redact_text

router = APIRouter(prefix="/api/instances/{name}/insights")

EVENT_LIMIT = 500
BUCKETS = 60

# every run of the instance begins by printing its version
_START = re.compile(r"LocalStack version: (\S+)$")
_PREFIX = r"^\S+ +\w+ +--- \[[^\]]*\] "
_LOGGED = re.compile(_PREFIX)
_REQUEST = re.compile(
    _PREFIX + r"localstack\.request\.aws +: "
    r"AWS ([a-z0-9.-]+)\.([A-Za-z0-9]+) => (\d{3})(?: \(([\w.-]*)\))?(?:;|$)"
)
_SHUTDOWN = re.compile(
    _PREFIX + r"l(?:ocalstack)?\.runtime\.shutdown +: \[shutdown\] Stopping all services"
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    container TEXT, id INTEGER, version TEXT, seen TEXT, stopped INTEGER,
    PRIMARY KEY (container, id));
CREATE TABLE IF NOT EXISTS events (
    container TEXT, ts TEXT, at INTEGER, session INTEGER,
    service TEXT, operation TEXT, status INTEGER, error TEXT,
    PRIMARY KEY (container, ts, service, operation));
CREATE INDEX IF NOT EXISTS by_session ON events (container, session, at);
"""


def database() -> sqlite3.Connection:
    path = instances.STORE.with_name("insights.db")
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    db.row_factory = sqlite3.Row
    db.executescript(_SCHEMA)
    return db


def epoch(timestamp: str) -> int:
    return int(datetime.fromisoformat(timestamp).timestamp())


def ingest(db: sqlite3.Connection, container: str, lines: list[str]) -> None:
    """
    Store the runs and requests found in `docker logs --timestamps` lines, in time order.

    Reading the same lines again changes nothing.
    """
    row = db.execute("SELECT max(id) FROM sessions WHERE container = ?", [container]).fetchone()
    session = row[0]
    seen: dict[int, str] = {}
    for line in lines:
        timestamp, _, text = line.partition(" ")
        try:
            at = epoch(timestamp)
        except ValueError:
            continue
        text = ANSI.sub("", text).rstrip()
        start = _START.match(text)
        request = _REQUEST.match(text)
        # a rotated log can begin in the middle of a run, without its version line
        if start or (request and session is None):
            session = at
            db.execute(
                "INSERT OR IGNORE INTO sessions VALUES (?, ?, ?, ?, 0)",
                [container, session, start[1] if start else "", timestamp],
            )
        if session is None:
            continue
        # not blank lines and banners: one precedes the next run's version line, hours later
        if _LOGGED.match(text):
            seen[session] = timestamp
        if request:
            service, operation, status, error = request.groups()
            db.execute(
                "INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [container, timestamp, at, session, service, operation, int(status), error or ""],
            )
        elif _SHUTDOWN.match(text):
            db.execute(
                "UPDATE sessions SET stopped = 1 WHERE container = ? AND id = ?",
                [container, session],
            )
    db.executemany(
        "UPDATE sessions SET seen = max(seen, ?) WHERE container = ? AND id = ?",
        [(timestamp, container, key) for key, timestamp in seen.items()],
    )


def sync(db: sqlite3.Connection, container: str) -> str | None:
    """Read the log lines not stored yet. Returns why that failed, if it did."""
    query = "SELECT max(seen) FROM sessions WHERE container = ?"
    last = db.execute(query, [container]).fetchone()[0]
    since = ["--since", last] if last else []
    try:
        # ponytail: the first read holds the whole log in memory; stream it if logs get huge
        result = docker("logs", "--timestamps", *since, container)
    except HTTPException as e:
        return e.detail
    if result.returncode != 0:
        return redact_text(result.stderr.strip())
    with db:
        ingest(db, container, sorted((result.stdout + "\n" + result.stderr).split("\n")))
    return None


def sessions_of(db: sqlite3.Connection, container: str) -> list[dict]:
    """Runs of a container, newest first, with their call counts."""
    rows = db.execute(
        """
        SELECT s.id, s.version, s.seen, s.stopped,
               count(e.ts) FILTER (WHERE e.status < 400) AS ok,
               count(e.ts) FILTER (WHERE e.status >= 400) AS failed,
               count(DISTINCT e.service) AS services
        FROM sessions s LEFT JOIN events e ON e.container = s.container AND e.session = s.id
        WHERE s.container = ? GROUP BY s.id ORDER BY s.id DESC
        """,
        [container],
    ).fetchall()
    if not rows:
        return []
    try:
        state = docker("inspect", "--format", "{{.State.Status}}", container).stdout.strip()
    except HTTPException:
        state = ""
    found = []
    for position, row in enumerate(rows):
        # only the newest run can still be going on
        running = position == 0 and not row["stopped"] and state == "running"
        ended = int(time.time()) if running else epoch(row["seen"])
        found.append(
            {
                "id": row["id"],
                "version": row["version"],
                "state": "running" if running else "stopped",
                "ended": max(ended, row["id"]),
                "ok": row["ok"],
                "failed": row["failed"],
                "services": row["services"],
            }
        )
    return found


@router.get("/sessions")
def sessions(instance: Selected):
    with closing(database()) as db:
        error = sync(db, instance.container)
        return {"sessions": sessions_of(db, instance.container), "error": error}


Moment = Annotated[int | None, Query(ge=0, le=2**40)]


@router.get("/sessions/{session}")
def session_detail(
    instance: Selected,
    session: Annotated[int, Path(ge=0, le=2**40)],
    start: Moment = None,
    end: Moment = None,
    service: Annotated[str | None, Query(pattern=r"^[a-z0-9.-]{1,60}$")] = None,
    failed: bool = False,
):
    """Counts over time and per service, and the latest events, of one run."""
    with closing(database()) as db:
        error = sync(db, instance.container)
        found = next(
            (s for s in sessions_of(db, instance.container) if s["id"] == session), None
        )
        if found is None:
            raise HTTPException(404, "Unknown session")
        first = session if start is None else start
        last = max(first, found["ended"] if end is None else end)

        # the clauses are fixed text; every value is passed as a parameter
        where = "container = ? AND session = ? AND at BETWEEN ? AND ?"
        values: list = [instance.container, session, first, last]
        if service:
            where += " AND service = ?"
            values.append(service)
        if failed:
            where += " AND status >= 400"

        width = max(1, math.ceil((last - first + 1) / BUCKETS))
        count = math.ceil((last - first + 1) / width)
        timeline = [{"at": first + i * width, "ok": 0, "failed": 0} for i in range(count)]
        for row in db.execute(
            f"""SELECT (at - ?) / ? AS bucket, sum(status < 400) AS ok,
                       sum(status >= 400) AS failed
                FROM events WHERE {where} GROUP BY bucket""",
            [first, width, *values],
        ):
            timeline[row["bucket"]].update(ok=row["ok"], failed=row["failed"])

        per_service = db.execute(
            f"""SELECT service, sum(status < 400) AS ok, sum(status >= 400) AS failed
                FROM events WHERE {where}
                GROUP BY service ORDER BY count(*) DESC, service""",
            values,
        ).fetchall()
        events = db.execute(
            f"""SELECT ts, at, service, operation, status, error FROM events
                WHERE {where} ORDER BY ts DESC LIMIT ?""",
            [*values, EVENT_LIMIT],
        ).fetchall()
        names = db.execute(
            """SELECT DISTINCT service FROM events
               WHERE container = ? AND session = ? ORDER BY service""",
            [instance.container, session],
        ).fetchall()
        return {
            "session": found,
            "start": first,
            "end": last,
            "width": width,
            "timeline": timeline,
            "services": [dict(row) for row in per_service],
            "events": [dict(row) for row in events],
            "names": [row["service"] for row in names],
            "error": error,
        }
