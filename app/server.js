const http = require('http');
const { Client } = require('pg');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const SITE_TITLE = process.env.SITE_TITLE || 'Obedové menu';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const LOCATION_OPTIONS = ['Praca', 'Karlovka', 'Stupava'];
const CATEGORIES = ['soup', 'main', 'special', 'pizza', 'side', 'dessert', 'drink', 'unknown'];

const dbConfig = {
  host: process.env.DB_HOST || 'obedove-menu-db',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'obedove_menu',
  user: process.env.DB_USER || 'obedove_menu_user',
  password: process.env.DB_PASSWORD || '',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function clean(value, fallback = '') {
  return String(value ?? fallback).replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

function euro(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2).replace('.', ',')} €` : '';
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function allergenArray(value) {
  return clean(value).split(',').map((x) => x.trim()).filter(Boolean);
}

function categoryLabel(category) {
  return {
    soup: 'Polievka',
    main: 'Hlavné jedlo',
    special: 'Špeciál',
    pizza: 'Pizza',
    side: 'Príloha',
    dessert: 'Dezert',
    drink: 'Nápoj',
    unknown: 'Menu',
  }[category] || 'Menu';
}

function categoryIcon(category) {
  return {
    soup: '🥣',
    main: '🍽️',
    special: '⭐',
    pizza: '🍕',
    side: '🥔',
    dessert: '🍰',
    drink: '🥤',
    unknown: '🍴',
  }[category] || '🍴';
}

function todayIso() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bratislava',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  return `${p.find((x) => x.type === 'year').value}-${p.find((x) => x.type === 'month').value}-${p.find((x) => x.type === 'day').value}`;
}

function formatTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('sk-SK', {
    timeZone: 'Europe/Bratislava',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

function formatDateSk(value = new Date()) {
  return new Intl.DateTimeFormat('sk-SK', {
    timeZone: 'Europe/Bratislava',
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(value);
}

function newClient() {
  return new Client(dbConfig);
}

async function ensureSchema(client) {
  await client.query(`ALTER TABLE public.lunch_sources ADD COLUMN IF NOT EXISTS source_location TEXT NOT NULL DEFAULT 'Praca'`);
  await client.query(`UPDATE public.lunch_sources SET source_location = 'Stupava' WHERE source_id = 'belavery' AND (source_location IS NULL OR source_location = 'Praca')`);
  await client.query(`UPDATE public.lunch_sources SET source_location = 'Karlovka' WHERE source_id = 'amelia' AND (source_location IS NULL OR source_location = 'Praca')`);
  await client.query(`UPDATE public.lunch_sources SET source_location = 'Praca' WHERE source_id = 'zark' AND (source_location IS NULL OR source_location = '')`);
}

function parseCookies(req) {
  return String(req.headers.cookie || '').split(';').reduce((acc, part) => {
    const [k, ...r] = part.trim().split('=');
    if (k) acc[k] = decodeURIComponent(r.join('=') || '');
    return acc;
  }, {});
}

function getAdminToken(req, url) {
  return url.searchParams.get('token') || req.headers['x-admin-token'] || parseCookies(req).lunch_admin_token || '';
}

function isAdmin(req, url) {
  if (!ADMIN_TOKEN) return false;
  const provided = Buffer.from(String(getAdminToken(req, url)));
  const expected = Buffer.from(String(ADMIN_TOKEN));
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function adminCookie() {
  return `lunch_admin_token=${encodeURIComponent(ADMIN_TOKEN)}; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=86400`;
}

function sendHtml(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { location, 'cache-control': 'no-store', ...headers });
  res.end();
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > limit) {
        reject(new Error('Request body je príliš veľký'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readForm(req) {
  return Object.fromEntries(new URLSearchParams(await readBody(req)));
}

async function queryTodayMenu() {
  const client = newClient();
  await client.connect();
  try {
    await ensureSchema(client);
    const menu = await client.query(`
      SELECT
        m.source_id,
        m.source_name,
        m.source_url,
        COALESCE(s.source_location, 'Praca') AS source_location,
        m.menu_date,
        m.menu_code,
        m.category,
        m.title,
        m.description,
        m.price_eur,
        m.currency,
        m.allergens,
        m.parsed_at
      FROM public.v_lunch_menu_today m
      LEFT JOIN public.lunch_sources s ON s.source_id = m.source_id
      ORDER BY
        COALESCE(s.source_location, 'Praca'),
        m.source_name,
        CASE m.category
          WHEN 'soup' THEN 1
          WHEN 'main' THEN 2
          WHEN 'special' THEN 3
          WHEN 'pizza' THEN 4
          WHEN 'side' THEN 5
          WHEN 'dessert' THEN 6
          WHEN 'drink' THEN 7
          ELSE 99
        END,
        m.menu_code NULLS LAST,
        m.title
    `);

    const meta = await client.query(`
      SELECT MAX(created_at) AS last_updated_at
      FROM public.lunch_menu_items
      WHERE menu_date = CURRENT_DATE
        AND is_available = TRUE
    `);

    return { items: menu.rows, lastUpdatedAt: meta.rows[0]?.last_updated_at || null };
  } finally {
    await client.end();
  }
}

async function queryAdminData(menuDate) {
  const client = newClient();
  await client.connect();
  try {
    await ensureSchema(client);
    const items = await client.query(`
      SELECT
        id,
        item_uid,
        source_id,
        source_name,
        source_type,
        source_url,
        menu_date,
        menu_code,
        category,
        title,
        description,
        price_eur,
        currency,
        allergens,
        raw_text,
        is_available,
        created_at,
        updated_at
      FROM public.lunch_menu_items
      WHERE menu_date = $1::date
      ORDER BY
        source_name,
        CASE category
          WHEN 'soup' THEN 1
          WHEN 'main' THEN 2
          WHEN 'special' THEN 3
          WHEN 'pizza' THEN 4
          WHEN 'side' THEN 5
          WHEN 'dessert' THEN 6
          WHEN 'drink' THEN 7
          ELSE 99
        END,
        menu_code NULLS LAST,
        title
    `, [menuDate]);

    const sources = await client.query(`
      SELECT
        source_id,
        source_name,
        source_type,
        source_url,
        COALESCE(source_location, 'Praca') AS source_location
      FROM public.lunch_sources
      ORDER BY source_location, source_name
    `);

    return { items: items.rows, sources: sources.rows };
  } finally {
    await client.end();
  }
}

async function findSource(client, sourceId) {
  const result = await client.query(`
    SELECT source_id, source_name, source_type, source_url
    FROM public.lunch_sources
    WHERE source_id = $1
    LIMIT 1
  `, [sourceId]);

  return result.rows[0] || {
    source_id: sourceId || 'manual',
    source_name: sourceId || 'Manual',
    source_type: 'manual',
    source_url: '',
  };
}

function makeUid(sourceId, menuDate, menuCode, title) {
  return `${sourceId}-${menuDate}-${menuCode || 'manual'}-${crypto.createHash('sha1').update(`${sourceId}|${menuDate}|${menuCode}|${title}|${Date.now()}`).digest('hex').slice(0, 10)}`;
}

async function createItem(form) {
  const client = newClient();
  await client.connect();
  try {
    await ensureSchema(client);
    const menuDate = clean(form.menu_date, todayIso());
    const title = clean(form.title);
    if (!title) throw new Error('Názov položky je povinný.');

    const source = await findSource(client, clean(form.source_id, 'manual'));
    const runId = `admin-${menuDate}`;

    await client.query('BEGIN');
    await client.query(`
      INSERT INTO public.lunch_import_runs (run_id, started_at, status, source_count, item_count, error_count, meta)
      VALUES ($1, NOW(), 'success', 1, 0, 0, $2::jsonb)
      ON CONFLICT (run_id) DO NOTHING
    `, [runId, JSON.stringify({ source: 'admin' })]);

    await client.query(`
      INSERT INTO public.lunch_menu_items (
        item_uid, source_id, source_name, source_type, source_url, menu_date, menu_code, category, title,
        description, price_eur, currency, allergens, raw_text, parsed_at, run_id, is_available
      ) VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,NOW(),$15,$16)
    `, [
      makeUid(source.source_id, menuDate, clean(form.menu_code), title),
      source.source_id,
      source.source_name,
      source.source_type,
      source.source_url,
      menuDate,
      clean(form.menu_code),
      clean(form.category, 'main'),
      title,
      clean(form.description),
      toNumber(form.price_eur),
      clean(form.currency, 'EUR') || 'EUR',
      JSON.stringify(allergenArray(form.allergens)),
      clean(form.raw_text),
      runId,
      form.is_available === 'on',
    ]);

    await client.query(`
      UPDATE public.lunch_import_runs
      SET item_count = (SELECT COUNT(*) FROM public.lunch_menu_items WHERE run_id = $1), updated_at = NOW()
      WHERE run_id = $1
    `, [runId]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

async function updateItem(form) {
  const id = Number(form.id);
  if (!Number.isInteger(id)) throw new Error('Neplatné ID položky.');
  const title = clean(form.title);
  if (!title) throw new Error('Názov položky je povinný.');

  const client = newClient();
  await client.connect();
  try {
    await ensureSchema(client);
    const source = await findSource(client, clean(form.source_id, 'manual'));
    await client.query(`
      UPDATE public.lunch_menu_items
      SET
        source_id = $2,
        source_name = $3,
        source_type = $4,
        source_url = $5,
        menu_date = $6::date,
        menu_code = $7,
        category = $8,
        title = $9,
        description = $10,
        price_eur = $11,
        currency = $12,
        allergens = $13::jsonb,
        raw_text = $14,
        is_available = $15,
        parsed_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
    `, [
      id,
      source.source_id,
      source.source_name,
      source.source_type,
      source.source_url,
      clean(form.menu_date, todayIso()),
      clean(form.menu_code),
      clean(form.category, 'main'),
      title,
      clean(form.description),
      toNumber(form.price_eur),
      clean(form.currency, 'EUR') || 'EUR',
      JSON.stringify(allergenArray(form.allergens)),
      clean(form.raw_text),
      form.is_available === 'on',
    ]);
  } finally {
    await client.end();
  }
}

async function deleteItem(form) {
  const id = Number(form.id);
  if (!Number.isInteger(id)) throw new Error('Neplatné ID položky.');
  const client = newClient();
  await client.connect();
  try {
    await client.query('DELETE FROM public.lunch_menu_items WHERE id = $1', [id]);
  } finally {
    await client.end();
  }
}

async function updateRestaurant(form) {
  const client = newClient();
  await client.connect();
  try {
    await ensureSchema(client);
    await client.query(`
      UPDATE public.lunch_sources
      SET source_location = $2, updated_at = NOW()
      WHERE source_id = $1
    `, [clean(form.source_id), clean(form.source_location, 'Praca')]);
  } finally {
    await client.end();
  }
}

function groupByLocationAndSource(items) {
  return items.reduce((acc, item) => {
    const location = item.source_location || 'Praca';
    const source = item.source_name || 'Neznámy zdroj';
    acc[location] ||= {};
    acc[location][source] ||= [];
    acc[location][source].push(item);
    return acc;
  }, {});
}

function renderMenuItem(item, index = 0) {
  const code = clean(item.menu_code);
  const category = item.category || 'unknown';
  const extra = index >= 3 ? ' mobile-extra' : '';
  const itemAllergens = Array.isArray(item.allergens) ? item.allergens : [];
  const itemPrice = euro(item.price_eur);

  return `
    <article class="menu-item${extra}">
      <div>
        <div class="menu-item-topline">
          ${code ? `<span class="menu-code">${escapeHtml(code)}</span>` : ''}
          <span class="category-chip category-${escapeHtml(category)}">
            <span>${categoryIcon(category)}</span>${escapeHtml(categoryLabel(category))}
          </span>
        </div>
        <h3>${escapeHtml(item.title)}</h3>
        ${item.description ? `<p class="description">${escapeHtml(item.description)}</p>` : ''}
        ${itemAllergens.length ? `<p class="allergens"><span>Alergény:</span> ${escapeHtml(itemAllergens.join(', '))}</p>` : ''}
      </div>
      ${itemPrice ? `<div class="price-badge">${escapeHtml(itemPrice)}</div>` : ''}
    </article>
  `;
}

const publicCss = `
  :root{--bg:#f3f4f6;--soft:#f9fafb;--text:#111827;--muted:#6b7280;--border:#e5e7eb;--shadow:0 18px 45px rgba(15,23,42,.10);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--text)}
  *{box-sizing:border-box}
  body{margin:0;background:radial-gradient(circle at top left,rgba(34,197,94,.18),transparent 34rem),var(--bg)}
  a{color:inherit}
  .page{width:min(1040px,100%);margin:0 auto;padding:18px}
  .hero{border-radius:28px;padding:28px;color:#fff;background:linear-gradient(135deg,rgba(17,24,39,.98),rgba(22,101,52,.92)),#111827;box-shadow:var(--shadow)}
  .hero-top{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:30px}
  .app-pill{display:inline-flex;align-items:center;gap:8px;padding:9px 13px;border:1px solid rgba(255,255,255,.18);border-radius:999px;background:rgba(255,255,255,.10);font-size:13px;font-weight:700;line-height:1.2}
  .hero h1{margin:0;font-size:clamp(34px,8vw,64px);line-height:.95;letter-spacing:-.06em}
  .hero-subtitle{max-width:640px;margin:16px 0 0;color:rgba(255,255,255,.78);font-size:clamp(15px,3.8vw,19px);line-height:1.5}
  .date-card{flex:0 0 auto;min-width:164px;padding:14px 16px;border-radius:18px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.16);text-align:right;align-self:flex-start;line-height:1.2}
  .date-card strong{display:block;font-size:14px}
  .date-card span{display:block;margin-top:4px;color:rgba(255,255,255,.72);font-size:12px}
  .mobile-date-inline{display:none}
  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:26px}.stat{padding:14px;border-radius:18px;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.14)}.stat strong{display:block;font-size:24px;line-height:1}.stat span{display:block;margin-top:6px;color:rgba(255,255,255,.70);font-size:12px;font-weight:600}
  .content{margin-top:18px;display:grid;gap:18px}.location-title{margin:8px 4px -4px;font-size:28px;letter-spacing:-.04em}.restaurant-card,.empty-state,.error-state{border:1px solid rgba(229,231,235,.9);border-radius:28px;background:rgba(255,255,255,.92);box-shadow:var(--shadow)}.restaurant-card{padding:18px}.restaurant-header{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:4px 4px 16px;border-bottom:1px solid var(--border)}.eyebrow{margin:0 0 4px;color:#15803d;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.restaurant-header h2{margin:0;font-size:clamp(22px,5vw,32px);letter-spacing:-.04em}.restaurant-toggle{display:inline-flex;align-items:baseline;gap:8px;padding:0;border:0;background:transparent;color:inherit;font:inherit;letter-spacing:inherit;text-align:left}.restaurant-count{display:grid;place-items:center;min-width:46px;height:46px;border-radius:16px;background:#dcfce7;color:#166534;font-weight:900}.mobile-toggle-text{display:none}.menu-list{display:grid;gap:12px;padding-top:16px}.menu-item{display:grid;grid-template-columns:1fr auto;gap:14px;align-items:start;padding:15px;border:1px solid var(--border);border-radius:20px;background:var(--soft)}.menu-item-topline{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px}.menu-code{display:inline-flex;align-items:center;justify-content:center;min-width:34px;height:28px;padding:0 9px;border-radius:999px;background:#111827;color:#fff;font-size:12px;font-weight:900}.category-chip{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border-radius:999px;background:#eef2ff;color:#3730a3;font-size:12px;font-weight:800}.category-soup{background:#ffedd5;color:#9a3412}.category-main{background:#dcfce7;color:#166534}.category-special{background:#fef3c7;color:#92400e}.category-pizza{background:#fee2e2;color:#991b1b}.menu-item h3{margin:0;font-size:clamp(17px,4vw,21px);line-height:1.22;letter-spacing:-.02em}.description{margin:8px 0 0;color:var(--muted);line-height:1.5;font-size:15px}.allergens{margin:10px 0 0;color:#6b7280;font-size:13px}.allergens span{font-weight:800}.price-badge{position:sticky;top:12px;padding:10px 12px;border-radius:999px;background:#111827;color:#fff;font-weight:900;white-space:nowrap}.source-link{display:inline-flex;align-items:center;margin-top:14px;padding:11px 14px;border-radius:999px;background:#f3f4f6;color:#374151;font-size:14px;font-weight:800;text-decoration:none;line-height:1.2}.source-link::after{content:'↗';margin-left:7px}.empty-state,.error-state{padding:26px}.footer{padding:22px 4px 10px;color:var(--muted);font-size:13px;text-align:center}
  @media(max-width:720px){.page{padding:10px}.hero{padding:16px;border-radius:20px}.hero-top{display:block;margin-bottom:0}.app-pill,.date-card,.hero-subtitle,.stats,.stat{display:none}.hero h1{font-size:clamp(28px,9vw,40px)}.mobile-date-inline{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}.mobile-date-inline strong{font-size:14px}.mobile-date-inline span{color:rgba(255,255,255,.72);font-size:12px}.content{margin-top:12px;gap:12px}.location-title{font-size:22px;margin:8px 4px -2px}.restaurant-card{padding:12px;border-radius:20px}.restaurant-header{align-items:flex-start;padding-bottom:12px}.restaurant-toggle:not(:disabled){cursor:pointer}.restaurant-toggle:not(:disabled)::after{content:'⌄';display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:999px;background:#dcfce7;color:#166534;font-size:18px}.restaurant-card.expanded .restaurant-toggle::after{content:'⌃'}.mobile-toggle-text{display:inline;color:var(--muted);font-size:12px;font-weight:800;letter-spacing:0;white-space:nowrap}.restaurant-card.expanded .mobile-toggle-text{display:none}.restaurant-card.mobile-collapsible:not(.expanded) .mobile-extra{display:none}.menu-list{gap:10px;padding-top:12px}.menu-item{grid-template-columns:1fr;gap:10px;padding:12px;border-radius:16px}.price-badge{position:static;justify-self:start;padding:8px 10px}.footer{padding-top:14px}}
`;

function renderPublicPage(items, error = null, lastUpdatedAt = null) {
  const today = formatDateSk(new Date());
  const updatedAt = formatTime(lastUpdatedAt);
  const grouped = groupByLocationAndSource(items);

  const locations = LOCATION_OPTIONS
    .concat(Object.keys(grouped).filter((location) => !LOCATION_OPTIONS.includes(location)))
    .filter((value, index, array) => array.indexOf(value) === index && grouped[value]);

  const content = locations.map((location) => {
    const restaurants = Object.entries(grouped[location]).map(([sourceName, rows]) => {
      const sourceUrl = rows.find((row) => row.source_url)?.source_url;
      const collapsible = rows.length > 3;
      return `
        <section class="restaurant-card${collapsible ? ' mobile-collapsible' : ''}">
          <div class="restaurant-header">
            <div>
              <p class="eyebrow">Reštaurácia</p>
              <h2>
                <button class="restaurant-toggle" type="button" aria-expanded="false" ${collapsible ? '' : 'disabled'}>
                  <span>${escapeHtml(sourceName)}</span>${collapsible ? '<small class="mobile-toggle-text">Zobraziť všetko</small>' : ''}
                </button>
              </h2>
            </div>
            <div class="restaurant-count">${rows.length}</div>
          </div>
          <div class="menu-list">${rows.map((row, index) => renderMenuItem(row, index)).join('')}</div>
          ${sourceUrl ? `<a class="source-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">Otvoriť zdroj menu</a>` : ''}
        </section>
      `;
    }).join('');

    return `<h2 class="location-title">${escapeHtml(location)}</h2>${restaurants}`;
  }).join('');

  return `<!doctype html>
<html lang="sk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>${escapeHtml(SITE_TITLE)}</title>
  <style>${publicCss}</style>
</head>
<body>
  <main class="page">
    <section class="hero">
      <div class="hero-top">
        <div>
          <div class="app-pill">🍽️ ${escapeHtml(SITE_TITLE)}</div>
          <h1>Dnešné obedové menu</h1>
          <div class="mobile-date-inline"><strong>${escapeHtml(today)}</strong><span>Aktualizované ${escapeHtml(updatedAt)}</span></div>
          <p class="hero-subtitle">Prehľad obedov zo všetkých tvojich zdrojov na jednom mieste. Dáta importuje n8n a stránka číta priamo z PostgreSQL.</p>
        </div>
        <div class="date-card"><strong>${escapeHtml(today)}</strong><span>Aktualizované ${escapeHtml(updatedAt)}</span></div>
      </div>
      <div class="stats">
        <div class="stat"><strong>${items.length}</strong><span>položiek menu</span></div>
        <div class="stat"><strong>${new Set(items.map((item) => item.source_id)).size}</strong><span>zdrojov</span></div>
        <div class="stat"><strong>${Object.keys(grouped).length}</strong><span>lokalít</span></div>
      </div>
    </section>
    <section class="content">
      ${error ? `<div class="error-state"><h2>Menu sa nepodarilo načítať</h2><p>${escapeHtml(error)}</p></div>` : ''}
      ${!error && items.length === 0 ? '<div class="empty-state"><h2>Zatiaľ tu nie je menu</h2><p>V databáze nie sú položky pre dnešný deň.</p></div>' : ''}
      ${!error ? content : ''}
    </section>
    <footer class="footer">Powered by n8n · PostgreSQL · Docker · Raspberry Pi homelab</footer>
  </main>
  <script>
    document.querySelectorAll('.restaurant-card.mobile-collapsible .restaurant-toggle').forEach((button) => {
      button.addEventListener('click', () => {
        if (!window.matchMedia('(max-width: 720px)').matches) return;
        const card = button.closest('.restaurant-card');
        const expanded = card.classList.toggle('expanded');
        button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      });
    });
  </script>
</body>
</html>`;
}

function renderLogin(message = '') {
  return `<!doctype html>
<html lang="sk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Admin · ${escapeHtml(SITE_TITLE)}</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f3f4f6;color:#111827}
    .box{width:min(420px,calc(100% - 24px));padding:24px;border-radius:24px;background:#fff;box-shadow:0 18px 45px rgba(15,23,42,.10)}
    h1{margin:0 0 8px;letter-spacing:-.04em}p{margin:0 0 18px;color:#6b7280}.msg{margin-bottom:12px;color:#dc2626;font-weight:800}
    input{width:100%;padding:13px 14px;border:1px solid #e5e7eb;border-radius:14px;font-size:16px}
    button{width:100%;margin-top:12px;padding:13px 14px;border:0;border-radius:14px;background:#111827;color:#fff;font-weight:900;font-size:15px;line-height:1.2}
  </style>
</head>
<body>
  <form class="box" method="post" action="/admin/login">
    <h1>Admin menu</h1>
    <p>Zadaj ADMIN_TOKEN z .env.</p>
    ${message ? `<div class="msg">${escapeHtml(message)}</div>` : ''}
    <input type="password" name="token" placeholder="Admin token" autofocus>
    <button type="submit">Prihlásiť</button>
  </form>
</body>
</html>`;
}

function renderAdminPage({ items, sources, menuDate, notice = '', error = '' }) {
  const sourceOptions = (selected = '') => sources.map((source) => `
    <option value="${escapeHtml(source.source_id)}" ${source.source_id === selected ? 'selected' : ''}>${escapeHtml(source.source_name)} (${escapeHtml(source.source_id)})</option>
  `).join('');

  const categoryOptions = (selected = 'main') => CATEGORIES.map((category) => `
    <option value="${category}" ${category === selected ? 'selected' : ''}>${escapeHtml(categoryLabel(category))}</option>
  `).join('');

  const locationOptions = (selected = 'Praca') => {
    const options = LOCATION_OPTIONS.map((location) => `
      <option value="${escapeHtml(location)}" ${location === selected ? 'selected' : ''}>${escapeHtml(location)}</option>
    `).join('');
    return options + (!LOCATION_OPTIONS.includes(selected) ? `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}</option>` : '');
  };

  const restaurantRows = sources.map((source) => `
    <form class="restaurant-row" method="post" action="/admin/restaurants/update">
      <input type="hidden" name="source_id" value="${escapeHtml(source.source_id)}">
      <div><strong>${escapeHtml(source.source_name)}</strong><small>${escapeHtml(source.source_id)} · ${escapeHtml(source.source_type)}</small></div>
      <select name="source_location">${locationOptions(source.source_location || 'Praca')}</select>
      <button type="submit">Uložiť lokalitu</button>
    </form>
  `).join('');

  const itemRows = items.map((item) => {
    const dateValue = String(item.menu_date).slice(0, 10);
    const itemAllergens = Array.isArray(item.allergens) ? item.allergens.join(', ') : '';
    return `
      <details class="admin-item">
        <summary><span><strong>${escapeHtml(item.menu_code || '—')} · ${escapeHtml(item.title)}</strong><small>${escapeHtml(item.source_name || '')}</small></span><b>${escapeHtml(euro(item.price_eur))}</b></summary>
        <form class="grid" method="post" action="/admin/items/update">
          <input type="hidden" name="id" value="${escapeHtml(item.id)}">
          <label>Dátum<input type="date" name="menu_date" value="${escapeHtml(dateValue)}"></label>
          <label>Reštaurácia<select name="source_id">${sourceOptions(item.source_id)}</select></label>
          <label>Kód<input name="menu_code" value="${escapeHtml(item.menu_code || '')}"></label>
          <label>Kategória<select name="category">${categoryOptions(item.category || 'main')}</select></label>
          <label class="wide">Názov<input name="title" value="${escapeHtml(item.title || '')}" required></label>
          <label class="wide">Popis<textarea name="description" rows="2">${escapeHtml(item.description || '')}</textarea></label>
          <label>Cena EUR<input name="price_eur" inputmode="decimal" value="${escapeHtml(item.price_eur ?? '')}"></label>
          <label>Mena<input name="currency" value="${escapeHtml(item.currency || 'EUR')}"></label>
          <label class="wide">Alergény<input name="allergens" value="${escapeHtml(itemAllergens)}" placeholder="1, 3, 7"></label>
          <label class="wide">Raw text<textarea name="raw_text" rows="2">${escapeHtml(item.raw_text || '')}</textarea></label>
          <label class="checkbox"><input type="checkbox" name="is_available" ${item.is_available ? 'checked' : ''}> Zobrazovať</label>
          <div class="actions"><button type="submit">Uložiť</button></div>
        </form>
        <form method="post" action="/admin/items/delete" onsubmit="return confirm('Naozaj zmazať položku?')">
          <input type="hidden" name="id" value="${escapeHtml(item.id)}">
          <button class="danger" type="submit">Zmazať</button>
        </form>
      </details>
    `;
  }).join('');

  return `<!doctype html>
<html lang="sk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Admin · ${escapeHtml(SITE_TITLE)}</title>
  <style>
    :root{--bg:#f3f4f6;--card:#fff;--text:#111827;--muted:#6b7280;--border:#e5e7eb;--green:#16a34a;--danger:#dc2626;--shadow:0 14px 34px rgba(15,23,42,.08)}
    *{box-sizing:border-box}
    body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--text)}
    .admin-page{width:min(1180px,100%);margin:0 auto;padding:18px}
    .top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px}
    h1{margin:0;font-size:clamp(30px,7vw,54px);letter-spacing:-.06em;line-height:.95}
    .nav{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;justify-content:flex-end}
    .nav a{display:inline-flex;align-items:center;justify-content:center;width:auto;height:auto;min-width:0;min-height:0;padding:11px 14px;border-radius:999px;background:#111827;color:#fff;font-size:14px;font-weight:900;line-height:1.2;text-decoration:none;white-space:nowrap}
    .card,.admin-item{background:var(--card);border:1px solid var(--border);border-radius:22px;box-shadow:var(--shadow)}
    .card{padding:16px;margin-bottom:14px}
    .toolbar,.restaurant-row{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}
    .restaurant-row{align-items:center;justify-content:space-between;padding:12px;border:1px solid var(--border);border-radius:16px;margin-top:10px;background:#fff}
    .restaurant-row small{display:block;color:var(--muted);margin-top:3px}
    label{display:grid;gap:6px;font-size:12px;font-weight:900;color:#374151;text-transform:uppercase;letter-spacing:.06em}
    input,select,textarea{width:100%;border:1px solid var(--border);border-radius:12px;padding:11px 12px;font:inherit;background:#fff;color:var(--text)}
    textarea{resize:vertical}
    .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:12px}
    .wide{grid-column:span 2}
    .checkbox{display:flex;align-items:center;gap:8px;text-transform:none;letter-spacing:0;font-size:14px}.checkbox input{width:auto}
    .actions{display:flex;align-items:end}
    button{display:inline-flex;align-items:center;justify-content:center;width:auto;height:auto;min-width:0;min-height:0;border:0;border-radius:999px;padding:11px 14px;background:var(--green);color:#fff;font-weight:900;line-height:1.2;cursor:pointer;white-space:nowrap}
    .danger{background:var(--danger);margin:0 0 14px 14px}
    .notice{padding:12px 14px;border-radius:14px;background:#dcfce7;color:#166534;font-weight:800;margin-bottom:12px}
    .error{padding:12px 14px;border-radius:14px;background:#fee2e2;color:#991b1b;font-weight:800;margin-bottom:12px}
    .admin-item{margin-bottom:10px;overflow:hidden}
    summary{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:14px 16px;cursor:pointer}
    summary small{display:block;color:var(--muted);font-weight:700;margin-top:3px}.admin-item form{padding:0 14px 14px}.muted{color:var(--muted)}
    @media(max-width:720px){.admin-page{padding:10px}.top{display:block}.nav{justify-content:flex-start;margin-top:12px}.grid{grid-template-columns:1fr}.wide{grid-column:auto}.restaurant-row{display:grid;grid-template-columns:1fr}.toolbar{display:grid}.toolbar>*{width:100%}summary{align-items:flex-start}}
  </style>
</head>
<body>
  <main class="admin-page">
    <div class="top">
      <div><h1>Admin menu</h1><p class="muted">CRUD nad položkami a lokalitami reštaurácií.</p></div>
      <div class="nav"><a href="/">Web</a><a href="/admin/logout">Odhlásiť</a></div>
    </div>
    ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ''}
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <section class="card"><form class="toolbar" method="get" action="/admin"><label>Dátum<input type="date" name="date" value="${escapeHtml(menuDate)}"></label><button type="submit">Filtrovať</button></form></section>
    <section class="card"><h2>Reštaurácie a lokality</h2><p class="muted">Lokalita určuje skupinu, pod ktorou sa reštaurácia zobrazí na hlavnej stránke.</p>${restaurantRows}</section>
    <section class="card"><h2>Pridať položku</h2><form class="grid" method="post" action="/admin/items/create"><label>Dátum<input type="date" name="menu_date" value="${escapeHtml(menuDate)}"></label><label>Reštaurácia<select name="source_id">${sourceOptions()}</select></label><label>Kód<input name="menu_code" placeholder="01"></label><label>Kategória<select name="category">${categoryOptions('main')}</select></label><label class="wide">Názov<input name="title" required></label><label class="wide">Popis<textarea name="description" rows="2"></textarea></label><label>Cena EUR<input name="price_eur" inputmode="decimal" placeholder="8,90"></label><label>Mena<input name="currency" value="EUR"></label><label class="wide">Alergény<input name="allergens" placeholder="1, 3, 7"></label><label class="wide">Raw text<textarea name="raw_text" rows="2"></textarea></label><label class="checkbox"><input type="checkbox" name="is_available" checked> Zobrazovať</label><div class="actions"><button type="submit">Pridať</button></div></form></section>
    <section><h2>Položky pre ${escapeHtml(menuDate)} (${items.length})</h2>${items.length ? itemRows : '<div class="card muted">Pre tento dátum nie sú žiadne položky.</div>'}</section>
  </main>
</body>
</html>`;
}

async function adminGet(req, res, url) {
  if (!ADMIN_TOKEN) return sendHtml(res, 503, renderLogin('ADMIN_TOKEN nie je nastavený v .env. Admin je vypnutý.'));
  if (!isAdmin(req, url)) return sendHtml(res, 401, renderLogin(url.searchParams.get('error') ? 'Nesprávny admin token.' : ''));

  const menuDate = url.searchParams.get('date') || todayIso();
  const data = await queryAdminData(menuDate);
  sendHtml(res, 200, renderAdminPage({
    ...data,
    menuDate,
    notice: url.searchParams.get('notice') || '',
    error: url.searchParams.get('error') || '',
  }), { 'set-cookie': adminCookie() });
}

async function adminPost(req, res, url) {
  if (url.pathname === '/admin/login') {
    const form = await readForm(req);
    return ADMIN_TOKEN && form.token === ADMIN_TOKEN
      ? redirect(res, '/admin', { 'set-cookie': adminCookie() })
      : redirect(res, '/admin?error=1');
  }

  if (!isAdmin(req, url)) return redirect(res, '/admin?error=Neautorizovaný prístup');

  const form = await readForm(req);
  const menuDate = clean(form.menu_date, todayIso());
  try {
    if (url.pathname === '/admin/items/create') await createItem(form);
    else if (url.pathname === '/admin/items/update') await updateItem(form);
    else if (url.pathname === '/admin/items/delete') await deleteItem(form);
    else if (url.pathname === '/admin/restaurants/update') await updateRestaurant(form);
    else return sendHtml(res, 404, '<h1>404</h1>');

    redirect(res, `/admin?date=${encodeURIComponent(menuDate)}&notice=${encodeURIComponent('Zmena bola uložená.')}`);
  } catch (err) {
    redirect(res, `/admin?date=${encodeURIComponent(menuDate)}&error=${encodeURIComponent(err.message)}`);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, service: 'obedove-menu' }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/logout') {
      return redirect(res, '/admin', { 'set-cookie': 'lunch_admin_token=; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=0' });
    }

    if (req.method === 'GET' && url.pathname === '/admin') return await adminGet(req, res, url);
    if (req.method === 'POST' && url.pathname.startsWith('/admin/')) return await adminPost(req, res, url);

    if (req.method === 'GET' && url.pathname === '/') {
      const { items, lastUpdatedAt } = await queryTodayMenu();
      return sendHtml(res, 200, renderPublicPage(items, null, lastUpdatedAt));
    }

    sendHtml(res, 404, '<h1>404</h1>');
  } catch (err) {
    sendHtml(res, 500, `<h1>Chyba</h1><pre>${escapeHtml(err.message)}</pre>`);
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`obedove-menu listening on ${PORT}`));
