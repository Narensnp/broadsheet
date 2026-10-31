// Loading the JSON files the collector produces, and helpers to look stories up.
//
// Opening the app: if this device has data from a previous visit (kept by the
// service worker), we show that instantly and quietly check for newer data in
// the background. If newer data exists, the app is told via onUpdateAvailable.

import { CATEGORIES, DATA_CACHE } from './config.js';
import { getHiddenSources } from './store.js';

const memo = new Map();        // file name -> Promise<data>
const stories = new Map();     // story id -> story
let preferCache = true;        // only during the first load after opening
const generatedOf = new Map(); // file name -> timestamp of the copy we're showing
const updateListeners = new Set();

function fileUrl(name) {
  return new URL(`data/${name}.json`, document.baseURI).href;
}

async function fromCache(name) {
  try {
    if (!('caches' in window)) return null;
    const cache = await caches.open(DATA_CACHE);
    const hit = await cache.match(fileUrl(name));
    return hit ? await hit.json() : null;
  } catch (err) {
    return null;
  }
}

async function fromNetwork(name) {
  const response = await fetch(fileUrl(name), { cache: 'no-cache' });
  if (!response.ok) {
    const error = new Error(`Could not load ${name}.json (HTTP ${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/** Timestamp of the oldest data file currently shown ('' if none loaded yet). */
function oldestShown() {
  let oldest = '';
  for (const stamp of generatedOf.values()) {
    if (stamp && (!oldest || stamp < oldest)) oldest = stamp;
  }
  return oldest;
}

function announce(stamp) {
  updateListeners.forEach((fn) => fn(stamp));
}

function remember(name, data) {
  if (!data) return data;
  if (data.generated) {
    // A file just arrived that is newer than something already on screen
    // (e.g. you opened Status after reading Top stories): offer a refresh.
    const oldest = oldestShown();
    generatedOf.set(name, data.generated);
    if (oldest && data.generated > oldest) announce(data.generated);
  }
  for (const story of Array.isArray(data.stories) ? data.stories : []) {
    const existing = stories.get(story.id);
    if (!existing || (story.updated || '') >= (existing.updated || '')) stories.set(story.id, story);
  }
  return data;
}

async function load(name) {
  if (preferCache) {
    const cached = await fromCache(name);
    if (cached) {
      fromNetwork(name)
        .then((fresh) => {
          if (fresh.generated && cached.generated && fresh.generated > cached.generated) {
            announce(fresh.generated);
          }
        })
        .catch(() => {});
      return remember(name, cached);
    }
  }
  try {
    return remember(name, await fromNetwork(name));
  } catch (err) {
    // Offline and not cached by the service worker yet? Try the cache anyway.
    const cached = await fromCache(name);
    if (cached) return remember(name, cached);
    throw err;
  }
}

export function getFile(name) {
  if (!memo.has(name)) {
    const promise = load(name);
    memo.set(name, promise);
    promise.catch(() => memo.delete(name));
  }
  return memo.get(name);
}

export const getTop = () => getFile('top');
export const getCategory = (id) => getFile(id);
export const getTrending = () => getFile('trending').catch(() => ({ topics: [] }));
export const getStatus = () => getFile('status');
export const getSources = () => getFile('sources');

/** Load every section so search and topics can see all stories. */
export async function loadAll() {
  const results = await Promise.allSettled([getTop(), ...CATEGORIES.map((c) => getCategory(c.id))]);
  if (results.every((r) => r.status === 'rejected')) throw results[0].reason;
}

export function allStories() {
  return [...stories.values()];
}

export async function findStory(id) {
  if (stories.has(id)) return stories.get(id);
  await loadAll().catch(() => {});
  return stories.get(id) || null;
}

/** Forget loaded data so the next request fetches fresh files. */
export function resetData() {
  memo.clear();
  stories.clear();
  generatedOf.clear();
  preferCache = false;
}

export function endBootPhase() {
  preferCache = false;
}

export function dataTimestamp() {
  return oldestShown();
}

export function onUpdateAvailable(fn) {
  updateListeners.add(fn);
}

/** Small file that changes on every collector run; used to detect new data. */
export async function checkForUpdate() {
  try {
    const response = await fetch(new URL(`data/version.json?t=${Date.now()}`, document.baseURI), {
      cache: 'no-store',
    });
    if (!response.ok) return false;
    const version = await response.json();
    const shown = oldestShown();
    return Boolean(version.generated && shown && version.generated > shown);
  } catch (err) {
    return false;
  }
}

/* --- Hidden sources --------------------------------------------------------- */

/**
 * Return the story as this reader should see it: articles from hidden sources
 * removed and the lead re-picked if needed. Returns null if nothing is left.
 */
export function visible(story, hidden = getHiddenSources()) {
  if (!story) return null;
  if (!hidden.size) return story;
  const articles = (story.articles || []).filter((a) => !hidden.has(a.source));
  if (!articles.length) return null;
  if (articles.length === (story.articles || []).length) return story;
  let lead = articles.find((a) => a.id === story.lead);
  if (!lead) lead = articles.find((a) => a.thumb) || articles[articles.length - 1];
  const sources = new Set(articles.map((a) => a.source));
  const countries = [];
  const seen = new Set();
  for (const a of articles) {
    if (!seen.has(a.source)) {
      seen.add(a.source);
      if (a.country && !countries.includes(a.country)) countries.push(a.country);
    }
  }
  return {
    ...story,
    lead: lead.id,
    title: lead.title,
    snippet: lead.snippet,
    link: lead.link,
    source: lead.source,
    country: lead.country,
    thumb: lead.thumb,
    articles,
    n_sources: sources.size,
    n_articles: articles.length,
    countries,
    hiddenCount: (story.articles || []).length - articles.length,
  };
}

export function visibleList(list) {
  const hidden = getHiddenSources();
  return list.map((s) => visible(s, hidden)).filter(Boolean);
}
