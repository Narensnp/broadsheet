// One function per page. Each receives the <main> element and the route
// parameters, fills the page, and returns the document title.

import { CATEGORIES, CATEGORY_BY_ID } from './config.js';
import {
  allStories, findStory, getCategory, getSources, getStatus, getTop, getTrending,
  loadAll, visible, visibleList,
} from './data.js';
import {
  clearBookmarks, clearRead, getBookmarks, getHiddenSources, getTheme, isBookmarked,
  setSourceHidden, setTheme, showAllSources,
} from './store.js';
import {
  absoluteTime, coverage, coverageBar, coverageLabel, emptyState, esc, icons, kicker,
  linkAttrs, plural, regionClass, skeletonCards, storyCard, timeAgo, timeTag, toast,
} from './ui.js';

/* --- Shared pieces ------------------------------------------------------------- */

function loadError(err) {
  const offline = !navigator.onLine;
  const title = offline ? 'You are offline' : err && err.status === 404 ? 'No news published yet' : 'News could not be loaded';
  const text = offline
    ? 'Connect to the internet to load the latest stories. Stories you have opened before will appear here when they are saved on this device.'
    : err && err.status === 404
      ? 'The news data has not been published yet. If you just set up Broadsheet, run the workflow once from the Actions tab on GitHub.'
      : 'Check your connection and try again.';
  return emptyState(title, text, '<button class="button" type="button" data-action="reload">Try again</button>');
}

function trendingStrip(trending) {
  const topics = (trending && trending.topics) || [];
  if (!topics.length) return '';
  const chips = topics
    .map((t) => {
      const tip = `Mentioned by ${plural(t.sources, 'outlet')} in the last ${trending.window_hours || 6} hours`;
      const isNew = t.change === 'new' ? '<span class="trend">New</span>' : '';
      return `<a class="chip" href="#/topic/${encodeURIComponent(t.key)}" title="${esc(tip)}">${esc(t.label)}${isNew}</a>`;
    })
    .join('');
  return `<section class="trending" aria-label="Rising topics">
      <span class="trending-label">${icons.rising}Rising now</span>
      <div class="chips">${chips}</div>
    </section>`;
}

function leadPackage(list, { showKicker }) {
  const [hero, ...rest] = list;
  const secondary = rest.slice(0, 4);
  return `<section class="lead-package" aria-label="Lead stories">
      ${storyCard(hero, { variant: 'hero', showKicker, eager: true })}
      ${secondary.length ? `<div class="secondary">${secondary.map((s) => storyCard(s, { showKicker })).join('')}</div>` : ''}
    </section>`;
}

// Repeating pattern of 8 cards: one wide card plus one normal card fill the
// first row, then two rows of three. Every row of the 3-column grid stays full.
function storyGrid(list, { showKicker }) {
  return `<div class="grid">${list
    .map((s, i) => storyCard(s, { variant: i % 8 === 0 ? 'wide' : 'card', showKicker }))
    .join('')}</div>`;
}

function storyList(list, opts = {}) {
  return `<div class="list">${list.map((s) => storyCard(s, { showKicker: true, ...opts })).join('')}</div>`;
}

function sectionHead(title, { cat = '', link = '', linkText = '' } = {}) {
  return `<div class="section-head"${cat ? ` data-cat="${esc(cat)}"` : ''}>
      <h2>${cat ? '<span class="dot" aria-hidden="true"></span>' : ''}${esc(title)}</h2>
      ${link ? `<a class="more-link" href="${esc(link)}">${esc(linkText)}</a>` : ''}
    </div>`;
}

/* --- Home ------------------------------------------------------------------------ */

export async function home(el) {
  el.innerHTML = skeletonCards(6);
  let top;
  let trending;
  try {
    [top, trending] = await Promise.all([getTop(), getTrending()]);
  } catch (err) {
    el.innerHTML = loadError(err);
    return 'Broadsheet';
  }
  const list = visibleList(top.stories || []);
  if (!list.length) {
    el.innerHTML = emptyState('No stories to show', 'Every source is hidden, or the collector has not found any news yet.',
      '<a class="button" href="#/settings">Manage sources</a>');
    return 'Broadsheet';
  }
  const rest = list.slice(5);
  el.innerHTML = `
    <h1 class="visually-hidden">Top stories</h1>
    ${trendingStrip(trending)}
    ${leadPackage(list, { showKicker: true })}
    ${rest.length ? sectionHead('More top stories') + storyGrid(rest, { showKicker: true }) : ''}
    <div class="rails" data-rails></div>`;
  fillRails(el.querySelector('[data-rails]'), new Set(list.map((s) => s.id)));
  return 'Broadsheet: global top stories';
}

function fillRails(container, shown) {
  if (!container) return;
  const render = async () => {
    const parts = await Promise.all(
      CATEGORIES.map(async (cat) => {
        try {
          const data = await getCategory(cat.id);
          const picks = visibleList(data.stories || []).filter((s) => !shown.has(s.id)).slice(0, 4);
          if (!picks.length) return '';
          return `<section class="rail" data-cat="${cat.id}" aria-label="${esc(cat.name)}">
              ${sectionHead(cat.name, { cat: cat.id, link: `#/c/${cat.id}`, linkText: `More in ${cat.short}` })}
              ${storyList(picks, { showKicker: false })}
            </section>`;
        } catch (err) {
          return '';
        }
      }),
    );
    if (container.isConnected) container.innerHTML = parts.join('');
  };
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer.disconnect();
        render();
      }
    }, { rootMargin: '600px 0px' });
    observer.observe(container);
  } else {
    render();
  }
}

/* --- Category -------------------------------------------------------------------- */

export async function category(el, { id }) {
  const cat = CATEGORY_BY_ID[id];
  if (!cat) return notFound(el);
  el.innerHTML = `<header class="page-head" data-cat="${cat.id}"><h1 class="page-title">${esc(cat.name)}</h1></header>${skeletonCards(6)}`;
  let data;
  try {
    data = await getCategory(cat.id);
  } catch (err) {
    el.innerHTML = loadError(err);
    return cat.name;
  }
  const list = visibleList(data.stories || []);
  const outlets = new Set(list.flatMap((s) => s.articles.map((a) => a.source)));
  const head = `<header class="page-head" data-cat="${cat.id}">
      <h1 class="page-title">${esc(cat.name)}</h1>
      <p class="page-sub">${plural(list.length, 'story', 'stories')} from ${plural(outlets.size, 'outlet')} this week, ranked by how many outlets cover each one and how recently.</p>
    </header>`;
  if (!list.length) {
    el.innerHTML = head + emptyState('Nothing here yet', 'No stories in this section right now. Check back after the next update.');
    return cat.name;
  }
  const rest = list.slice(5);
  el.innerHTML = `<div data-cat="${cat.id}">${head}
      ${leadPackage(list, { showKicker: false })}
      ${rest.length ? sectionHead(`More in ${cat.name}`, { cat: cat.id }) + storyGrid(rest, { showKicker: false }) : ''}
    </div>`;
  return `${cat.name} · Broadsheet`;
}

/* --- Story view: every outlet's coverage side by side ------------------------------------ */

export async function story(el, { id }) {
  el.innerHTML = skeletonCards(3);
  let found = await findStory(id);
  let archived = false;
  if (!found) {
    found = getBookmarks()[id] || null;
    archived = Boolean(found);
  }
  found = visible(found);
  if (!found) {
    el.innerHTML = emptyState('This story is no longer available',
      'Broadsheet keeps news for seven days. This story has dropped out of that window, or all of its sources are hidden.',
      '<a class="button" href="#/">Go to top stories</a>');
    return 'Story not found · Broadsheet';
  }

  const articles = [...(found.articles || [])].sort((a, b) => a.published.localeCompare(b.published));
  const leadArticle = articles.find((a) => a.id === found.lead) || null;
  const countries = [];
  const regionOf = {};
  for (const a of articles) {
    if (a.country && !countries.includes(a.country)) {
      countries.push(a.country);
      regionOf[a.country] = a.region;
    }
  }
  const multi = found.n_sources > 1;

  const outletCards = articles
    .map((a) => `
      <article class="outlet${a.id === found.lead ? ' is-lead' : ''}">
        <div class="outlet-head">
          <span class="region-swatch ${regionClass(a.region)}" aria-hidden="true"></span>
          <span class="who"><span class="name">${esc(a.source)}</span><span class="where">${esc(a.country || a.region || '')}</span></span>
          ${timeTag(a.published)}
        </div>
        ${a.id === found.lead && multi ? '<span class="lead-tag">Lead coverage</span>' : ''}
        <h3><a ${linkAttrs(a.link)} data-open>${esc(a.title)}</a></h3>
        ${a.snippet ? `<p>${esc(a.snippet)}</p>` : ''}
        <span class="read-at">Read at ${esc(a.source)} ${icons.external}</span>
      </article>`)
    .join('');

  el.innerHTML = `
    <div data-cat="${esc(found.category)}" data-story="${esc(found.id)}">
      <button class="back-link" type="button" data-action="back">${icons.back}Back</button>
      <header class="story-view-head story" data-id="${esc(found.id)}" data-cat="${esc(found.category)}">
        ${kicker(found)}
        <h1 class="story-title"><a ${linkAttrs(found.link)} data-open>${esc(found.title)}</a></h1>
        ${found.snippet ? `<p class="snippet">${esc(found.snippet)}</p>` : ''}
        <p class="meta"><span class="source">${esc(found.source)}</span>${leadArticle ? `<span class="country">${esc(leadArticle.country || '')}</span>` : ''}${timeTag(found.updated || found.first_seen)}</p>
        <div class="facts">
          ${multi ? `<span>${coverageBar(found, 40)} <strong>${esc(coverageLabel(found))}</strong></span>` : '<span><strong>Single source</strong> so far</span>'}
          <span>First seen <strong>${esc(timeAgo(found.first_seen))}</strong></span>
          <span>Updated <strong>${esc(timeAgo(found.updated))}</strong></span>
        </div>
        ${countries.length > 1 ? `<ul class="country-list" aria-label="Countries covering this story">${countries
          .map((c) => `<li><i class="${regionClass(regionOf[c])}" aria-hidden="true"></i>${esc(c)}</li>`).join('')}</ul>` : ''}
        <div class="story-actions">
          <a class="button button-primary" ${linkAttrs(found.link)} data-open>Read at ${esc(found.source)} ${icons.external}</a>
          <button class="button" type="button" data-save aria-pressed="${isBookmarked(found.id)}">${icons.bookmark}<span>${isBookmarked(found.id) ? 'Saved' : 'Save'}</span></button>
        </div>
        ${archived ? '<p class="page-sub">This is your saved copy; the story has left the live seven-day window.</p>' : ''}
        ${found.hiddenCount ? `<p class="page-sub">${plural(found.hiddenCount, 'article')} from hidden sources ${found.hiddenCount === 1 ? 'is' : 'are'} not shown.</p>` : ''}
      </header>
      ${sectionHead(multi ? `How ${plural(found.n_sources, 'outlet')} reported it` : 'Coverage', { cat: found.category })}
      <p class="page-sub">Oldest first. Compare the headlines to see how each outlet frames the same event.</p>
      <div class="coverage-grid">${outletCards}</div>
    </div>`;
  return `${found.title} · Broadsheet`;
}

/* --- Today in 60 seconds --------------------------------------------------------- */

function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return 'Up late';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function shorten(text, words = 24) {
  const parts = String(text || '').split(/\s+/).filter(Boolean);
  return parts.length > words ? `${parts.slice(0, words).join(' ').replace(/[,;:.]$/, '')}…` : parts.join(' ');
}

export async function brief(el) {
  el.innerHTML = skeletonCards(3);
  let trending;
  let sections;
  try {
    [trending, sections] = await Promise.all([
      getTrending(),
      Promise.all(CATEGORIES.map((c) => getCategory(c.id).then((d) => ({ cat: c, data: d })).catch(() => ({ cat: c, data: null })))),
    ]);
  } catch (err) {
    el.innerHTML = loadError(err);
    return 'Today in 60 seconds';
  }
  if (sections.every((s) => !s.data)) {
    el.innerHTML = loadError(null);
    return 'Today in 60 seconds';
  }
  const used = new Set();
  const today = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  const blocks = sections
    .map(({ cat, data }) => {
      if (!data) return '';
      const picks = visibleList(data.stories || []).filter((s) => !used.has(s.id)).slice(0, 2);
      picks.forEach((s) => used.add(s.id));
      if (!picks.length) return '';
      return `<section class="brief-section" data-cat="${cat.id}">
          <h2>${esc(cat.name)}</h2>
          ${picks.map((s) => `
            <article class="brief-item story" data-id="${esc(s.id)}" data-cat="${esc(s.category)}" tabindex="-1">
              <h3><a ${linkAttrs(s.link)} data-open>${esc(s.title)}</a></h3>
              ${s.snippet ? `<p>${esc(shorten(s.snippet))}</p>` : ''}
              <p class="meta"><span class="source">${esc(s.source)}</span>${timeTag(s.updated)}${s.n_sources > 1 ? coverage(s) : ''}</p>
            </article>`).join('')}
        </section>`;
    })
    .join('');
  const topics = (trending.topics || []).slice(0, 6);
  el.innerHTML = `
    <div class="brief">
      <p class="brief-greeting">${esc(greeting())}. It's ${esc(today)}.</p>
      <h1 class="brief-title">Today in 60 seconds</h1>
      <div class="brief-timer" aria-hidden="true"><span>One minute</span><span class="track"><span></span></span></div>
      ${topics.length ? `<section class="brief-section" data-cat="top"><h2>Rising now</h2><div class="chips" style="flex-wrap:wrap;mask-image:none;-webkit-mask-image:none">${topics
        .map((t) => `<a class="chip" href="#/topic/${encodeURIComponent(t.key)}">${esc(t.label)}</a>`).join('')}</div></section>` : ''}
      ${blocks}
    </div>`;
  return 'Today in 60 seconds · Broadsheet';
}

/* --- Topic ----------------------------------------------------------------------- */

export async function topic(el, { key }) {
  el.innerHTML = skeletonCards(3);
  let trending;
  try {
    [trending] = await Promise.all([getTrending(), loadAll()]);
  } catch (err) {
    el.innerHTML = loadError(err);
    return 'Topic · Broadsheet';
  }
  const info = (trending.topics || []).find((t) => t.key === key);
  const label = info ? info.label : key;
  let list;
  if (info && info.stories && info.stories.length) {
    list = (await Promise.all(info.stories.map((id) => findStory(id)))).filter(Boolean);
  } else {
    const pattern = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    list = allStories()
      .filter((s) => s.articles.some((a) => pattern.test(`${a.title} ${a.snippet}`)))
      .sort((a, b) => b.score - a.score);
  }
  list = visibleList(list);

  let chart = '';
  if (info && info.hourly) {
    const max = Math.max(1, ...info.hourly);
    chart = `<div class="spark" role="img" aria-label="Mentions per hour over the last ${info.hourly.length} hours">${info.hourly
      .map((n) => `<i style="height:${Math.max(4, Math.round((n / max) * 100))}%" title="${n}"></i>`).join('')}</div>
      <p class="spark-caption">Mentions per hour, last ${info.hourly.length} hours</p>`;
  }
  const sub = info
    ? `Mentioned ${plural(info.recent, 'time')} by ${plural(info.sources, 'outlet')} in the last ${trending.window_hours || 6} hours, compared with ${plural(info.baseline, 'mention')} in the ${trending.baseline_hours || 48} hours before.`
    : 'Stories that mention this topic.';
  el.innerHTML = `
    <button class="back-link" type="button" data-action="back">${icons.back}Back</button>
    <header class="page-head" data-cat="top">
      <h1 class="page-title">${esc(label)}</h1>
      <p class="page-sub">${esc(sub)}</p>
      ${chart}
    </header>
    ${list.length ? storyList(list, { terms: [label] }) : emptyState('No stories found', 'This topic is no longer in the news window.')}`;
  return `${label} · Broadsheet`;
}

/* --- Search ----------------------------------------------------------------------- */

function searchStories(query) {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1 || /\d/.test(t));
  if (!terms.length) return { terms, results: [] };
  const results = [];
  for (const s of visibleList(allStories())) {
    const title = s.title.toLowerCase();
    const others = s.articles.map((a) => `${a.title} ${a.snippet} ${a.source}`).join(' ').toLowerCase();
    const text = `${title} ${(s.snippet || '').toLowerCase()} ${others}`;
    if (!terms.every((t) => text.includes(t))) continue;
    const titleHits = terms.filter((t) => title.includes(t)).length;
    results.push({ s, rank: titleHits * 2 + Math.log1p(s.score || 0) + (s.n_sources || 1) * 0.05 });
  }
  results.sort((a, b) => b.rank - a.rank);
  return { terms, results: results.slice(0, 80).map((r) => r.s) };
}

export async function search(el, { q = '' }) {
  el.innerHTML = `
    <header class="page-head" data-cat="top"><h1 class="page-title">Search</h1>
      <p class="page-sub">Search every headline and snippet from the past seven days.</p></header>
    <form class="search-box" role="search" data-search-form>
      ${icons.search}
      <label class="visually-hidden" for="search-input">Search stories</label>
      <input id="search-input" type="search" name="q" autocomplete="off" spellcheck="false" placeholder="Try a name, place or topic" value="${esc(q)}" enterkeyhint="search">
    </form>
    <p class="search-status" role="status" aria-live="polite"></p>
    <div data-results></div>`;
  const input = el.querySelector('#search-input');
  const status = el.querySelector('.search-status');
  const results = el.querySelector('[data-results]');
  let ready = false;

  const run = () => {
    const query = input.value.trim();
    const url = query ? `#/search?q=${encodeURIComponent(query)}` : '#/search';
    if (location.hash !== url) history.replaceState(history.state, '', url);
    if (!query) {
      status.textContent = ready ? `${plural(allStories().length, 'story', 'stories')} ready to search.` : 'Loading stories…';
      results.innerHTML = '';
      return;
    }
    if (!ready) {
      status.textContent = 'Loading stories…';
      return;
    }
    const found = searchStories(query);
    status.textContent = found.results.length
      ? `${plural(found.results.length, 'result')}${found.results.length === 80 ? ' (showing the best 80)' : ''}`
      : `No stories match “${query}”.`;
    results.innerHTML = found.results.length ? storyList(found.results, { terms: found.terms }) : '';
  };

  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 120);
  });
  el.querySelector('[data-search-form]').addEventListener('submit', (event) => {
    event.preventDefault();
    input.blur();
    run();
  });
  input.focus({ preventScroll: true });
  run();
  try {
    await loadAll();
  } catch (err) {
    status.textContent = 'Stories could not be loaded. Check your connection.';
    return 'Search · Broadsheet';
  }
  ready = true;
  if (input.isConnected) run();
  return 'Search · Broadsheet';
}

/* --- Saved ------------------------------------------------------------------------- */

export async function saved(el) {
  await loadAll().catch(() => {});
  const marks = Object.values(getBookmarks()).sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  const list = marks.map((m) => {
    const live = allStories().find((s) => s.id === m.id);
    return live || { ...m, articles: m.articles || [] };
  });
  el.innerHTML = `
    <header class="page-head" data-cat="top">
      <h1 class="page-title">Saved</h1>
      <p class="page-sub">${list.length ? `${plural(list.length, 'story', 'stories')} saved on this device.` : 'Stories you save are kept on this device, even after they leave the seven-day window.'}</p>
    </header>
    ${list.length
      ? storyList(list) + '<p style="margin-top:28px"><button class="button" type="button" data-action="clear-saved">Remove all saved stories</button></p>'
      : emptyState('Nothing saved yet', 'Tap the bookmark on any story to keep it here. On a keyboard, press B on a selected story.', '<a class="button" href="#/">Browse top stories</a>')}`;
  return 'Saved · Broadsheet';
}

/* --- Settings: theme, sources, history ------------------------------------------------ */

export async function settings(el) {
  const theme = getTheme();
  el.innerHTML = `
    <header class="page-head" data-cat="top"><h1 class="page-title">Settings</h1>
      <p class="page-sub">Settings are saved in this browser only.</p></header>
    <div class="settings">
      <section aria-labelledby="set-theme">
        <h2 id="set-theme">Appearance</h2>
        <p class="help">“System” follows your phone or computer's light and dark mode.</p>
        <div class="segmented" role="group" aria-label="Theme">
          ${['system', 'light', 'dark'].map((t) => `<button type="button" data-theme-choice="${t}" aria-pressed="${theme === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
        </div>
      </section>
      <section aria-labelledby="set-sources" data-sources>
        <h2 id="set-sources">Sources</h2>
        <p class="help">Turn off any outlet you don't want to see. Its articles disappear from every page, and stories are re-counted without it.</p>
        <p class="help">Loading sources…</p>
      </section>
      <section aria-labelledby="set-history">
        <h2 id="set-history">Reading history</h2>
        <p class="help">Stories you have opened appear slightly faded so you can spot what's new.</p>
        <div class="inline-actions">
          <button class="button" type="button" data-action="clear-read">Clear reading history</button>
          <button class="button" type="button" data-action="clear-saved">Remove all saved stories</button>
        </div>
      </section>
      <section aria-labelledby="set-keys">
        <h2 id="set-keys">Keyboard shortcuts</h2>
        <div class="shortcut-list">
          <div><kbd>/</kbd> Search</div>
          <div><kbd>j</kbd> Next story</div>
          <div><kbd>k</kbd> Previous story</div>
          <div><kbd>o</kbd> Open the selected story</div>
          <div><kbd>c</kbd> Compare coverage of the selected story</div>
          <div><kbd>b</kbd> Save or unsave the selected story</div>
          <div><kbd>?</kbd> Show shortcuts</div>
        </div>
      </section>
    </div>`;

  el.querySelectorAll('[data-theme-choice]').forEach((button) => {
    button.addEventListener('click', () => {
      setTheme(button.dataset.themeChoice);
      el.querySelectorAll('[data-theme-choice]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
    });
  });

  const box = el.querySelector('[data-sources]');
  let data;
  try {
    data = await getSources();
  } catch (err) {
    box.querySelector('.help:last-child').textContent = 'Sources could not be loaded. Check your connection.';
    return 'Settings · Broadsheet';
  }
  const hidden = getHiddenSources();
  const groups = CATEGORIES.map((cat) => {
    const members = (data.sources || []).filter((s) => (s.categories || [])[0] === cat.id);
    if (!members.length) return '';
    return `<div class="source-group" data-cat="${cat.id}"><h3>${esc(cat.name)}</h3>${members.map((s) => {
      const off = hidden.has(s.name);
      const id = `src-${s.name.replace(/[^a-z0-9]+/gi, '-')}`;
      const also = (s.categories || []).slice(1).map((c) => CATEGORY_BY_ID[c]?.short).filter(Boolean);
      return `<label class="source-row${off ? ' is-hidden' : ''}" for="${esc(id)}" data-name="${esc(s.name.toLowerCase())}">
          <span class="who"><span class="name">${esc(s.name)}</span><span class="where">${esc(s.country)}${also.length ? `, also in ${esc(also.join(', '))}` : ''}</span></span>
          <span class="switch"><input type="checkbox" id="${esc(id)}" data-source="${esc(s.name)}" ${off ? '' : 'checked'}><span></span></span>
        </label>`;
    }).join('')}</div>`;
  }).join('');
  box.innerHTML = `
    <h2 id="set-sources">Sources</h2>
    <p class="help">Turn off any outlet you don't want to see. Its articles disappear from every page, and stories are re-counted without it.</p>
    <label class="visually-hidden" for="source-filter">Filter sources</label>
    <input class="filter-input" id="source-filter" type="search" placeholder="Filter ${plural((data.sources || []).length, 'source')}">
    ${groups}
    <div class="inline-actions"><button class="button" type="button" data-action="show-all-sources">Show all sources</button></div>`;

  box.addEventListener('change', (event) => {
    const input = event.target.closest('input[data-source]');
    if (!input) return;
    setSourceHidden(input.dataset.source, !input.checked);
    input.closest('.source-row').classList.toggle('is-hidden', !input.checked);
    toast(input.checked ? `Showing ${input.dataset.source}` : `Hiding ${input.dataset.source}`);
  });
  box.querySelector('#source-filter').addEventListener('input', (event) => {
    const value = event.target.value.trim().toLowerCase();
    box.querySelectorAll('.source-row').forEach((row) => {
      row.hidden = Boolean(value) && !row.dataset.name.includes(value);
    });
  });
  return 'Settings · Broadsheet';
}

export function settingsActions(action, el) {
  if (action === 'clear-read') {
    clearRead();
    document.querySelectorAll('.story.is-read').forEach((s) => s.classList.remove('is-read'));
    toast('Reading history cleared');
  } else if (action === 'clear-saved') {
    if (window.confirm('Remove all saved stories from this device?')) {
      clearBookmarks();
      toast('Saved stories removed');
      return true;
    }
  } else if (action === 'show-all-sources') {
    showAllSources();
    el.querySelectorAll('input[data-source]').forEach((input) => {
      input.checked = true;
      input.closest('.source-row').classList.remove('is-hidden');
    });
    toast('Showing all sources');
  }
  return false;
}

/* --- Status ------------------------------------------------------------------------- */

const STATUS_LABEL = { ok: 'OK', empty: 'Empty', failed: 'Failed' };

export async function status(el) {
  el.innerHTML = skeletonCards(2);
  let data;
  try {
    data = await getStatus();
  } catch (err) {
    el.innerHTML = loadError(err);
    return 'Status · Broadsheet';
  }
  const order = { failed: 0, empty: 1, ok: 2 };
  const feeds = [...(data.feeds || [])].sort((a, b) => (order[a.status] - order[b.status]) || a.name.localeCompare(b.name));
  const rows = feeds.map((f) => {
    const cat = CATEGORY_BY_ID[f.category];
    return `<tr data-status="${esc(f.status)}">
        <td><strong>${esc(f.name)}</strong> <span class="url">${esc(f.url)}</span></td>
        <td data-label="Section">${esc(cat ? cat.short : f.category)}</td>
        <td><span class="pill pill-${esc(f.status)}">${esc(STATUS_LABEL[f.status] || f.status)}</span></td>
        <td class="num" data-label="Articles">${esc(f.items)}</td>
        <td class="num" data-label="Response">${f.duration_ms ? `${(f.duration_ms / 1000).toFixed(1)} s` : '–'}</td>
        <td data-label="Last OK">${f.last_ok ? timeTag(f.last_ok) : 'Never'}</td>
        <td class="err">${esc(f.error || '')}${f.fail_streak > 1 && f.status !== 'ok' ? ` <br><small>Not OK for ${f.fail_streak} runs in a row.</small>` : ''}</td>
      </tr>`;
  }).join('');
  el.innerHTML = `
    <header class="page-head" data-cat="top">
      <h1 class="page-title">Status</h1>
      <p class="page-sub">Last updated ${timeTag(data.generated)} (${esc(absoluteTime(data.generated))}). The collector runs about every 30 minutes; GitHub sometimes delays runs when it is busy.</p>
    </header>
    <dl class="stats">
      <div><dt>Feeds working</dt><dd>${esc(data.feeds_ok)} / ${esc(data.feeds_total)}</dd></div>
      <div><dt>Feeds failing</dt><dd>${esc(data.feeds_failed + data.feeds_empty)}</dd></div>
      <div><dt>Articles (7 days)</dt><dd>${esc(Number(data.articles).toLocaleString())}</dd></div>
      <div><dt>Stories</dt><dd>${esc(Number(data.stories).toLocaleString())}</dd></div>
    </dl>
    <div class="segmented status-filter" role="group" aria-label="Show feeds">
      <button type="button" data-filter="all" aria-pressed="true">All</button>
      <button type="button" data-filter="problems" aria-pressed="false">Problems only</button>
    </div>
    <table class="feed-table">
      <caption class="visually-hidden">Health of every news feed</caption>
      <thead><tr><th scope="col">Feed</th><th scope="col">Section</th><th scope="col">Status</th><th scope="col" class="num">Articles</th><th scope="col" class="num">Response</th><th scope="col">Last OK</th><th scope="col">Details</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  el.querySelectorAll('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      const problems = button.dataset.filter === 'problems';
      el.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
      el.querySelectorAll('tbody tr').forEach((tr) => {
        tr.hidden = problems && tr.dataset.status === 'ok';
      });
    });
  });
  return 'Status · Broadsheet';
}

/* --- Not found ------------------------------------------------------------------------ */

export function notFound(el) {
  el.innerHTML = emptyState('Page not found', 'That address does not match any page on Broadsheet.', '<a class="button" href="#/">Go to top stories</a>');
  return 'Not found · Broadsheet';
}
