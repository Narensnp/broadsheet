"""Grouping articles about the same event into stories, and ranking them.

How the grouping works, in plain words
--------------------------------------
1. Every article becomes a list of word weights (TF-IDF): words that are rare
   across all the news, like "Kishida" or "semiconductor", weigh a lot;
   common words like "said" weigh almost nothing.
2. Two articles are "similar" when their weighted words overlap a lot
   (cosine similarity, a number from 0 = nothing in common to 1 = identical).
3. We join the most similar pairs first. Two groups are only merged if
   (a) everything in them was published within 48 hours of each other and
   (b) the groups as a whole are still about the same thing (their average
       word profiles are similar), which stops long chains of loosely
       related articles turning into one giant blob.

How ranking works
-----------------
Every outlet covering a story is a "vote". A vote is worth 1 when the outlet's
article is brand new and halves every HALF_LIFE_HOURS. So 12 outlets in the
last 3 hours easily beat 2 outlets yesterday.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta

import numpy as np
from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS, TfidfVectorizer

from parse import parse_iso
from textutil import jaccard, normalize_title, short_hash, title_tokens

# --- Tuning knobs -----------------------------------------------------------
PAIR_THRESHOLD = 0.30       # how similar two articles must be to link them
GROUP_THRESHOLD = 0.22      # how similar two whole groups must be to merge
MAX_SPAN = timedelta(hours=48)
HALF_LIFE_HOURS = 10.0
CHUNK = 800                 # rows compared at once (keeps memory small)

NEWS_STOP_WORDS = {
    "says", "said", "say", "new", "news", "live", "latest", "update", "updates",
    "watch", "video", "videos", "photos", "pictures", "report", "reports",
    "today", "yesterday", "week", "year", "years", "day", "days", "time",
    "just", "like", "want", "make", "makes", "know", "get", "gets", "got",
    "people", "according", "including", "told", "according", "also", "could",
    "would", "may", "might", "will", "one", "two", "three", "first", "last",
    "amid", "us", "mr", "ms", "s", "t", "ve", "ll", "don", "doesn", "isn",
    "read", "story", "article", "opinion", "analysis", "explainer", "podcast",
    "newsletter", "briefing", "comments", "via",
}


def _source_words(names: list[str]) -> set[str]:
    words: set[str] = set()
    for name in names:
        words.update(normalize_title(name).split())
    return {w for w in words if len(w) > 1}


def dedupe_titles(articles: list[dict]) -> list[dict]:
    """Remove near-identical headlines from the same outlet (e.g. one article in two feeds)."""
    by_source: dict[str, list[dict]] = defaultdict(list)
    for article in articles:
        by_source[article["source"]].append(article)

    kept: list[dict] = []
    for items in by_source.values():
        # Prefer the version with a picture and the earliest sighting.
        items.sort(key=lambda a: (not a.get("thumb"), a["seen"]))
        exact: dict[str, dict] = {}
        survivors: list[tuple[dict, set[str], datetime]] = []
        for article in items:
            key = normalize_title(article["title"])
            if key in exact:
                continue
            tokens = title_tokens(article["title"])
            when = parse_iso(article["published"])
            duplicate = False
            if len(tokens) >= 5:
                for other, other_tokens, other_when in survivors:
                    if abs(when - other_when) <= MAX_SPAN and jaccard(tokens, other_tokens) >= 0.85:
                        duplicate = True
                        break
            if duplicate:
                continue
            exact[key] = article
            survivors.append((article, tokens, when))
            kept.append(article)
    return kept


class _Groups:
    """Union-find that also tracks each group's time span and word profile."""

    def __init__(self, matrix, times: np.ndarray):
        n = matrix.shape[0]
        self.parent = list(range(n))
        self.lo = times.copy()
        self.hi = times.copy()
        self.vec = [matrix[i] for i in range(n)]  # sparse row sums
        self.norm = [1.0] * n                     # rows are already unit length

    def find(self, i: int) -> int:
        while self.parent[i] != i:
            self.parent[i] = self.parent[self.parent[i]]
            i = self.parent[i]
        return i

    def try_merge(self, a: int, b: int, span_seconds: float, threshold: float) -> bool:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return False
        lo = min(self.lo[ra], self.lo[rb])
        hi = max(self.hi[ra], self.hi[rb])
        if hi - lo > span_seconds:
            return False
        dot = float(self.vec[ra].multiply(self.vec[rb]).sum())
        if dot / (self.norm[ra] * self.norm[rb] + 1e-12) < threshold:
            return False
        self.parent[rb] = ra
        self.lo[ra], self.hi[ra] = lo, hi
        merged = self.vec[ra] + self.vec[rb]
        self.vec[ra] = merged
        self.norm[ra] = float(np.sqrt(merged.multiply(merged).sum()))
        self.vec[rb] = None
        return True


def cluster_articles(articles: list[dict], source_names: list[str]):
    """Return (groups, matrix). Each group is a list of article indexes = one story.

    ``matrix`` holds the TF-IDF rows (or None when there was nothing to compare).
    """
    n = len(articles)
    if n == 0:
        return [], None
    if n == 1:
        return [[0]], None

    stop_words = list(ENGLISH_STOP_WORDS | NEWS_STOP_WORDS | _source_words(source_names))
    texts = [f"{a['title']}. {a['title']}. {a.get('snippet', '')}" for a in articles]
    vectorizer = TfidfVectorizer(
        stop_words=stop_words,
        ngram_range=(1, 2),
        sublinear_tf=True,
        strip_accents="unicode",
        lowercase=True,
        min_df=1,
        max_df=0.4,
        token_pattern=r"(?u)\b[^\W\d_][\w'-]+\b",
    )
    try:
        matrix = vectorizer.fit_transform(texts).tocsr().astype(np.float32)
    except ValueError:  # e.g. every word was a stop word
        return [[i] for i in range(n)], None

    times = np.array([parse_iso(a["published"]).timestamp() for a in articles], dtype=np.float64)
    span = MAX_SPAN.total_seconds()

    # Collect candidate pairs above the threshold, a chunk of rows at a time.
    rows, cols, sims = [], [], []
    transposed = matrix.T.tocsc()
    for start in range(0, n, CHUNK):
        block = (matrix[start:start + CHUNK] @ transposed).tocoo()
        r = block.row + start
        mask = (block.col > r) & (block.data >= PAIR_THRESHOLD)
        r, c, d = r[mask], block.col[mask], block.data[mask]
        close_in_time = np.abs(times[r] - times[c]) <= span
        rows.append(r[close_in_time])
        cols.append(c[close_in_time])
        sims.append(d[close_in_time])

    groups = _Groups(matrix, times)
    if rows:
        all_rows = np.concatenate(rows)
        all_cols = np.concatenate(cols)
        all_sims = np.concatenate(sims)
        for idx in np.argsort(-all_sims, kind="stable"):
            groups.try_merge(int(all_rows[idx]), int(all_cols[idx]), span, GROUP_THRESHOLD)

    buckets: dict[int, list[int]] = defaultdict(list)
    for i in range(n):
        buckets[groups.find(i)].append(i)
    return list(buckets.values()), matrix


def _decay(age_hours: float) -> float:
    return 0.5 ** (max(age_hours, 0.0) / HALF_LIFE_HOURS)


def build_stories(
    articles: list[dict],
    groups: list[list[int]],
    matrix,
    previous_story_of: dict[str, str],
    now: datetime,
) -> list[dict]:
    """Turn index groups into story dicts with lead article, coverage and score."""
    # Largest groups pick their (stable) ids first.
    order = sorted(range(len(groups)), key=lambda g: -len(groups[g]))
    taken: set[str] = set()
    stories: list[dict] = []

    for g in order:
        members = groups[g]
        items = [articles[i] for i in members]

        # Keep a story's id between runs so links and bookmarks keep working.
        votes = Counter(previous_story_of[a["id"]] for a in items if a["id"] in previous_story_of)
        story_id = ""
        for candidate, _ in votes.most_common():
            if candidate not in taken:
                story_id = candidate
                break
        if not story_id:
            earliest = min(items, key=lambda a: (a["published"], a["id"]))
            story_id = short_hash("story:" + earliest["id"], 12)
            while story_id in taken:
                story_id = short_hash(story_id + "+", 12)
        taken.add(story_id)

        # Lead article: the one closest to the group's centre, preferring a picture.
        if matrix is not None and len(members) > 1:
            sub = matrix[members]
            centre = np.asarray(sub.mean(axis=0)).ravel()
            closeness = np.asarray(sub @ centre).ravel()
            closeness = closeness / (closeness.max() + 1e-9)
        else:
            closeness = np.ones(len(members))
        best, best_score = 0, -1.0
        for k, article in enumerate(items):
            score = float(closeness[k])
            if article.get("thumb"):
                score += 0.25
            if len((article.get("snippet") or "").split()) >= 15:
                score += 0.05
            if score > best_score:
                best, best_score = k, score
        lead = items[best]

        # Coverage: one vote per outlet, using that outlet's freshest article.
        freshest: dict[str, float] = {}
        for article in items:
            age = (now - parse_iso(article["published"])).total_seconds() / 3600
            freshest[article["source"]] = max(freshest.get(article["source"], 0.0), _decay(age))
        country_counts = Counter()
        seen_sources = set()
        for article in sorted(items, key=lambda a: a["published"]):
            if article["source"] not in seen_sources:
                seen_sources.add(article["source"])
                if article.get("country"):
                    country_counts[article["country"]] += 1
        countries = [c for c, _ in country_counts.most_common()]
        diversity = min(1.0 + 0.04 * max(len(countries) - 1, 0), 1.4)
        score = sum(freshest.values()) * diversity

        category_counts = Counter(a["category"] for a in items)
        top_count = max(category_counts.values())
        primary = lead["category"] if category_counts[lead["category"]] == top_count else category_counts.most_common(1)[0][0]
        categories = [primary] + sorted(
            c for c, count in category_counts.items()
            if c != primary and count / len(items) >= 0.25
        )

        for article in items:
            article["story"] = story_id

        ordered = sorted(items, key=lambda a: (a["published"], a["source"]))
        stories.append({
            "id": story_id,
            "lead": lead["id"],
            "title": lead["title"],
            "snippet": lead.get("snippet", ""),
            "link": lead["link"],
            "source": lead["source"],
            "homepage": lead.get("homepage", ""),
            "country": lead.get("country", ""),
            "thumb": lead.get("thumb", ""),
            "category": primary,
            "categories": categories,
            "first_seen": ordered[0]["published"],
            "updated": ordered[-1]["published"],
            "n_sources": len(freshest),
            "n_articles": len(items),
            "countries": countries,
            "score": round(score, 4),
            "articles": [
                {
                    "id": a["id"],
                    "title": a["title"],
                    "link": a["link"],
                    "source": a["source"],
                    "homepage": a.get("homepage", ""),
                    "country": a.get("country", ""),
                    "region": a.get("region", ""),
                    "category": a["category"],
                    "published": a["published"],
                    "snippet": a.get("snippet", ""),
                    "thumb": a.get("thumb", ""),
                }
                for a in ordered
            ],
        })

    stories.sort(key=lambda s: (-s["score"], s["id"]))
    return stories
