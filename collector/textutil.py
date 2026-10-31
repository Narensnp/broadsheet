"""Small text helpers: cleaning HTML, normalising URLs and titles, snippets.

Everything here is pure (no network, no files), which makes it easy to test.
"""

from __future__ import annotations

import hashlib
import html
import re
import unicodedata
from html.parser import HTMLParser
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

SNIPPET_MAX_WORDS = 50

# Query-string parameters that only exist to track clicks. Removing them lets
# us recognise the same article reached through different links.
_TRACKING_PARAMS = {
    "fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "igshid",
    "cmpid", "ocid", "taid", "smid", "smtyp", "ito", "ref", "referrer",
    "ns_mchannel", "ns_source", "ns_campaign", "ns_linkname", "ns_fee",
    "ftag", "mod", "yptr", "guccounter", "guce_referrer", "guce_referrer_sig",
    "_ga", "sr_share", "xtor", "s_cid", "intcmp", "int_source",
}
_TRACKING_PREFIXES = ("utm_", "pk_", "mtm_", "hsa_", "__twitter", "at_")

# Text that feeds append to descriptions and that says nothing about the story.
_BOILERPLATE = [
    re.compile(r"The post .{1,300}? appeared first on .{1,120}?\.?\s*$", re.I | re.S),
    re.compile(r"\b(Continue reading|Read more|Read the full story|Read full article|Keep reading)\b.*$", re.I | re.S),
    re.compile(r"\[\s*(…|\.\.\.|&#8230;)\s*\]"),
    re.compile(r"^\s*Comments\s*$", re.I),  # Hacker News descriptions
    re.compile(r"Article URL:\s*\S+\s*Comments URL:\s*\S+.*$", re.I | re.S),
]

_WS = re.compile(r"\s+")


class _TextExtractor(HTMLParser):
    """Collects visible text from an HTML fragment, skipping scripts/styles."""

    _SKIP = {"script", "style", "noscript", "iframe", "figcaption"}
    _BLOCK = {"p", "br", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "blockquote"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skip_depth += 1
        elif tag in self._BLOCK:
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in self._SKIP and self._skip_depth:
            self._skip_depth -= 1
        elif tag in self._BLOCK:
            self.parts.append(" ")

    def handle_data(self, data):
        if not self._skip_depth:
            self.parts.append(data)


def strip_html(value: str | None) -> str:
    """Turn an HTML fragment into plain, single-spaced text."""
    if not value:
        return ""
    if "<" not in value and "&" not in value:
        return _WS.sub(" ", value).strip()
    parser = _TextExtractor()
    try:
        parser.feed(value)
        parser.close()
        text = "".join(parser.parts)
    except Exception:  # malformed HTML: fall back to a crude tag strip
        text = re.sub(r"<[^>]+>", " ", value)
    text = html.unescape(text)
    return _WS.sub(" ", text).strip()


def clean_title(value: str | None) -> str:
    title = strip_html(value)
    # Some feeds wrap titles in quotes or add trailing separators.
    title = title.strip("  |-–—")
    return title


def make_snippet(value: str | None, title: str = "", max_words: int = SNIPPET_MAX_WORDS) -> str:
    """Plain-text teaser of at most ``max_words`` words (never the full article)."""
    text = strip_html(value)
    for pattern in _BOILERPLATE:
        text = pattern.sub("", text).strip()
    if not text:
        return ""
    # A snippet that just repeats the headline adds nothing.
    if normalize_title(text) == normalize_title(title):
        return ""
    words = text.split()
    if len(words) > max_words:
        text = " ".join(words[:max_words]).rstrip(",;:.-–—") + "…"
    return text


def normalize_url(url: str) -> str:
    """Canonical form of a link, used for de-duplication and the article id."""
    url = (url or "").strip()
    if not url:
        return ""
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    scheme = (parts.scheme or "https").lower()
    if scheme == "http":
        scheme = "https"
    host = (parts.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    if host.startswith("amp."):
        host = host[4:]
    if parts.port and parts.port not in (80, 443):
        host = f"{host}:{parts.port}"
    path = re.sub(r"/{2,}", "/", parts.path or "/")
    for suffix in ("/amp", "/amp/", "/index.html", "/index.htm"):
        if path.endswith(suffix) and len(path) > len(suffix):
            path = path[: -len(suffix)]
    if len(path) > 1:
        path = path.rstrip("/")
    query = [
        (key, val)
        for key, val in parse_qsl(parts.query, keep_blank_values=False)
        if key.lower() not in _TRACKING_PARAMS
        and not key.lower().startswith(_TRACKING_PREFIXES)
    ]
    query.sort()
    return urlunsplit((scheme, host, path, urlencode(query), ""))


def clean_link(url: str) -> str:
    """The link we show to readers: tracking parameters removed, nothing else changed."""
    url = (url or "").strip()
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    if parts.scheme not in ("http", "https"):
        return ""
    query = [
        (key, val)
        for key, val in parse_qsl(parts.query, keep_blank_values=True)
        if key.lower() not in _TRACKING_PARAMS
        and not key.lower().startswith(_TRACKING_PREFIXES)
    ]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), ""))


def short_hash(text: str, length: int = 16) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:length]


def normalize_title(title: str) -> str:
    """Lower-case, accent-free, punctuation-free version used to spot duplicates."""
    text = unicodedata.normalize("NFKD", title or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower()
    text = re.sub(r"[^\w\s]", " ", text)
    return _WS.sub(" ", text).strip()


def title_tokens(title: str) -> set[str]:
    return {tok for tok in normalize_title(title).split() if len(tok) > 1}


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def https_image(url: str | None) -> str:
    """Return an https image URL (browsers block plain-http images on https pages)."""
    if not url:
        return ""
    url = html.unescape(url.strip())
    if url.startswith("//"):
        url = "https:" + url
    if url.startswith("http://"):
        url = "https://" + url[len("http://"):]
    if not url.startswith("https://"):
        return ""
    return url
