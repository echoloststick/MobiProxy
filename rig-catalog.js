const CATALOG = 'https://catalog.roblox.com';
const CATEGORY_ACCESSORIES = 11;
const PAGE_LIMIT = 30;
const CACHE_TTL = 60000;
const SUBCATEGORY_TTL = 3600000;

const FALLBACK_IDS = {
  Head: 54,
  Hair: 20,
  Face: 21,
  Neck: 22,
  Shoulder: 23,
  Front: 24,
  Back: 25,
  Waist: 26,
};

const SUBCATEGORY_NAMES = {
  Head: ['HeadAccessories', 'HatAccessories'],
  Hair: ['HairAccessories'],
  Face: ['FaceAccessories'],
  Neck: ['NeckAccessories'],
  Shoulder: ['ShoulderAccessories'],
  Front: ['FrontAccessories'],
  Back: ['BackAccessories'],
  Waist: ['WaistAccessories'],
};

const HEADERS = { 'User-Agent': 'StudioMobi/1.0', Accept: 'application/json' };

const cache = new Map();
let subcategories = null;
let subcategoriesAt = 0;

function normalizeSubcategories(raw) {
  const map = {};
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry.name !== 'string') continue;
      const id = entry.subcategoryId ?? entry.id ?? entry.subcategory;
      if (typeof id === 'number') map[entry.name] = id;
    }
  } else if (raw && typeof raw === 'object') {
    for (const [name, id] of Object.entries(raw)) {
      if (typeof id === 'number') map[name] = id;
    }
  }
  return map;
}

async function loadSubcategories() {
  if (subcategories && Date.now() - subcategoriesAt < SUBCATEGORY_TTL) return subcategories;
  try {
    const res = await fetch(`${CATALOG}/v1/subcategories`, { headers: HEADERS });
    if (res.ok) {
      subcategories = normalizeSubcategories(await res.json());
      subcategoriesAt = Date.now();
    }
  } catch (err) {
    console.warn('[rig-catalog] Failed to load catalog subcategories: ' + err.message);
  }
  return subcategories || {};
}

async function resolveSubcategory(category) {
  const map = await loadSubcategories();
  for (const name of SUBCATEGORY_NAMES[category]) {
    if (typeof map[name] === 'number') return map[name];
  }
  return FALLBACK_IDS[category];
}

function toItem(entry) {
  let price = null;
  if (typeof entry.price === 'number') price = entry.price;
  else if (typeof entry.lowestPrice === 'number') price = entry.lowestPrice;
  else if (entry.priceStatus === 'Free') price = 0;
  return { id: entry.id, name: String(entry.name || 'Unnamed'), price };
}

async function searchCatalog(category, keyword, cursor) {
  const key = `${category}|${keyword}|${cursor}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;

  const subcategory = await resolveSubcategory(category);
  const params = new URLSearchParams({
    Category: String(CATEGORY_ACCESSORIES),
    Subcategory: String(subcategory),
    Limit: String(PAGE_LIMIT),
    SortType: '0',
  });
  if (keyword) params.set('Keyword', keyword);
  if (cursor) params.set('Cursor', cursor);

  const res = await fetch(`${CATALOG}/v1/search/items/details?${params.toString()}`, { headers: HEADERS });
  if (res.status === 429) {
    const err = new Error('Catalog rate limit reached. Try again shortly.');
    err.status = 429;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Catalog request failed with status ${res.status}.`);
    err.status = 502;
    throw err;
  }
  const body = await res.json();
  const items = (body.data || [])
    .filter((entry) => entry && entry.itemType === 'Asset' && typeof entry.id === 'number')
    .map(toItem);
  const value = { items, next: body.nextPageCursor || null };

  cache.set(key, { at: Date.now(), value });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return value;
}

async function handler(req, res) {
  const category = String(req.query.category || '');
  if (!FALLBACK_IDS[category]) {
    return res.status(400).json({ ok: false, error: 'Unknown category.' });
  }
  const keyword = String(req.query.keyword || '').slice(0, 60);
  const cursor = String(req.query.cursor || '').slice(0, 300);
  try {
    const result = await searchCatalog(category, keyword, cursor);
    res.json({ ok: true, items: result.items, next: result.next });
  } catch (err) {
    console.warn('[rig-catalog] Search failed: ' + err.message);
    res.status(err.status || 502).json({ ok: false, error: err.message });
  }
}

function register(app) {
  app.get('/rig/catalog', handler);
}

module.exports = { register };
