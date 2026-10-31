// Broadsheet app: routing, shared interactions, keyboard shortcuts, live updates.

import { UPDATE_CHECK_MS } from './config.js';
import {
  allStories, checkForUpdate, dataTimestamp, endBootPhase, getTop, onUpdateAvailable, resetData,
} from './data.js';
import {
  getBookmarks, getTheme, isBookmarked, markRead, onChange, setTheme, toggleBookmark,
} from './store.js';
import { refreshTimes, timeAgo, toast } from './ui.js';
import * as views from './views.js';

const main = document.getElementById('main');
const pill = document.getElementById('new-pill');
const bootTime = Date.now();

/* --- Routing ------------------------------------------------------------------------ */

function parseRoute(hash = location.hash) {
  const raw = hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  const parts = path.split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch (err) { return p; }
  });
  if (!parts.length) return { name: 'home', section: 'top', params };
  const [first, second] = parts;
  switch (first) {
    case 'c': return { name: 'category', section: second, params: { ...params, id: second } };
    case 'story': return { name: 'story', section: null, params: { ...params, id: second || '' } };
    case 'brief': return { name: 'brief', section: 'brief', params };
    case 'topic': return { name: 'topic', section: null, params: { ...params, key: parts.slice(1).join('/') } };
    case 'search': return { name: 'search', section: 'search', params };
    case 'saved': return { name: 'saved', section: 'saved', params };
    case 'settings':
    case 'sources': return { name: 'settings', section: 'settings', params };
    case 'status': return { name: 'status', section: 'status', params };
    default: return { name: 'notFound', section: null, params };
  }
}

const scrollPositions = new Map();
let currentHash = location.hash || '#/';
let renderToken = 0;
let inAppNavigations = 0;
let firstRender = true;

function markNav(section) {
  document.querySelectorAll('[data-nav]').forEach((link) => {
    if (link.dataset.nav === section) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

async function render({ restoreScroll = false, animate = true } = {}) {
  const token = ++renderToken;
  const route = parseRoute();
  markNav(route.section);
  currentIndex = -1;
  main.classList.remove('view-enter');
  main.className = 'view wrap';
  if (animate && !firstRender) {
    void main.offsetWidth; // restart the entrance animation
    main.classList.add('view-enter');
  }
  const view = views[route.name] || views.notFound;
  let title = 'Broadsheet';
  try {
    title = await view(main, route.params);
  } catch (err) {
    console.error(err);
    if (token === renderToken) {
      main.innerHTML = '<div class="empty"><h2>Something went wrong</h2><p>This page could not be shown. Reload to try again.</p><button class="button" type="button" data-action="reload">Reload</button></div>';
    }
  }
  if (token !== renderToken) return;
  document.title = title || 'Broadsheet';
  refreshTimes(main);
  updateDateline();
  const saved = scrollPositions.get(location.hash || '#/');
  if (restoreScroll && saved != null) {
    requestAnimationFrame(() => window.scrollTo(0, saved));
  } else if (!firstRender) {
    window.scrollTo(0, 0);
  }
  if (!firstRender && route.name !== 'search') main.focus({ preventScroll: true });
  firstRender = false;
}

// Each history entry gets a number so we can tell "Back" from a new visit and
// restore the scroll position only when going back.
let navCounter = 0;
history.replaceState({ nav: 0 }, '');

window.addEventListener('hashchange', () => {
  scrollPositions.set(currentHash, window.scrollY);
  const state = history.state;
  let isBack = false;
  if (state && typeof state.nav === 'number' && state.nav < navCounter) {
    isBack = true;
    navCounter = state.nav;
  } else {
    navCounter += 1;
    history.replaceState({ nav: navCounter }, '');
  }
  currentHash = location.hash || '#/';
  inAppNavigations += 1;
  render({ restoreScroll: isBack });
});

/* --- Theme --------------------------------------------------------------------------- */

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function effectiveTheme() {
  const chosen = getTheme();
  return chosen === 'system' ? (darkQuery.matches ? 'dark' : 'light') : chosen;
}

function applyTheme() {
  const chosen = getTheme();
  const root = document.documentElement;
  if (chosen === 'system') delete root.dataset.theme;
  else root.dataset.theme = chosen;
  const effective = effectiveTheme();
  root.dataset.effectiveTheme = effective;
  const color = effective === 'dark' ? '#121417' : '#f3f4f1';
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', color));
  const button = document.getElementById('theme-toggle');
  if (button) {
    const next = effective === 'dark' ? 'light' : 'dark';
    button.setAttribute('aria-label', `Switch to ${next} theme`);
    button.title = `Switch to ${next} theme`;
  }
}

document.getElementById('theme-toggle')?.addEventListener('click', () => {
  setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark');
});
darkQuery.addEventListener?.('change', applyTheme);
onChange((kind) => {
  if (kind === 'theme') applyTheme();
});

/* --- Dateline ------------------------------------------------------------------------ */

const todayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

function updateDateline() {
  const today = document.getElementById('today');
  const updated = document.getElementById('updated');
  if (today) today.textContent = todayFormat.format(new Date());
  const stamp = dataTimestamp();
  if (updated) updated.textContent = stamp ? `Updated ${timeAgo(stamp).toLowerCase()}` : '';
}

/* --- Story lookups for buttons --------------------------------------------------------- */

function storyFor(element) {
  const holder = element.closest('[data-id]') || element.closest('[data-story]');
  if (!holder) return null;
  const id = holder.dataset.id || holder.dataset.story;
  return allStories().find((s) => s.id === id) || getBookmarks()[id] || null;
}

function syncSaveButtons(id) {
  const saved = isBookmarked(id);
  document.querySelectorAll(`[data-id="${CSS.escape(id)}"] [data-save]`).forEach((button) => {
    button.setAttribute('aria-pressed', String(saved));
    const label = button.querySelector('span');
    if (label) label.textContent = saved ? 'Saved' : 'Save';
    else {
      const title = button.getAttribute('aria-label').replace(/^(Save story|Remove from saved): /, '');
      button.setAttribute('aria-label', `${saved ? 'Remove from saved' : 'Save story'}: ${title}`);
    }
  });
}

function toggleSave(story, button) {
  if (!story) return;
  const result = toggleBookmark(story);
  syncSaveButtons(story.id);
  if (button) {
    button.classList.remove('pop');
    void button.offsetWidth;
    if (result.saved) button.classList.add('pop');
  }
  toast(result.saved
    ? (result.persisted ? 'Saved' : 'Saved for this visit (this browser is not allowing storage)')
    : 'Removed from saved');
  if (!result.saved && parseRoute().name === 'saved') render({ animate: false });
}

function markOpened(element) {
  const holder = element.closest('[data-id]') || element.closest('[data-story]');
  if (!holder) return;
  const id = holder.dataset.id || holder.dataset.story;
  markRead(id);
  document.querySelectorAll(`.story[data-id="${CSS.escape(id)}"]`).forEach((card) => {
    if (!card.classList.contains('story-view-head')) card.classList.add('is-read');
  });
}

/* --- Clicks ------------------------------------------------------------------------------ */

document.addEventListener('click', (event) => {
  const save = event.target.closest('[data-save]');
  if (save) {
    event.preventDefault();
    toggleSave(storyFor(save), save);
    return;
  }
  const open = event.target.closest('[data-open], [data-compare]');
  if (open) markOpened(open);

  const action = event.target.closest('[data-action]');
  if (action) {
    const name = action.dataset.action;
    if (name === 'reload') {
      resetData();
      render({ animate: false });
    } else if (name === 'back') {
      if (inAppNavigations > 0 && history.length > 1) history.back();
      else location.hash = '#/';
    } else if (name === 'clear-saved' || name === 'clear-read' || name === 'show-all-sources') {
      const changed = views.settingsActions(name, main);
      if (changed && parseRoute().name === 'saved') render({ animate: false });
    }
  }
});

/* --- Images: fade in when loaded, fall back to the illustration if broken -------------- */

document.addEventListener('load', (event) => {
  if (event.target instanceof HTMLImageElement) event.target.classList.remove('is-loading');
}, true);
document.addEventListener('error', (event) => {
  if (event.target instanceof HTMLImageElement && event.target.classList.contains('thumb')) {
    event.target.remove();
  }
}, true);

/* --- Live updates ------------------------------------------------------------------------- */

let lastCheck = Date.now();

function showPill() {
  pill.hidden = false;
  requestAnimationFrame(() => pill.classList.add('is-visible'));
}

function hidePill() {
  pill.classList.remove('is-visible');
  setTimeout(() => { pill.hidden = true; }, 300);
}

async function applyUpdate({ silent = false } = {}) {
  hidePill();
  resetData();
  await render({ animate: !silent });
  if (!silent) {
    window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    toast('Showing the latest stories');
  }
}

pill.addEventListener('click', () => applyUpdate());

onUpdateAvailable(() => {
  // Just opened and not scrolled yet: swap in the fresh news quietly.
  const fresh = Date.now() - bootTime < 4000 && window.scrollY < 80 && parseRoute().name !== 'search';
  if (fresh) applyUpdate({ silent: true });
  else showPill();
});

async function lookForUpdates() {
  lastCheck = Date.now();
  if (await checkForUpdate()) showPill();
}

setInterval(() => {
  if (document.visibilityState === 'visible') lookForUpdates();
}, UPDATE_CHECK_MS);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refreshTimes();
    updateDateline();
    if (Date.now() - lastCheck > 60 * 1000) lookForUpdates();
  }
});

setInterval(() => {
  refreshTimes();
  updateDateline();
}, 30 * 1000);

/* --- Keyboard shortcuts (desktop) --------------------------------------------------------- */

let currentIndex = -1;

function cards() {
  return [...main.querySelectorAll('.story[data-id]')].filter((el) => el.offsetParent !== null);
}

function select(index) {
  const list = cards();
  if (!list.length) return;
  currentIndex = Math.max(0, Math.min(index, list.length - 1));
  list.forEach((card) => card.classList.remove('is-current'));
  const card = list[currentIndex];
  card.classList.add('is-current');
  card.focus({ preventScroll: true });
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  card.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
}

function selectedCard() {
  const list = cards();
  const focused = document.activeElement?.closest?.('.story[data-id]');
  if (focused && list.includes(focused)) return focused;
  return list[currentIndex] || null;
}

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  const typing = target.closest?.('input, textarea, select, [contenteditable="true"]');
  if (typing) {
    if (event.key === 'Escape') target.blur();
    return;
  }
  const dialog = document.getElementById('shortcuts');
  if (dialog?.open) return;

  switch (event.key) {
    case '/':
      event.preventDefault();
      if (parseRoute().name === 'search') document.getElementById('search-input')?.focus();
      else location.hash = '#/search';
      break;
    case 'j':
      event.preventDefault();
      select(currentIndex + 1);
      break;
    case 'k':
      event.preventDefault();
      select(currentIndex <= 0 ? 0 : currentIndex - 1);
      break;
    case 'o': {
      const card = selectedCard();
      const link = card?.querySelector('[data-open]');
      if (link) {
        markOpened(link);
        window.open(link.href, '_blank', 'noopener,noreferrer');
      }
      break;
    }
    case 'c': {
      const compare = selectedCard()?.querySelector('[data-compare]');
      if (compare) {
        markOpened(compare);
        location.hash = compare.getAttribute('href');
      }
      break;
    }
    case 'b': {
      const card = selectedCard();
      if (card) toggleSave(storyFor(card), card.querySelector('[data-save]'));
      break;
    }
    case '?':
      if (dialog?.showModal) dialog.showModal();
      break;
    default:
  }
});

/* --- Service worker (offline + installable app) ------------------------------------------- */

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Offline support unavailable:', err));
  });
}

/* --- Start ------------------------------------------------------------------------------------ */

applyTheme();
updateDateline();
render().then(() => {
  // After the first screen, always ask the network first.
  setTimeout(endBootPhase, 4000);
  // Warm up the top stories so the dateline shows when the data is from.
  getTop().then(updateDateline).catch(() => {});
});
