"""Finding topics that are rising right now (not just topics that are always common).

Intuition: "Trump" or "AI" appear in the news every day, so a plain word count
would always show them. Instead we compare how often a phrase appears in the
last 6 hours with how often we'd EXPECT it to appear, based on the 48 hours
before that. A phrase that suddenly shows up across several outlets has a big
"lift" and becomes a trending topic.
"""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta

from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS

from parse import parse_iso
from textutil import normalize_title

RECENT = timedelta(hours=6)
BASELINE = timedelta(hours=48)
MIN_SOURCES = 3          # a topic must be mentioned by at least this many outlets
MIN_LIFT = 1.6           # ...and be at least 1.6x more common than usual
MAX_TOPICS = 16
SPARK_HOURS = 12

STOP = set(ENGLISH_STOP_WORDS) | {
    "says", "said", "say", "saying", "new", "news", "live", "latest", "update",
    "updates", "watch", "video", "videos", "photos", "pictures", "report",
    "reports", "reported", "today", "tonight", "yesterday", "week", "weeks",
    "year", "years", "day", "days", "time", "times", "just", "like", "want",
    "make", "makes", "know", "get", "gets", "got", "people", "according",
    "including", "told", "also", "could", "would", "may", "might", "will",
    "one", "two", "three", "four", "five", "first", "last", "amid", "mr",
    "ms", "read", "story", "article", "opinion", "analysis", "explainer",
    "podcast", "newsletter", "briefing", "comments", "via", "here", "what",
    "why", "how", "who", "when", "where", "big", "best", "top", "key", "set",
    "back", "need", "needs", "take", "takes", "says", "plan", "plans", "way",
    "make", "made", "still", "now", "ago", "old", "high", "low", "long",
    "show", "ask", "hn", "pdf", "official", "officials", "government",
    "world", "global", "deal", "talks", "calls", "call", "move", "moves",
    "week's", "it's", "year's", "can't", "won't", "don't", "isn't",
    "morning", "evening", "afternoon", "monday", "tuesday", "wednesday",
    "thursday", "friday", "saturday", "sunday", "minute", "minutes", "hour",
    "hours", "million", "billion", "percent", "per", "cent", "number",
}

# Phrases that are always in the news and never a "topic" on their own.
GENERIC_PHRASES = {
    "prime minister", "president", "minister", "police", "court", "company",
    "companies", "market", "markets", "stocks", "shares", "investors", "ceo",
    "chief executive", "study", "researchers", "scientists", "experts",
    "white house", "state", "states", "country", "countries", "city", "union",
}

# Words inside outlet names that are also ordinary news words or places, so
# they must NOT be blocked just because an outlet's name contains them.
KEEP_WORDS = {
    "south", "china", "india", "asia", "japan", "bangkok", "singapore", "nasa",
    "science", "nature", "business", "wall", "street", "independent",
    "conversation", "register", "diplomat", "magazine", "review", "technology",
    "australia", "france", "fox", "rest", "economist", "yahoo", "finance",
}

_SEGMENT_SPLIT = re.compile(r"[.,;:!?()\[\]{}\"“”‘’|/–—•]+|\s-\s")
_WORD = re.compile(r"[A-Za-z][A-Za-z0-9'&\-]*[A-Za-z0-9]|[A-Za-z]")


def _blocked_phrases(source_names: list[str]) -> set[str]:
    """Outlet names (and pieces of them) are never trending topics."""
    blocked: set[str] = set()
    for name in source_names:
        tokens = normalize_title(name).split()
        if tokens and tokens[0] == "the":
            tokens = tokens[1:]
        blocked.add(" ".join(tokens))
        for size in (2, 3):
            for i in range(len(tokens) - size + 1):
                blocked.add(" ".join(tokens[i:i + size]))
        for token in tokens:
            if token not in KEEP_WORDS:
                blocked.add(token)
    return blocked


def _is_acronym(word: str) -> bool:
    return 2 <= len(word) <= 6 and word.isupper() and word.isalpha()


def _phrases(text: str) -> dict[str, str]:
    """Return {normalised phrase: display form} for 1-3 word phrases in ``text``."""
    found: dict[str, str] = {}
    for segment in _SEGMENT_SPLIT.split(text):
        words = _WORD.findall(segment)
        if not words:
            continue
        lowered = [w.lower().strip("'") for w in words]
        for size in (1, 2, 3):
            for i in range(len(words) - size + 1):
                chunk = lowered[i:i + size]
                first, last = chunk[0], chunk[-1]
                if first in STOP or last in STOP:
                    continue
                if first.endswith("'s") and size > 1:
                    continue
                if size == 1:
                    original = words[i]
                    if first in STOP:
                        continue
                    if len(first) < 4 and not _is_acronym(original):
                        continue
                    # A lower-case single word ("prices") is rarely a topic;
                    # names and acronyms ("Gaza", "OpenAI", "NATO") usually are.
                    if not original[0].isupper():
                        continue
                if size == 3 and chunk[1] in STOP and chunk[1] not in {"of", "and", "for", "de"}:
                    continue
                key = " ".join(chunk)
                found.setdefault(key, " ".join(words[i:i + size]))
    return found


def _sentence_start(text: str) -> str:
    """First sentence of the snippet; enough context without much noise."""
    return re.split(r"(?<=[.!?])\s", text or "", maxsplit=1)[0]


def find_trending(
    articles: list[dict],
    stories: list[dict],
    source_names: list[str],
    previous: dict | None,
    now: datetime,
) -> dict:
    blocked = _blocked_phrases(source_names)
    recent_start = now - RECENT
    base_start = recent_start - BASELINE

    recent_docs: dict[str, set[int]] = defaultdict(set)
    base_docs: dict[str, set[int]] = defaultdict(set)
    recent_sources: dict[str, set[str]] = defaultdict(set)
    title_hits: Counter = Counter()
    display: dict[str, Counter] = defaultdict(Counter)
    total_recent = total_base = 0
    times: dict[int, datetime] = {}

    for index, article in enumerate(articles):
        when = parse_iso(article["published"])
        if when < base_start:
            continue
        times[index] = when
        title_phrases = _phrases(article["title"])
        phrases = {**_phrases(_sentence_start(article.get("snippet", ""))), **title_phrases}
        is_recent = when >= recent_start
        if is_recent:
            total_recent += 1
        else:
            total_base += 1
        for key, shown in phrases.items():
            if key in blocked:
                continue
            display[key][shown] += 1
            if is_recent:
                recent_docs[key].add(index)
                recent_sources[key].add(article["source"])
                if key in title_phrases:
                    title_hits[key] += 1
            else:
                base_docs[key].add(index)

    # Scale the baseline so it is comparable with the 6-hour window.
    scale = (total_recent / total_base) if total_base else 0.0
    candidates = []
    for key, docs in recent_docs.items():
        sources = recent_sources[key]
        if len(sources) < MIN_SOURCES:
            continue
        recent = len(docs)
        baseline = len(base_docs.get(key, ()))
        expected = baseline * scale
        lift = (recent + 1.0) / (expected + 1.0)
        if lift < MIN_LIFT:
            continue
        # Phrases that appear in headlines (not only in snippets) make better topics.
        in_titles = title_hits[key] / recent
        if in_titles < 0.25 or key in GENERIC_PHRASES:
            continue
        score = len(sources) * math.log2(lift) * (0.4 + in_titles) * (1 + 0.1 * key.count(" "))
        candidates.append({
            "key": key,
            "recent": recent,
            "baseline": baseline,
            "sources": len(sources),
            "lift": round(lift, 2),
            "score": score,
            "docs": docs,
        })

    # Prefer the more specific phrase when two overlap ("Bank of England" over "England").
    by_key = {c["key"]: c for c in candidates}
    drop: set[str] = set()
    for c in candidates:
        words = c["key"].split()
        for size in range(1, len(words)):
            for i in range(len(words) - size + 1):
                part = " ".join(words[i:i + size])
                shorter = by_key.get(part)
                if not shorter:
                    continue
                if c["recent"] >= 0.6 * shorter["recent"]:
                    drop.add(part)          # the long phrase explains the short one
                else:
                    drop.add(c["key"])      # the short phrase is the real topic
    candidates = [c for c in candidates if c["key"] not in drop]
    candidates.sort(key=lambda c: (-c["score"], c["key"]))

    chosen: list[dict] = []
    for c in candidates:
        # Skip a phrase that is about the same stories as a topic already chosen
        # ("Brussels summit" after "EU", "rates steady" after "Federal Reserve").
        c["story_set"] = {articles[i].get("story") or f"a{i}" for i in c["docs"]}
        overlaps = any(
            len(c["story_set"] & other["story_set"]) / max(1, min(len(c["story_set"]), len(other["story_set"]))) >= 0.7
            for other in chosen
        )
        if not overlaps:
            chosen.append(c)
        if len(chosen) >= MAX_TOPICS:
            break

    # Which stories mention each topic (best-ranked first).
    story_rank = {s["id"]: rank for rank, s in enumerate(stories)}
    previous_rank = {}
    if previous:
        for rank, topic in enumerate(previous.get("topics", [])):
            previous_rank[topic.get("key")] = rank

    topics = []
    for rank, c in enumerate(chosen):
        pattern = re.compile(r"\b" + re.escape(c["key"]) + r"\b", re.I)
        story_ids = [
            s["id"] for s in stories
            if any(pattern.search(f"{a['title']} {a.get('snippet', '')}") for a in s["articles"])
        ]
        story_ids.sort(key=lambda sid: story_rank.get(sid, 10**9))

        hourly = [0] * SPARK_HOURS
        for index in c["docs"] | base_docs.get(c["key"], set()):
            age_hours = int((now - times[index]).total_seconds() // 3600)
            if 0 <= age_hours < SPARK_HOURS:
                hourly[SPARK_HOURS - 1 - age_hours] += 1

        if c["key"] in previous_rank:
            delta = previous_rank[c["key"]] - rank
            change = "up" if delta > 0 else "down" if delta < 0 else "same"
        else:
            change = "new"

        topics.append({
            "key": c["key"],
            "label": display[c["key"]].most_common(1)[0][0],
            "recent": c["recent"],
            "baseline": c["baseline"],
            "sources": c["sources"],
            "lift": c["lift"],
            "change": change,
            "stories": story_ids[:40],
            "hourly": hourly,
        })

    return {
        "window_hours": int(RECENT.total_seconds() // 3600),
        "baseline_hours": int(BASELINE.total_seconds() // 3600),
        "topics": topics,
    }
