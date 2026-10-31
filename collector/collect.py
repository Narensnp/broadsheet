"""Broadsheet collector: fetch feeds, clean, group into stories, rank, write JSON.

Run it from the project folder:

    python collector/collect.py

By default it reads feeds.yaml, uses the JSON already in site/data as "the
previous run" (if any) and writes fresh JSON back into site/data.
The GitHub workflow passes --previous with data downloaded from the live site.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yaml

from cluster import build_stories, cluster_articles, dedupe_titles
from fetcher import fetch_all
from parse import entry_to_article, iso, parse_iso
from trending import find_trending

ROOT = Path(__file__).resolve().parent.parent

CATEGORIES = [
    {"id": "world", "name": "World & Politics"},
    {"id": "business", "name": "Business & Finance"},
    {"id": "technology", "name": "Technology"},
    {"id": "science", "name": "Innovation & Science"},
    {"id": "asia", "name": "Singapore & Asia"},
]
CATEGORY_IDS = {c["id"] for c in CATEGORIES}

WINDOW = timedelta(days=7)
MAX_ARCHIVE = 15000          # hard cap on stored articles
TOP_STORIES = 60
STORIES_PER_CATEGORY = 150
REQUIRED_FIELDS = ("name", "url", "category")


def log(message: str = "") -> None:
    print(message, flush=True)


# --- Input ------------------------------------------------------------------

def load_feeds(path: Path) -> tuple[list[dict], list[dict]]:
    """Return (valid feeds, problems). A bad entry never stops the run."""
    with path.open(encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    entries = data.get("feeds", []) if isinstance(data, dict) else data
    valid, problems, seen_urls = [], [], set()
    for number, entry in enumerate(entries or [], start=1):
        if not isinstance(entry, dict):
            problems.append({"name": f"Entry #{number}", "url": "", "error": "Not a valid feed entry (check the indentation)"})
            continue
        missing = [f for f in REQUIRED_FIELDS if not str(entry.get(f) or "").strip()]
        feed = {k: str(v).strip() for k, v in entry.items() if v is not None}
        if missing:
            problems.append({**feed, "name": feed.get("name", f"Entry #{number}"), "url": feed.get("url", ""),
                             "error": f"Missing field(s) in feeds.yaml: {', '.join(missing)}"})
            continue
        if feed["category"] not in CATEGORY_IDS:
            problems.append({**feed, "error": f"Unknown category '{feed['category']}'. Use one of: {', '.join(sorted(CATEGORY_IDS))}"})
            continue
        if feed["url"] in seen_urls:
            continue
        seen_urls.add(feed["url"])
        valid.append(feed)
    return valid, problems


def read_json(path: Path) -> dict | None:
    try:
        with path.open(encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def write_json(path: Path, data) -> int:
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    path.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))


# --- Merging ----------------------------------------------------------------

def merge_articles(previous: list[dict], fresh: list[dict], now: datetime) -> list[dict]:
    """Combine the rolling archive with newly fetched articles (by URL id)."""
    merged: dict[str, dict] = {}
    for article in previous:
        if not isinstance(article, dict) or "id" not in article or "published" not in article:
            continue
        if parse_iso(article["published"]) is None:
            continue
        article.setdefault("seen", article["published"])
        article.setdefault("dated", True)
        merged[article["id"]] = article

    for article in fresh:
        old = merged.get(article["id"])
        if old is None:
            merged[article["id"]] = article
            continue
        # Keep when we first saw it; refresh the text in case the outlet edited it.
        article["seen"] = old.get("seen", article["seen"])
        if old.get("dated", True) or not article["dated"]:
            article["published"] = old["published"]
        article["category"] = old.get("category", article["category"])
        for key in ("snippet", "thumb"):
            if not article.get(key) and old.get(key):
                article[key] = old[key]
        if old.get("story"):
            article["story"] = old["story"]
        merged[article["id"]] = article

    cutoff = now - WINDOW
    kept = [a for a in merged.values() if parse_iso(a["published"]) >= cutoff]
    kept.sort(key=lambda a: a["published"], reverse=True)
    return kept[:MAX_ARCHIVE]


# --- Main -------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="Collect news for Broadsheet.")
    parser.add_argument("--feeds", default=str(ROOT / "feeds.yaml"), help="path to feeds.yaml")
    parser.add_argument("--out", default=str(ROOT / "site" / "data"), help="folder to write JSON into")
    parser.add_argument("--previous", default=None,
                        help="folder holding the previous run's JSON (defaults to --out)")
    args = parser.parse_args()

    # Windows terminals sometimes can't print every character in a headline.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass

    started = time.monotonic()
    now = datetime.now(timezone.utc).replace(microsecond=0)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    previous_dir = Path(args.previous) if args.previous else out_dir

    log(f"Broadsheet collector - {iso(now)}")
    feeds, problems = load_feeds(Path(args.feeds))
    log(f"Loaded {len(feeds)} feeds from {args.feeds}" + (f" ({len(problems)} with problems)" if problems else ""))

    # Previous run (may not exist on the very first run).
    previous_archive = read_json(previous_dir / "archive.json")
    previous_status = read_json(previous_dir / "status.json")
    previous_trending = read_json(previous_dir / "trending.json")
    archive_articles = (previous_archive or {}).get("articles", [])
    if previous_archive:
        log(f"Previous run: {len(archive_articles)} articles from {previous_archive.get('generated', '?')}")
    else:
        log("No previous data found - this looks like the first run.")

    previous_feed_status = {
        f.get("url"): f for f in (previous_status or {}).get("feeds", []) if isinstance(f, dict)
    }
    # Only ask servers "has this changed?" when we still hold the old articles.
    cache_headers = {}
    if archive_articles:
        for url, info in previous_feed_status.items():
            if info.get("status") in ("ok", "empty"):
                cache_headers[url] = {"etag": info.get("etag", ""), "last_modified": info.get("last_modified", "")}

    log("Fetching feeds...")
    results = fetch_all(feeds, cache_headers, log=log)

    fresh: list[dict] = []
    feed_status: list[dict] = []
    for result in results:
        feed = result.feed
        prev = previous_feed_status.get(feed["url"], {})
        parsed = []
        for entry in result.entries:
            try:
                article = entry_to_article(entry, feed, now)
            except Exception as exc:  # one odd entry must not sink the feed
                log(f"    skipped an entry from {feed['name']}: {exc}")
                continue
            if article:
                parsed.append(article)
        fresh.extend(parsed)

        status = result.status
        note = result.error
        items = len(parsed)
        if status == "ok" and not parsed:
            status, note = "empty", "The feed loaded but no usable articles were found"
        if status == "not_modified":
            status, note, items = "ok", "Unchanged since the last check", prev.get("items", 0)
        healthy = status == "ok"
        feed_status.append({
            "name": feed["name"],
            "url": feed["url"],
            "homepage": feed.get("homepage", ""),
            "category": feed["category"],
            "country": feed.get("country", ""),
            "status": status,
            "error": note,
            "http_status": result.http_status,
            "items": items,
            "duration_ms": result.duration_ms,
            "last_ok": iso(now) if healthy else prev.get("last_ok", ""),
            "fail_streak": 0 if healthy else int(prev.get("fail_streak", 0) or 0) + 1,
            "etag": result.etag if healthy else "",
            "last_modified": result.last_modified if healthy else "",
        })

    for problem in problems:
        feed_status.append({
            "name": problem.get("name", "?"), "url": problem.get("url", ""),
            "homepage": problem.get("homepage", ""), "category": problem.get("category", ""),
            "country": problem.get("country", ""), "status": "failed", "error": problem["error"],
            "http_status": None, "items": 0, "duration_ms": 0, "last_ok": "", "fail_streak": 1,
            "etag": "", "last_modified": "",
        })

    working = sum(1 for f in feed_status if f["status"] == "ok")
    if working == 0:
        log("ERROR: every feed failed. Nothing was published; the site keeps showing the last good data.")
        return 1

    articles = merge_articles(archive_articles, fresh, now)
    articles = dedupe_titles(articles)
    articles.sort(key=lambda a: a["published"], reverse=True)
    if not articles:
        log("ERROR: no articles at all. Nothing was published.")
        return 1
    log(f"Articles in the 7-day window: {len(articles)} ({len(fresh)} fetched this run)")

    source_names = sorted({f["name"] for f in feeds})
    previous_story_of = {a["id"]: a["story"] for a in archive_articles if isinstance(a, dict) and a.get("story")}

    t0 = time.monotonic()
    groups, matrix = cluster_articles(articles, source_names)
    stories = build_stories(articles, groups, matrix, previous_story_of, now)
    multi = sum(1 for s in stories if s["n_sources"] > 1)
    log(f"Grouped into {len(stories)} stories ({multi} covered by 2+ outlets) in {time.monotonic() - t0:.1f}s")

    trending = find_trending(articles, stories, source_names, previous_trending, now)
    log("Trending: " + (", ".join(t["label"] for t in trending["topics"]) or "(nothing rising right now)"))

    # --- Write output --------------------------------------------------------
    generated = iso(now)
    sizes = {}
    sizes["top.json"] = write_json(out_dir / "top.json", {
        "generated": generated,
        "stories": stories[:TOP_STORIES],
    })
    for category in CATEGORIES:
        chosen = [s for s in stories if category["id"] in s["categories"]][:STORIES_PER_CATEGORY]
        sizes[f"{category['id']}.json"] = write_json(out_dir / f"{category['id']}.json", {
            "generated": generated,
            "category": category,
            "stories": chosen,
        })
    sizes["trending.json"] = write_json(out_dir / "trending.json", {"generated": generated, **trending})

    article_counts = Counter(a["source"] for a in articles)
    sources: dict[str, dict] = {}
    for feed in feeds:
        entry = sources.setdefault(feed["name"], {
            "name": feed["name"],
            "homepage": feed.get("homepage", ""),
            "country": feed.get("country", ""),
            "region": feed.get("region", ""),
            "categories": [],
            "feeds": 0,
            "articles": article_counts.get(feed["name"], 0),
        })
        entry["feeds"] += 1
        if feed["category"] not in entry["categories"]:
            entry["categories"].append(feed["category"])
    sizes["sources.json"] = write_json(out_dir / "sources.json", {
        "generated": generated,
        "categories": CATEGORIES,
        "sources": sorted(sources.values(), key=lambda s: s["name"].lower().removeprefix("the ")),
    })

    counts = Counter(f["status"] for f in feed_status)
    sizes["status.json"] = write_json(out_dir / "status.json", {
        "generated": generated,
        "duration_seconds": round(time.monotonic() - started, 1),
        "articles": len(articles),
        "articles_fetched": len(fresh),
        "stories": len(stories),
        "feeds_total": len(feed_status),
        "feeds_ok": counts.get("ok", 0),
        "feeds_empty": counts.get("empty", 0),
        "feeds_failed": counts.get("failed", 0),
        "feeds": feed_status,
    })
    sizes["version.json"] = write_json(out_dir / "version.json", {
        "generated": generated,
        "articles": len(articles),
        "stories": len(stories),
    })
    # The rolling archive is only read by the next collector run.
    sizes["archive.json"] = write_json(out_dir / "archive.json", {
        "generated": generated,
        "articles": articles,
    })

    for name, size in sizes.items():
        log(f"  wrote {name:<16} {size / 1024:8.1f} KB")
    log(f"Done in {time.monotonic() - started:.1f}s. Feeds: {counts.get('ok', 0)} ok, "
        f"{counts.get('empty', 0)} empty, {counts.get('failed', 0)} failed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
