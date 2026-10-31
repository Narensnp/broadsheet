// Everything the site remembers on this device (bookmarks, read stories,
// hidden sources, theme). Stored in localStorage; every access is wrapped in
// try/catch because storage can be full, disabled, or blocked in private mode.
// If storage fails we keep working from memory for the current visit.

const PREFIX = 'bs:';
const memory = new Map();

function read(key, fallback) {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw !== null) return JSON.parse(raw);
  } catch (err) {
    /* storage unavailable: fall through to memory */
  }
  return memory.has(key) ? memory.get(key) : fallback;
}

function write(key, value) {
  memory.set(key, value);
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (err) {
    return false;
  }
}

const listeners = new Set();
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(kind) {
  listeners.forEach((fn) => fn(kind));
}

/* --- Theme --------------------------------------------------------------- */

export function getTheme() {
  try {
    const value = window.localStorage.getItem(PREFIX + 'theme');
    if (value === 'light' || value === 'dark') return value;
  } catch (err) {
    /* ignore */
  }
  return memory.get('theme') || 'system';
}

export function setTheme(value) {
  memory.set('theme', value);
  try {
    if (value === 'system') window.localStorage.removeItem(PREFIX + 'theme');
    else window.localStorage.setItem(PREFIX + 'theme', value);
  } catch (err) {
    /* ignore */
  }
  emit('theme');
}

/* --- Bookmarks ------------------------------------------------------------ */

export function getBookmarks() {
  const value = read('bookmarks', {});
  return value && typeof value === 'object' ? value : {};
}

export function isBookmarked(id) {
  return Boolean(getBookmarks()[id]);
}

// We save a small copy of the story so it stays readable after it drops out
// of the 7-day news window.
export function toggleBookmark(story) {
  const all = getBookmarks();
  let saved;
  if (all[story.id]) {
    delete all[story.id];
    saved = false;
  } else {
    all[story.id] = {
      id: story.id,
      title: story.title,
      snippet: story.snippet,
      link: story.link,
      source: story.source,
      country: story.country,
      thumb: story.thumb,
      category: story.category,
      categories: story.categories,
      first_seen: story.first_seen,
      updated: story.updated,
      n_sources: story.n_sources,
      countries: story.countries,
      articles: (story.articles || []).slice(0, 40),
      lead: story.lead,
      savedAt: new Date().toISOString(),
    };
    saved = true;
  }
  const ok = write('bookmarks', all);
  emit('bookmarks');
  return { saved, persisted: ok };
}

export function clearBookmarks() {
  write('bookmarks', {});
  emit('bookmarks');
}

/* --- Read tracking -------------------------------------------------------- */

const READ_LIMIT = 3000;
const READ_MAX_AGE = 10 * 24 * 3600 * 1000;

export function getRead() {
  const value = read('read', {});
  return value && typeof value === 'object' ? value : {};
}

export function isRead(id) {
  return Boolean(getRead()[id]);
}

export function markRead(id) {
  const all = getRead();
  if (all[id]) return;
  all[id] = Date.now();
  const now = Date.now();
  let entries = Object.entries(all).filter(([, t]) => now - t < READ_MAX_AGE);
  if (entries.length > READ_LIMIT) {
    entries.sort((a, b) => b[1] - a[1]);
    entries = entries.slice(0, READ_LIMIT);
  }
  write('read', Object.fromEntries(entries));
  emit('read');
}

export function clearRead() {
  write('read', {});
  emit('read');
}

/* --- Hidden sources -------------------------------------------------------- */

export function getHiddenSources() {
  const value = read('hidden', []);
  return new Set(Array.isArray(value) ? value : []);
}

export function setSourceHidden(name, hidden) {
  const set = getHiddenSources();
  if (hidden) set.add(name);
  else set.delete(name);
  write('hidden', [...set]);
  emit('hidden');
}

export function showAllSources() {
  write('hidden', []);
  emit('hidden');
}
