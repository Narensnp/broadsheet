"""Downloading feeds politely and robustly.

Each feed gets a 15-second timeout and one retry. A feed that still fails is
recorded as "failed" with the reason, and the run carries on without it.
Several feeds are fetched at the same time, but only a few at once so we
never hammer anyone.
"""

from __future__ import annotations

import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field

import feedparser
import requests

TIMEOUT_SECONDS = 15
MAX_WORKERS = 8
RETRY_DELAY_SECONDS = 2
MAX_FEED_BYTES = 8 * 1024 * 1024  # ignore absurdly large responses


def user_agent() -> str:
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    contact = f"https://github.com/{repo}" if repo else "personal news reader"
    return (
        f"Broadsheet/1.0 (+{contact}; RSS aggregator that links to original articles) "
        f"feedparser/{feedparser.__version__}"
    )


@dataclass
class FeedResult:
    feed: dict
    status: str = "failed"  # ok | empty | failed | not_modified
    error: str = ""
    http_status: int | None = None
    duration_ms: int = 0
    entries: list = field(default_factory=list)
    etag: str = ""
    last_modified: str = ""
    attempts: int = 0


def _describe(exc: Exception) -> str:
    if isinstance(exc, requests.Timeout):
        return f"Timed out after {TIMEOUT_SECONDS} seconds"
    if isinstance(exc, requests.ConnectionError):
        return "Could not connect to the server"
    if isinstance(exc, requests.HTTPError) and exc.response is not None:
        code = exc.response.status_code
        hint = {
            401: "the feed requires a login",
            403: "the server refused access (it may block automated readers)",
            404: "the feed address no longer exists",
            410: "the feed has been removed",
            429: "too many requests; the server asked us to slow down",
        }.get(code, "server error" if code >= 500 else "request rejected")
        return f"HTTP {code}: {hint}"
    return f"{type(exc).__name__}: {exc}"[:300]


def _fetch_once(session: requests.Session, feed: dict, cache_headers: dict) -> FeedResult:
    result = FeedResult(feed=feed)
    headers = {
        "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
    }
    if cache_headers.get("etag"):
        headers["If-None-Match"] = cache_headers["etag"]
    if cache_headers.get("last_modified"):
        headers["If-Modified-Since"] = cache_headers["last_modified"]

    start = time.monotonic()
    response = session.get(feed["url"], headers=headers, timeout=TIMEOUT_SECONDS, stream=True)
    try:
        result.http_status = response.status_code
        if response.status_code == 304:
            result.status = "not_modified"
            result.etag = cache_headers.get("etag", "")
            result.last_modified = cache_headers.get("last_modified", "")
            return result
        response.raise_for_status()
        buffer = bytearray()
        for chunk in response.iter_content(64 * 1024):
            buffer.extend(chunk)
            if len(buffer) > MAX_FEED_BYTES:
                raise ValueError("Feed is larger than 8 MB; skipped")
        body = bytes(buffer)
    finally:
        response.close()
        result.duration_ms = int((time.monotonic() - start) * 1000)

    parsed = feedparser.parse(
        body,
        response_headers={k.lower(): v for k, v in response.headers.items()},
    )
    if parsed.bozo and not parsed.entries:
        reason = getattr(parsed, "bozo_exception", None)
        raise ValueError(f"Not a readable RSS/Atom feed ({reason})"[:300])

    result.entries = list(parsed.entries)
    result.status = "ok" if result.entries else "empty"
    if not result.entries:
        result.error = "The feed loaded but contained no articles"
    result.etag = response.headers.get("ETag", "")
    result.last_modified = response.headers.get("Last-Modified", "")
    return result


def fetch_feed(session: requests.Session, feed: dict, cache_headers: dict) -> FeedResult:
    """Fetch one feed, retrying once. Never raises."""
    last_error = "Unknown error"
    last_status = None
    started = time.monotonic()
    for attempt in (1, 2):
        try:
            result = _fetch_once(session, feed, cache_headers)
            result.attempts = attempt
            return result
        except Exception as exc:  # noqa: BLE001 - we really do want to catch everything
            last_error = _describe(exc)
            if isinstance(exc, requests.HTTPError) and exc.response is not None:
                last_status = exc.response.status_code
                if last_status in (401, 403, 404, 410):
                    break  # retrying will not help
            if attempt == 1:
                time.sleep(RETRY_DELAY_SECONDS)
    return FeedResult(
        feed=feed,
        status="failed",
        error=last_error,
        http_status=last_status,
        duration_ms=int((time.monotonic() - started) * 1000),
        attempts=2 if last_status not in (401, 403, 404, 410) else 1,
    )


def fetch_all(feeds: list[dict], cache_headers_by_url: dict[str, dict], log=print) -> list[FeedResult]:
    """Fetch every feed with limited concurrency. Results keep the input order."""
    session = requests.Session()
    session.headers["User-Agent"] = user_agent()
    adapter = requests.adapters.HTTPAdapter(pool_connections=MAX_WORKERS, pool_maxsize=MAX_WORKERS)
    session.mount("https://", adapter)
    session.mount("http://", adapter)

    results: dict[int, FeedResult] = {}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {
            pool.submit(fetch_feed, session, feed, cache_headers_by_url.get(feed["url"], {})): index
            for index, feed in enumerate(feeds)
        }
        for future in as_completed(futures):
            index = futures[future]
            result = future.result()
            results[index] = result
            feed = result.feed
            label = {
                "ok": f"ok ({len(result.entries)} items)",
                "not_modified": "ok (unchanged since last run)",
                "empty": "empty",
                "failed": f"FAILED - {result.error}",
            }[result.status]
            log(f"  {feed['name']:<28} {result.duration_ms:>6} ms  {label}")
    session.close()
    return [results[i] for i in range(len(feeds))]
