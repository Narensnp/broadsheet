// Shared settings for the website.

export const CATEGORIES = [
  { id: 'world', name: 'World & Politics', short: 'World' },
  { id: 'business', name: 'Business & Finance', short: 'Business' },
  { id: 'technology', name: 'Technology', short: 'Tech' },
  { id: 'science', name: 'Innovation & Science', short: 'Science' },
  { id: 'asia', name: 'Singapore & Asia', short: 'Asia' },
];

export const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

export const REGIONS = {
  Europe: 'r-europe',
  Americas: 'r-americas',
  Asia: 'r-asia',
  'Middle East': 'r-middle-east',
  Africa: 'r-africa',
  Oceania: 'r-oceania',
};

// How often to look for fresh data while the page is open.
export const UPDATE_CHECK_MS = 5 * 60 * 1000;

// Name of the browser cache the service worker stores data files in.
export const DATA_CACHE = 'broadsheet-data';
