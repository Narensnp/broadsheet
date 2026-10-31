// Building blocks for the page: escaping, times, icons and story cards.

import { CATEGORY_BY_ID, REGIONS } from './config.js';
import { isBookmarked, isRead } from './store.js';

/* --- Text helpers ------------------------------------------------------------ */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/** Only allow real web links in href/src (never javascript: or data:). */
export function safeUrl(url) {
  try {
    const parsed = new URL(url, document.baseURI);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch (err) {
    return '';
  }
}

/** Escape text and wrap search terms in <mark>. */
export function highlight(text, terms) {
  const value = String(text ?? '');
  if (!terms || !terms.length) return esc(value);
  const pattern = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return value
    .split(pattern)
    .map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part)))
    .join('');
}

export function plural(n, word, many = `${word}s`) {
  return `${n} ${n === 1 ? word : many}`;
}

/* --- Time -------------------------------------------------------------------- */

const absoluteFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
});
const dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

export function timeAgo(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.round((now - then) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return dateFormat.format(new Date(then));
}

export function absoluteTime(iso) {
  const then = Date.parse(iso);
  return Number.isNaN(then) ? '' : absoluteFormat.format(new Date(then));
}

export function timeTag(iso) {
  return `<time datetime="${esc(iso)}" data-ago title="${esc(absoluteTime(iso))}">${esc(timeAgo(iso))}</time>`;
}

/** Refresh every "12 min ago" label on the page. */
export function refreshTimes(root = document) {
  const now = Date.now();
  root.querySelectorAll('time[data-ago]').forEach((el) => {
    const text = timeAgo(el.getAttribute('datetime'), now);
    if (el.textContent !== text) el.textContent = text;
  });
}

/* --- Icons (inline SVG, stroke = currentColor) ---------------------------------- */

const svg = (paths, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"${extra}>${paths}</svg>`;

export const icons = {
  bookmark: svg('<path d="M6 3.5h12a.5.5 0 0 1 .5.5v16.2a.3.3 0 0 1-.48.24L12 16l-6.02 4.44a.3.3 0 0 1-.48-.24V4a.5.5 0 0 1 .5-.5z"/>'),
  external: svg('<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  rising: svg('<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>'),
  arrowUp: svg('<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>'),
  layers: svg('<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>'),
};

/* --- Story pieces ----------------------------------------------------------------- */

export function regionClass(region) {
  return REGIONS[region] || '';
}

/** One segment per outlet, coloured by the outlet's region. */
export function coverageBar(story, max = 16) {
  const seen = new Set();
  const segments = [];
  for (const article of story.articles || []) {
    if (seen.has(article.source)) continue;
    seen.add(article.source);
    segments.push(`<i class="${regionClass(article.region)}" title="${esc(article.source)}${article.country ? ` (${esc(article.country)})` : ''}"></i>`);
  }
  return `<span class="coverage-bar" aria-hidden="true">${segments.slice(0, max).join('')}</span>`;
}

export function coverageLabel(story) {
  const countries = (story.countries || []).length;
  return `Covered by ${plural(story.n_sources, 'source')} · ${plural(countries, 'country', 'countries')}`;
}

export function coverage(story) {
  if ((story.n_sources || 1) < 2) {
    return `<span class="coverage coverage-single">Single source</span>`;
  }
  return `<a class="coverage" href="#/story/${encodeURIComponent(story.id)}" data-compare>
      ${coverageBar(story)}<span class="coverage-text">${esc(coverageLabel(story))}</span>
    </a>`;
}

function initial(name) {
  const cleaned = String(name || '').replace(/^the\s+/i, '');
  return (cleaned.match(/[A-Za-z0-9]/) || ['B'])[0].toUpperCase();
}

export function fallbackArt(story) {
  return `<div class="fallback" data-initial="${esc(initial(story.source))}" aria-hidden="true"><span>${esc(story.source)}</span></div>`;
}

/**
 * Thumbnail with an elegant fallback. The image is decorative (alt="") because
 * the headline right next to it already says what the story is about; this is
 * the accessible choice for images that would otherwise repeat the headline.
 */
export function media(story, { eager = false } = {}) {
  const src = safeUrl(story.thumb);
  if (!src) return `<div class="media">${fallbackArt(story)}</div>`;
  return `<div class="media">${fallbackArt(story)}<img class="thumb is-loading" src="${esc(src)}" alt="" loading="${eager ? 'eager' : 'lazy'}" decoding="async" referrerpolicy="no-referrer" ${eager ? 'fetchpriority="high"' : ''}></div>`;
}

export function saveButton(story) {
  const saved = isBookmarked(story.id);
  return `<button class="save-btn" type="button" data-save aria-pressed="${saved}" aria-label="${saved ? 'Remove from saved' : 'Save story'}: ${esc(story.title)}">${icons.bookmark}</button>`;
}

export function kicker(story) {
  const cat = CATEGORY_BY_ID[story.category];
  return cat ? `<p class="kicker">${esc(cat.name)}</p>` : '';
}

export function linkAttrs(url) {
  return `href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer"`;
}

/**
 * A story card. Variants: "hero", "card" (grid), "wide" (grid, spans two
 * columns), "row" (compact list).
 */
export function storyCard(story, { variant = 'card', showKicker = true, terms = null, eager = false } = {}) {
  const classes = ['story'];
  if (variant === 'hero') classes.push('hero');
  if (variant === 'wide') classes.push('wide');
  if (isRead(story.id)) classes.push('is-read');
  const titleTag = variant === 'hero' ? 'h2' : 'h3';
  const snippet = story.snippet
    ? `<p class="snippet">${terms ? highlight(story.snippet, terms) : esc(story.snippet)}</p>`
    : '';
  return `
  <article class="${classes.join(' ')}" data-id="${esc(story.id)}" data-cat="${esc(story.category)}" tabindex="-1">
    ${media(story, { eager })}
    <div class="story-body">
      ${showKicker ? kicker(story) : ''}
      <${titleTag} class="story-title"><a ${linkAttrs(story.link)} data-open>${terms ? highlight(story.title, terms) : esc(story.title)}</a></${titleTag}>
      ${snippet}
      <p class="meta"><span class="source">${esc(story.source)}</span>${timeTag(story.updated || story.first_seen)}</p>
    </div>
    <div class="story-foot">${coverage(story)}${saveButton(story)}</div>
  </article>`;
}

export function skeletonCards(count = 6) {
  const card = `<div class="skeleton" aria-hidden="true"><div class="sk sk-media"></div><div class="sk sk-title"></div><div class="sk sk-title short"></div><div class="sk sk-line"></div><div class="sk sk-line short"></div></div>`;
  return `<div class="grid" aria-busy="true">${card.repeat(count)}</div><p class="visually-hidden" role="status">Loading stories</p>`;
}

export function emptyState(title, text, actionHtml = '') {
  return `<div class="empty"><h2>${esc(title)}</h2><p>${esc(text)}</p>${actionHtml}</div>`;
}

/* --- Toast ---------------------------------------------------------------------- */

let toastTimer;
export function toast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2600);
}
