"""Turning raw feed entries into tidy Broadsheet articles."""

from __future__ import annotations

import calendar
import re
from datetime import datetime, timedelta, timezone

from textutil import (
    clean_link,
    clean_title,
    https_image,
    make_snippet,
    normalize_url,
    short_hash,
)

_IMG_IN_HTML = re.compile(r"<img[^>]+src=[\"']([^\"']+)[\"']", re.I)
_IMAGE_EXT = re.compile(r"\.(jpe?g|png|webp|gif|avif)(\?|$)", re.I)
# Tiny images in feeds are usually tracking pixels or icons, not photos.
_TRACKING_PIXEL = re.compile(r"(feedburner|pixel|tracking|1x1|spacer|blank\.gif|stats\.|/beacon)", re.I)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _entry_time(entry, now: datetime) -> datetime | None:
    for key in ("published_parsed", "updated_parsed", "created_parsed"):
        value = entry.get(key)
        if value:
            try:
                dt = datetime.fromtimestamp(calendar.timegm(value), tz=timezone.utc)
            except (OverflowError, ValueError, TypeError):
                continue
            # Some feeds post-date items or use nonsense years. Clamp to "now".
            if dt > now + timedelta(minutes=10):
                return now
            if dt.year < 2000:
                continue
            return dt
    return None


def _as_int(value) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return 0


def _usable(url: str) -> bool:
    return bool(url) and not _TRACKING_PIXEL.search(url)


def _thumbnail(entry) -> str:
    """Best image the feed itself provides: media:content, media:thumbnail, enclosure, inline <img>."""
    candidates: list[tuple[int, str]] = []

    for media in entry.get("media_content", []) or []:
        url = media.get("url", "")
        medium = (media.get("medium") or "").lower()
        mime = (media.get("type") or "").lower()
        is_image = medium == "image" or mime.startswith("image/") or (
            not medium and not mime and _IMAGE_EXT.search(url or "")
        )
        if is_image and _usable(url):
            candidates.append((_as_int(media.get("width")) or 600, url))

    for thumb in entry.get("media_thumbnail", []) or []:
        url = thumb.get("url", "")
        if _usable(url):
            candidates.append((_as_int(thumb.get("width")) or 300, url))

    for enclosure in entry.get("enclosures", []) or []:
        url = enclosure.get("href") or enclosure.get("url") or ""
        mime = (enclosure.get("type") or "").lower()
        if (mime.startswith("image/") or _IMAGE_EXT.search(url)) and _usable(url):
            candidates.append((500, url))

    for link in entry.get("links", []) or []:
        if link.get("rel") == "enclosure" and (link.get("type") or "").startswith("image/"):
            if _usable(link.get("href", "")):
                candidates.append((500, link["href"]))

    if candidates:
        # Prefer the widest image, but avoid giant originals over 2000px.
        candidates.sort(key=lambda item: (item[0] <= 2000, item[0]), reverse=True)
        return https_image(candidates[0][1])

    # Last resort: an <img> inside the description or content the feed provided.
    html_parts = [entry.get("summary", "") or ""]
    for content in entry.get("content", []) or []:
        html_parts.append(content.get("value", "") or "")
    for part in html_parts:
        for match in _IMG_IN_HTML.finditer(part):
            url = match.group(1)
            if _usable(url) and "width=\"1\"" not in part[match.start(): match.end() + 40]:
                return https_image(url)
    return ""


def entry_to_article(entry, feed: dict, now: datetime) -> dict | None:
    title = clean_title(entry.get("title"))
    raw_link = entry.get("link") or ""
    if not raw_link:
        for link in entry.get("links", []) or []:
            if link.get("rel", "alternate") == "alternate" and link.get("href"):
                raw_link = link["href"]
                break
    link = clean_link(raw_link)
    if not title or not link:
        return None

    normalized = normalize_url(link)
    published = _entry_time(entry, now)

    description = entry.get("summary") or ""
    if not description:
        for content in entry.get("content", []) or []:
            if content.get("value"):
                description = content["value"]
                break

    return {
        "id": short_hash(normalized),
        "title": title,
        "link": link,
        "source": feed["name"],
        "homepage": feed.get("homepage", ""),
        "category": feed["category"],
        "region": feed.get("region", ""),
        "country": feed.get("country", ""),
        "published": iso(published or now),
        "dated": published is not None,
        "seen": iso(now),
        "snippet": make_snippet(description, title),
        "thumb": _thumbnail(entry),
    }
