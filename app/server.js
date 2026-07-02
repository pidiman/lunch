const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT || 3000);
const SITE_TITLE = process.env.SITE_TITLE || 'Obedové menu';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_TTL_DAYS = 30;
const LOCATION_OPTIONS = ['Praca', 'Karlovka', 'Stupava'];
const CATEGORIES = ['soup', 'main', 'special', 'pizza', 'side', 'dessert', 'drink', 'unknown'];

const pool = new Pool({
  host: process.env.DB_HOST || 'obedove-menu-db',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'obedove_menu',
  user: process.env.DB_USER || 'obedove_menu_user',
  password: process.env.DB_PASSWORD || '',
  max: 5,
});

pool.on('error', (err) => console.error('pg pool error:', err.message));

function readStaticAsset(fileName) {
  try {
    return fs.readFileSync(path.join(__dirname, fileName), 'utf8');
  } catch {
    console.warn(`Statický súbor ${fileName} sa nepodarilo načítať.`);
    return '';
  }
}

const faviconSvg = readStaticAsset('favicon.svg');
const tailwindCss = readStaticAsset('tailwind.css');

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

async function ensureSchema() {
  await pool.query(`ALTER TABLE public.lunch_sources ADD COLUMN IF NOT EXISTS source_location TEXT NOT NULL DEFAULT 'Praca'`);
  await pool.query(`UPDATE public.lunch_sources SET source_location = 'Stupava' WHERE source_id = 'belavery' AND (source_location IS NULL OR source_location = 'Praca')`);
  await pool.query(`UPDATE public.lunch_sources SET source_location = 'Karlovka' WHERE source_id = 'amelia' AND (source_location IS NULL OR source_location = 'Praca')`);
  await pool.query(`UPDATE public.lunch_sources SET source_location = 'Praca' WHERE source_id = 'zark' AND (source_location IS NULL OR source_location = '')`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.lunch_locations (
      name TEXT PRIMARY KEY,
      weight INTEGER NOT NULL DEFAULT 100,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    INSERT INTO public.lunch_locations (name, weight) VALUES
      ('Praca', 10), ('Karlovka', 20), ('Stupava', 30)
    ON CONFLICT (name) DO NOTHING
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.lunch_users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
      is_approved BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.lunch_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES public.lunch_users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function ensureSchemaWithRetry() {
  for (;;) {
    try {
      await ensureSchema();
      return;
    } catch (err) {
      console.error('Inicializácia schémy zlyhala, skúšam znova o 3 s:', err.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

function parseCookies(req) {
  return String(req.headers.cookie || '').split(';').reduce((acc, part) => {
    const [k, ...r] = part.trim().split('=');
    if (k) acc[k] = decodeURIComponent(r.join('=') || '');
    return acc;
  }, {});
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt:${salt}:${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, salt, hex] = String(stored || '').split(':');
  if (scheme !== 'scrypt' || !salt || !hex) return false;
  const candidate = await scryptAsync(password, salt, 64);
  const expected = Buffer.from(hex, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function sessionCookie(token, maxAgeSeconds = SESSION_TTL_DAYS * 86400) {
  return `lunch_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=${maxAgeSeconds}`;
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(`DELETE FROM public.lunch_sessions WHERE expires_at < NOW()`);
  await pool.query(`
    INSERT INTO public.lunch_sessions (token_hash, user_id, expires_at)
    VALUES ($1, $2, NOW() + make_interval(days => $3))
  `, [hashSessionToken(token), userId, SESSION_TTL_DAYS]);
  return token;
}

async function getSessionUser(req) {
  const token = parseCookies(req).lunch_session || '';
  if (!token) return null;
  const result = await pool.query(`
    SELECT u.id, u.email, u.role, u.is_approved
    FROM public.lunch_sessions s
    JOIN public.lunch_users u ON u.id = s.user_id
    WHERE s.token_hash = $1 AND s.expires_at > NOW()
  `, [hashSessionToken(token)]);
  const user = result.rows[0];
  return user && user.is_approved ? user : null;
}

async function destroySession(req) {
  const token = parseCookies(req).lunch_session || '';
  if (token) await pool.query(`DELETE FROM public.lunch_sessions WHERE token_hash = $1`, [hashSessionToken(token)]);
}

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

async function countUsers() {
  const result = await pool.query(`SELECT COUNT(*)::int AS n FROM public.lunch_users`);
  return result.rows[0].n;
}

async function registerUser(form) {
  const email = normalizeEmail(form.email);
  const password = String(form.password || '');
  if (!EMAIL_RE.test(email)) throw new Error('Zadaj platnú e-mailovú adresu.');
  if (password.length < 8) throw new Error('Heslo musí mať aspoň 8 znakov.');
  if (password !== String(form.password_confirm || '')) throw new Error('Heslá sa nezhodujú.');

  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock so two simultaneous first registrations can't both become admin
    await client.query('LOCK TABLE public.lunch_users IN SHARE ROW EXCLUSIVE MODE');
    const existing = await client.query(`SELECT COUNT(*)::int AS n FROM public.lunch_users`);
    const isFirst = existing.rows[0].n === 0;
    const inserted = await client.query(`
      INSERT INTO public.lunch_users (email, password_hash, role, is_approved)
      VALUES ($1, $2, $3, $4)
      RETURNING id, email, role, is_approved
    `, [email, passwordHash, isFirst ? 'admin' : 'user', isFirst]);
    await client.query('COMMIT');
    return inserted.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') throw new Error('Účet s týmto e-mailom už existuje.');
    throw err;
  } finally {
    client.release();
  }
}

async function authenticateUser(form) {
  const email = normalizeEmail(form.email);
  const password = String(form.password || '');
  const result = await pool.query(`
    SELECT id, email, password_hash, role, is_approved
    FROM public.lunch_users
    WHERE email = $1
  `, [email]);
  const user = result.rows[0];
  const ok = user && await verifyPassword(password, user.password_hash);
  if (!ok) throw new Error('Nesprávny e-mail alebo heslo.');
  if (!user.is_approved) throw new Error('Účet čaká na schválenie administrátorom.');
  return user;
}

async function listUsers() {
  const result = await pool.query(`
    SELECT id, email, role, is_approved, created_at
    FROM public.lunch_users
    ORDER BY is_approved, created_at
  `);
  return result.rows;
}

async function approveUser(form) {
  const id = Number(form.id);
  if (!Number.isInteger(id)) throw new Error('Neplatné ID používateľa.');
  await pool.query(`UPDATE public.lunch_users SET is_approved = TRUE, updated_at = NOW() WHERE id = $1`, [id]);
}

async function deleteUser(form, currentUser) {
  const id = Number(form.id);
  if (!Number.isInteger(id)) throw new Error('Neplatné ID používateľa.');
  if (id === Number(currentUser.id)) throw new Error('Nemôžeš zmazať vlastný účet.');
  await pool.query(`DELETE FROM public.lunch_users WHERE id = $1`, [id]);
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
  const menu = await pool.query(`
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
      LEFT JOIN public.lunch_locations loc ON loc.name = COALESCE(s.source_location, 'Praca')
      ORDER BY
        COALESCE(loc.weight, 999),
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

  const meta = await pool.query(`
    SELECT MAX(created_at) AS last_updated_at
    FROM public.lunch_menu_items
    WHERE menu_date = CURRENT_DATE
      AND is_available = TRUE
  `);

  return { items: menu.rows, lastUpdatedAt: meta.rows[0]?.last_updated_at || null };
}

async function queryAdminData(menuDate) {
  const items = await pool.query(`
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

  const sources = await pool.query(`
    SELECT
      source_id,
      source_name,
      source_type,
      source_url,
      COALESCE(source_location, 'Praca') AS source_location
    FROM public.lunch_sources
    ORDER BY source_location, source_name
  `);

  const locations = await pool.query(`
    SELECT name, weight FROM public.lunch_locations ORDER BY weight, name
  `);

  return { items: items.rows, sources: sources.rows, locations: locations.rows };
}

async function findSource(db, sourceId) {
  const result = await db.query(`
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
  const menuDate = clean(form.menu_date, todayIso());
  const title = clean(form.title);
  if (!title) throw new Error('Názov položky je povinný.');

  const client = await pool.connect();
  try {
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
    client.release();
  }
}

async function updateItem(form) {
  const id = Number(form.id);
  if (!Number.isInteger(id)) throw new Error('Neplatné ID položky.');
  const title = clean(form.title);
  if (!title) throw new Error('Názov položky je povinný.');

  const source = await findSource(pool, clean(form.source_id, 'manual'));
  await pool.query(`
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
}

async function deleteItem(form) {
  const id = Number(form.id);
  if (!Number.isInteger(id)) throw new Error('Neplatné ID položky.');
  await pool.query('DELETE FROM public.lunch_menu_items WHERE id = $1', [id]);
}

async function updateRestaurant(form) {
  await pool.query(`
    UPDATE public.lunch_sources
    SET source_location = $2, updated_at = NOW()
    WHERE source_id = $1
  `, [clean(form.source_id), clean(form.source_location, 'Praca')]);
}

async function createLocation(form) {
  const name = clean(form.name);
  if (!name) throw new Error('Názov lokality je povinný.');
  const weight = toNumber(form.weight) ?? 100;
  await pool.query(`
    INSERT INTO public.lunch_locations (name, weight) VALUES ($1, $2)
  `, [name, weight]);
}

async function updateLocation(form) {
  const name = clean(form.name);
  if (!name) throw new Error('Názov lokality je povinný.');
  const weight = toNumber(form.weight) ?? 100;
  await pool.query(`
    UPDATE public.lunch_locations SET weight = $2, updated_at = NOW() WHERE name = $1
  `, [name, weight]);
}

async function deleteLocation(form) {
  const name = clean(form.name);
  if (!name) throw new Error('Názov lokality je povinný.');
  await pool.query(`DELETE FROM public.lunch_locations WHERE name = $1`, [name]);
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
  const mobileExtra = index >= 3 ? 'mobile-extra' : '';
  const itemAllergens = Array.isArray(item.allergens) ? item.allergens : [];
  const itemPrice = euro(item.price_eur);
  const chipClasses = categoryChipClasses(category);

  return `
    <article class="grid grid-cols-[1fr_auto] gap-3 items-start p-4 border border-gray-200 dark:border-gray-700 rounded-2xl bg-gray-50 dark:bg-gray-900/60 ${mobileExtra}">
      <div>
        <div class="flex items-center flex-wrap gap-2 mb-2">
          ${code ? `<span class="inline-flex items-center justify-center min-w-[34px] h-7 px-2 rounded-full bg-gray-900 dark:bg-gray-700 text-white text-xs font-black">${escapeHtml(code)}</span>` : ''}
          <span class="inline-flex items-center gap-1 h-7 px-3 rounded-full text-xs font-bold ${chipClasses}">
            <span>${categoryIcon(category)}</span>${escapeHtml(categoryLabel(category))}
          </span>
        </div>
        <h3 class="m-0 text-lg font-bold leading-snug tracking-tight">${escapeHtml(item.title)}</h3>
        ${item.description ? `<p class="mt-2 text-sm text-gray-500 dark:text-gray-400 leading-relaxed">${escapeHtml(item.description)}</p>` : ''}
        ${itemAllergens.length ? `<p class="mt-2 text-xs text-gray-400 dark:text-gray-500"><span class="font-bold">Alergény:</span> ${escapeHtml(itemAllergens.join(', '))}</p>` : ''}
      </div>
      ${itemPrice ? `<div class="sticky top-3 px-3 py-2 rounded-full bg-gray-900 dark:bg-gray-700 text-white font-black text-sm whitespace-nowrap">${escapeHtml(itemPrice)}</div>` : ''}
    </article>
  `;
}

function categoryChipClasses(category) {
  return {
    soup: 'bg-orange-50 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200',
    main: 'bg-green-50 text-green-800 dark:bg-green-900/40 dark:text-green-200',
    special: 'bg-amber-50 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
    pizza: 'bg-red-50 text-red-800 dark:bg-red-900/40 dark:text-red-200',
    side: 'bg-yellow-50 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200',
    dessert: 'bg-pink-50 text-pink-800 dark:bg-pink-900/40 dark:text-pink-200',
    drink: 'bg-blue-50 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  }[category] || 'bg-indigo-50 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200';
}

function renderPublicPage(items, error = null, lastUpdatedAt = null) {
  const today = formatDateSk(new Date());
  const updatedAt = formatTime(lastUpdatedAt);
  const grouped = groupByLocationAndSource(items);

  // Order comes from the DB query (already sorted by location weight), preserve insertion order
  const locations = Object.keys(grouped);

  const content = locations.map((location) => {
    const restaurants = Object.entries(grouped[location]).map(([sourceName, rows]) => {
      const sourceUrl = rows.find((row) => row.source_url)?.source_url;
      const collapsible = rows.length > 3;
      return `
        <section class="restaurant-card border border-gray-200 dark:border-gray-700 rounded-3xl bg-white/95 dark:bg-gray-800/95 shadow-lg p-5 ${collapsible ? 'mobile-collapsible' : ''}">
          <div class="flex items-center justify-between gap-4 pb-4 border-b border-gray-200 dark:border-gray-700">
            <div>
              <p class="m-0 mb-1 text-xs font-black text-green-700 dark:text-green-400 uppercase tracking-widest">Reštaurácia</p>
              <h2 class="m-0 text-2xl sm:text-3xl font-black tracking-tight">
                <button class="restaurant-toggle inline-flex items-baseline gap-2 p-0 border-0 bg-transparent text-inherit font-[inherit] tracking-[inherit] text-left" type="button" aria-expanded="false" ${collapsible ? '' : 'disabled'}>
                  <span>${escapeHtml(sourceName)}</span>${collapsible ? '<small class="mobile-toggle-text text-xs font-bold text-gray-400 dark:text-gray-500 tracking-normal whitespace-nowrap" style="display:none">Zobraziť všetko</small>' : ''}
                </button>
              </h2>
            </div>
            <div class="grid place-items-center min-w-[46px] h-11 rounded-2xl bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300 font-black text-lg flex-none">${rows.length}</div>
          </div>
          <div class="menu-list grid gap-3 pt-4">${rows.map((row, index) => renderMenuItem(row, index)).join('')}</div>
          ${sourceUrl ? `<a class="inline-flex items-center mt-4 px-4 py-2.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-sm font-bold no-underline hover:bg-gray-200 dark:hover:bg-gray-600" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">Otvoriť zdroj menu <span class="ml-1.5">↗</span></a>` : ''}
        </section>
      `;
    }).join('');

    return `<h2 class="mt-2 mb-0 text-2xl font-black tracking-tight text-gray-900 dark:text-gray-100">${escapeHtml(location)}</h2>${restaurants}`;
  }).join('');

  return `<!doctype html>
<html lang="sk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>${escapeHtml(SITE_TITLE)}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/tailwind.css">
  <script>
    (function () {
      const saved = localStorage.getItem('lunch_theme');
      if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
      }
    })();
  </script>
  <style>
    body { background: radial-gradient(circle at top left, rgba(34,197,94,.15), transparent 32rem), #f3f4f6; }
    html.dark body { background: radial-gradient(circle at top left, rgba(34,197,94,.08), transparent 32rem), #111827; }
    .hero { background: linear-gradient(135deg, rgba(17,24,39,.98), rgba(22,101,52,.92)), #111827; }
    h1 { font-size: clamp(34px, 8vw, 64px); }
    .mobile-collapsible:not(.expanded) .mobile-extra { display: none; }
    .mobile-collapsible .restaurant-toggle:not(:disabled) { cursor: pointer; }
    .mobile-collapsible .restaurant-toggle:not(:disabled)::after { content: '⌄'; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 999px; background: #dcfce7; color: #166534; font-size: 18px; }
    html.dark .mobile-collapsible .restaurant-toggle:not(:disabled)::after { background: #14532d; color: #bbf7d0; }
    .mobile-collapsible.expanded .restaurant-toggle::after { content: '⌃'; }
    .mobile-collapsible .mobile-toggle-text { display: inline !important; }
    .mobile-collapsible.expanded .mobile-toggle-text { display: none !important; }
  </style>
</head>
<body class="min-h-screen text-gray-900 dark:text-gray-100 antialiased">
  <main class="max-w-4xl mx-auto px-4 sm:px-5 py-5">

    <section class="hero rounded-3xl p-6 sm:p-7 text-white shadow-2xl">
      <div class="flex items-start justify-between gap-4 mb-7">
        <div>
          <div class="inline-flex items-center gap-2 px-3 py-2 rounded-full text-sm font-bold border border-white/20 bg-white/10">🍽️ ${escapeHtml(SITE_TITLE)}</div>
          <h1 class="m-0 mt-3 font-black leading-none tracking-tight">Dnešné obedové menu</h1>
          <div class="flex gap-2 flex-wrap mt-2 sm:hidden">
            <strong class="text-sm">${escapeHtml(today)}</strong>
            <span class="text-white/70 text-xs self-center">Aktualizované ${escapeHtml(updatedAt)}</span>
          </div>
        </div>
        <div class="flex items-start gap-2 flex-none">
          <div class="hidden sm:block min-w-[164px] p-4 rounded-2xl bg-white/10 border border-white/15 text-right leading-tight">
            <strong class="block text-sm">${escapeHtml(today)}</strong>
            <span class="block mt-1 text-white/70 text-xs">Aktualizované ${escapeHtml(updatedAt)}</span>
          </div>
          <button id="theme-toggle" type="button" aria-label="Prepnúť tmavý režim" class="grid place-items-center w-11 h-11 rounded-2xl bg-white/10 border border-white/15 text-xl cursor-pointer hover:bg-white/20">🌙</button>
        </div>
      </div>
      <div class="grid grid-cols-3 gap-2">
        <div class="p-3 sm:p-4 rounded-2xl bg-white/10 border border-white/15">
          <strong class="block text-2xl font-black leading-none">${items.length}</strong>
          <span class="block mt-1.5 text-white/70 text-xs font-semibold">položiek menu</span>
        </div>
        <div class="p-3 sm:p-4 rounded-2xl bg-white/10 border border-white/15">
          <strong class="block text-2xl font-black leading-none">${new Set(items.map((item) => item.source_id)).size}</strong>
          <span class="block mt-1.5 text-white/70 text-xs font-semibold">zdrojov</span>
        </div>
        <div class="p-3 sm:p-4 rounded-2xl bg-white/10 border border-white/15">
          <strong class="block text-2xl font-black leading-none">${locations.length}</strong>
          <span class="block mt-1.5 text-white/70 text-xs font-semibold">lokalít</span>
        </div>
      </div>
    </section>

    <section class="grid gap-4 mt-5">
      ${error ? `<div class="border border-gray-200 dark:border-gray-700 rounded-3xl bg-white/95 dark:bg-gray-800/95 shadow-lg p-6"><h2 class="text-xl font-bold">Menu sa nepodarilo načítať</h2><p class="text-gray-500 dark:text-gray-400">${escapeHtml(error)}</p></div>` : ''}
      ${!error && items.length === 0 ? '<div class="border border-gray-200 dark:border-gray-700 rounded-3xl bg-white/95 dark:bg-gray-800/95 shadow-lg p-6"><h2 class="text-xl font-bold">Zatiaľ tu nie je menu</h2><p class="text-gray-500 dark:text-gray-400">V databáze nie sú položky pre dnešný deň.</p></div>' : ''}
      ${!error ? content : ''}
    </section>

    <footer class="py-6 text-center text-xs text-gray-400 dark:text-gray-500">Powered by n8n · PostgreSQL · Docker · Raspberry Pi homelab</footer>
  </main>
  <script>
    document.querySelectorAll('.restaurant-card.mobile-collapsible .restaurant-toggle').forEach((button) => {
      button.addEventListener('click', () => {
        const card = button.closest('.restaurant-card');
        const expanded = card.classList.toggle('expanded');
        button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      });
    });

    const themeToggle = document.getElementById('theme-toggle');
    function syncThemeIcon() {
      themeToggle.textContent = document.documentElement.classList.contains('dark') ? '☀️' : '🌙';
    }
    syncThemeIcon();
    themeToggle.addEventListener('click', () => {
      const dark = document.documentElement.classList.toggle('dark');
      localStorage.setItem('lunch_theme', dark ? 'dark' : 'light');
      syncThemeIcon();
    });
  </script>
</body>
</html>`;
}

function renderAuthPage({ hasUsers = true, error = '', notice = '' } = {}) {
  const authInput = 'mt-1 w-full border border-gray-300 rounded-xl px-4 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-gray-900';
  const authLabel = 'block text-xs font-bold text-gray-500 uppercase tracking-wide';

  return `<!doctype html>
<html lang="sk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Prihlásenie · ${escapeHtml(SITE_TITLE)}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/tailwind.css">
</head>
<body class="min-h-screen grid place-items-center bg-gray-100 text-gray-900 antialiased px-3 py-8">
  <main class="w-full max-w-md">
    <div class="bg-white border border-gray-200 rounded-3xl shadow-lg p-6">
      <h1 class="m-0 text-3xl font-black tracking-tight">Admin menu</h1>
      <p class="mt-1 mb-5 text-sm text-gray-500">Prihlás sa e-mailom a heslom.</p>

      ${error ? `<div class="mb-4 px-4 py-3 bg-red-50 border border-red-200 text-red-800 font-semibold rounded-xl text-sm">${escapeHtml(error)}</div>` : ''}
      ${notice ? `<div class="mb-4 px-4 py-3 bg-green-50 border border-green-200 text-green-800 font-semibold rounded-xl text-sm">${escapeHtml(notice)}</div>` : ''}

      <form method="post" action="/admin/login" class="grid gap-3">
        <label class="block"><span class="${authLabel}">E-mail</span><input type="email" name="email" required autocomplete="username" autofocus class="${authInput}"></label>
        <label class="block"><span class="${authLabel}">Heslo</span><input type="password" name="password" required autocomplete="current-password" class="${authInput}"></label>
        <button type="submit" class="mt-1 w-full px-4 py-3 bg-gray-900 hover:bg-gray-800 text-white font-black rounded-xl cursor-pointer border-0">Prihlásiť</button>
      </form>
    </div>

    <div class="bg-white border border-gray-200 rounded-3xl shadow-lg p-6 mt-4">
      <h2 class="m-0 text-lg font-black tracking-tight">Registrácia</h2>
      <p class="mt-1 mb-4 text-sm text-gray-500">${hasUsers
        ? 'Nový účet získa rolu <strong>user</strong> a musí ho schváliť admin.'
        : 'Zatiaľ neexistuje žiadny účet — <strong>prvý zaregistrovaný používateľ sa stane adminom</strong>.'}</p>
      <form method="post" action="/admin/register" class="grid gap-3">
        <label class="block"><span class="${authLabel}">E-mail</span><input type="email" name="email" required autocomplete="username" class="${authInput}"></label>
        <label class="block"><span class="${authLabel}">Heslo (min. 8 znakov)</span><input type="password" name="password" required minlength="8" autocomplete="new-password" class="${authInput}"></label>
        <label class="block"><span class="${authLabel}">Heslo znova</span><input type="password" name="password_confirm" required minlength="8" autocomplete="new-password" class="${authInput}"></label>
        <button type="submit" class="mt-1 w-full px-4 py-3 bg-green-600 hover:bg-green-700 text-white font-black rounded-xl cursor-pointer border-0">Registrovať</button>
      </form>
    </div>
  </main>
</body>
</html>`;
}

function renderAdminPage({ items, sources, locations, users = [], currentUser, menuDate, notice = '', error = '', activeTab = 'polozky' }) {
  const isAdminUser = currentUser.role === 'admin';
  const tabs = isAdminUser ? ['polozky', 'restauracie', 'lokality', 'pouzivatelia'] : ['polozky', 'restauracie', 'lokality'];
  const tw = {
    input: 'mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gray-900',
    label: 'block text-xs font-bold text-gray-500 uppercase tracking-wide',
    btnGreen: 'px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-bold rounded-full cursor-pointer border-0',
    btnRed: 'px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-bold rounded-full cursor-pointer border-0',
    btnGray: 'px-4 py-2 bg-gray-800 hover:bg-gray-700 text-white text-sm font-bold rounded-full cursor-pointer border-0',
    btnOutline: 'px-4 py-2 bg-white hover:bg-gray-50 text-gray-700 text-sm font-bold rounded-full cursor-pointer border border-gray-300',
    th: 'px-4 py-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wider',
    td: 'px-4 py-3 text-sm text-gray-900',
  };

  const sourceOptions = (selected = '') => sources.map((s) =>
    `<option value="${escapeHtml(s.source_id)}" ${s.source_id === selected ? 'selected' : ''}>${escapeHtml(s.source_name)} (${escapeHtml(s.source_id)})</option>`
  ).join('');

  const categoryOptions = (selected = 'main') => CATEGORIES.map((c) =>
    `<option value="${c}" ${c === selected ? 'selected' : ''}>${escapeHtml(categoryLabel(c))}</option>`
  ).join('');

  const locationOptions = (selected = 'Praca') => {
    const names = locations.length ? locations.map((l) => l.name) : LOCATION_OPTIONS;
    const opts = names.map((name) => `<option value="${escapeHtml(name)}" ${name === selected ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('');
    return opts + (!names.includes(selected) ? `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}</option>` : '');
  };

  const restaurantTableRows = sources.map((src) => `
    <tr class="hover:bg-gray-50">
      <td class="${tw.td}">
        <div class="font-semibold">${escapeHtml(src.source_name)}</div>
        <div class="text-xs text-gray-400 mt-0.5">${escapeHtml(src.source_id)}</div>
      </td>
      <td class="${tw.td} text-gray-500">${escapeHtml(src.source_type)}</td>
      <td class="${tw.td}">
        <form class="flex items-center gap-2 flex-wrap" method="post" action="/admin/restaurants/update">
          <input type="hidden" name="_tab" value="restauracie">
          <input type="hidden" name="source_id" value="${escapeHtml(src.source_id)}">
          <select name="source_location" class="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white">${locationOptions(src.source_location || 'Praca')}</select>
          <button type="submit" class="${tw.btnGreen}">Uložiť</button>
        </form>
      </td>
    </tr>
  `).join('');

  const locationTableRows = locations.map((loc) => `
    <tr class="hover:bg-gray-50">
      <td class="${tw.td} font-semibold">${escapeHtml(loc.name)}</td>
      <td class="${tw.td}">
        <form class="flex items-center gap-2" method="post" action="/admin/locations/update">
          <input type="hidden" name="_tab" value="lokality">
          <input type="hidden" name="name" value="${escapeHtml(loc.name)}">
          <input type="number" name="weight" value="${escapeHtml(String(loc.weight))}" min="0" max="9999" class="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white w-24">
          <button type="submit" class="${tw.btnGreen}">Uložiť</button>
        </form>
      </td>
      <td class="${tw.td}">
        <form method="post" action="/admin/locations/delete" onsubmit="return confirm('Naozaj zmazať lokalitu ${escapeHtml(loc.name)}?')">
          <input type="hidden" name="_tab" value="lokality">
          <input type="hidden" name="name" value="${escapeHtml(loc.name)}">
          <button type="submit" class="${tw.btnRed}">Zmazať</button>
        </form>
      </td>
    </tr>
  `).join('');

  const userTableRows = users.map((u) => `
    <tr class="hover:bg-gray-50">
      <td class="${tw.td} font-semibold">${escapeHtml(u.email)}</td>
      <td class="${tw.td}"><span class="px-2 py-1 rounded-full text-xs font-bold ${u.role === 'admin' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}">${escapeHtml(u.role)}</span></td>
      <td class="${tw.td}">${u.is_approved
        ? '<span class="px-2 py-1 rounded-full text-xs font-bold bg-green-100 text-green-800">schválený</span>'
        : '<span class="px-2 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-800">čaká na schválenie</span>'}</td>
      <td class="${tw.td} text-gray-500 whitespace-nowrap">${escapeHtml(formatDateSk(new Date(u.created_at)))}</td>
      <td class="${tw.td}">
        <div class="flex gap-2 flex-wrap">
          ${u.is_approved ? '' : `
          <form method="post" action="/admin/users/approve">
            <input type="hidden" name="_tab" value="pouzivatelia">
            <input type="hidden" name="id" value="${escapeHtml(u.id)}">
            <button type="submit" class="${tw.btnGreen}">Schváliť</button>
          </form>`}
          ${Number(u.id) === Number(currentUser.id) ? '' : `
          <form method="post" action="/admin/users/delete" onsubmit="return confirm('Naozaj zmazať používateľa ${escapeHtml(u.email)}?')">
            <input type="hidden" name="_tab" value="pouzivatelia">
            <input type="hidden" name="id" value="${escapeHtml(u.id)}">
            <button type="submit" class="${tw.btnRed}">Zmazať</button>
          </form>`}
        </div>
      </td>
    </tr>
  `).join('');

  const itemTableRows = items.map((item) => {
    const dateValue = String(item.menu_date).slice(0, 10);
    const itemAllergens = Array.isArray(item.allergens) ? item.allergens.join(', ') : '';
    const editId = `edit-${escapeHtml(item.id)}`;
    return `
      <tr class="hover:bg-gray-50 border-b border-gray-100">
        <td class="px-4 py-3 text-sm font-mono text-gray-400 whitespace-nowrap">${escapeHtml(item.menu_code || '—')}</td>
        <td class="${tw.td}">
          <div class="font-semibold">${escapeHtml(item.title)}</div>
          <div class="text-xs text-gray-400 mt-0.5">${escapeHtml(item.source_name || '')}</div>
        </td>
        <td class="${tw.td} text-gray-500 whitespace-nowrap">${escapeHtml(categoryLabel(item.category || 'main'))}</td>
        <td class="${tw.td} font-semibold whitespace-nowrap">${escapeHtml(euro(item.price_eur))}</td>
        <td class="${tw.td}">
          <div class="flex gap-2 flex-wrap">
            <button type="button" onclick="toggleRow('${editId}')" class="${tw.btnGray}">Upraviť</button>
            <form method="post" action="/admin/items/delete" onsubmit="return confirm('Naozaj zmazať položku?')">
              <input type="hidden" name="_tab" value="polozky">
              <input type="hidden" name="id" value="${escapeHtml(item.id)}">
              <button type="submit" class="${tw.btnRed}">Zmazať</button>
            </form>
          </div>
        </td>
      </tr>
      <tr id="${editId}" class="hidden bg-gray-50 border-b border-gray-200">
        <td colspan="5" class="px-4 py-4">
          <form class="grid grid-cols-2 md:grid-cols-4 gap-3" method="post" action="/admin/items/update">
            <input type="hidden" name="_tab" value="polozky">
            <input type="hidden" name="id" value="${escapeHtml(item.id)}">
            <label class="block"><span class="${tw.label}">Dátum</span><input type="date" name="menu_date" value="${escapeHtml(dateValue)}" class="${tw.input}"></label>
            <label class="block"><span class="${tw.label}">Reštaurácia</span><select name="source_id" class="${tw.input}">${sourceOptions(item.source_id)}</select></label>
            <label class="block"><span class="${tw.label}">Kód</span><input name="menu_code" value="${escapeHtml(item.menu_code || '')}" class="${tw.input}"></label>
            <label class="block"><span class="${tw.label}">Kategória</span><select name="category" class="${tw.input}">${categoryOptions(item.category || 'main')}</select></label>
            <label class="block col-span-2"><span class="${tw.label}">Názov</span><input name="title" value="${escapeHtml(item.title || '')}" required class="${tw.input}"></label>
            <label class="block col-span-2"><span class="${tw.label}">Popis</span><textarea name="description" rows="2" class="${tw.input} resize-y">${escapeHtml(item.description || '')}</textarea></label>
            <label class="block"><span class="${tw.label}">Cena EUR</span><input name="price_eur" inputmode="decimal" value="${escapeHtml(item.price_eur ?? '')}" class="${tw.input}"></label>
            <label class="block"><span class="${tw.label}">Mena</span><input name="currency" value="${escapeHtml(item.currency || 'EUR')}" class="${tw.input}"></label>
            <label class="block col-span-2"><span class="${tw.label}">Alergény</span><input name="allergens" value="${escapeHtml(itemAllergens)}" placeholder="1, 3, 7" class="${tw.input}"></label>
            <label class="block col-span-4"><span class="${tw.label}">Raw text</span><textarea name="raw_text" rows="2" class="${tw.input} resize-y">${escapeHtml(item.raw_text || '')}</textarea></label>
            <label class="flex items-center gap-2 text-sm col-span-2"><input type="checkbox" name="is_available" ${item.is_available ? 'checked' : ''} class="rounded"> Zobrazovať</label>
            <div class="col-span-2 flex justify-end items-end gap-2">
              <button type="button" onclick="toggleRow('${editId}')" class="${tw.btnOutline}">Zrušiť</button>
              <button type="submit" class="${tw.btnGreen}">Uložiť</button>
            </div>
          </form>
        </td>
      </tr>
    `;
  }).join('');

  return `<!doctype html>
<html lang="sk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Admin · ${escapeHtml(SITE_TITLE)}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/tailwind.css">
  <style>.tab-panel{display:none}.tab-panel.active{display:block}</style>
</head>
<body class="bg-gray-100 text-gray-900 min-h-screen antialiased">
  <main class="max-w-6xl mx-auto px-4 py-6">

    <div class="flex justify-between items-start gap-4 mb-6 flex-wrap">
      <div>
        <h1 class="text-4xl font-black tracking-tight leading-none">Admin menu</h1>
        <p class="text-gray-500 mt-1 text-sm">Správa položiek, reštaurácií a lokalít.</p>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <span class="px-3 py-2 bg-white border border-gray-200 rounded-full text-sm text-gray-600">${escapeHtml(currentUser.email)} <span class="ml-1 px-2 py-0.5 rounded-full text-xs font-bold ${isAdminUser ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}">${isAdminUser ? 'admin' : 'user'}</span></span>
        <a href="/" class="${tw.btnGray} no-underline">Web</a>
        <a href="/admin/logout" class="${tw.btnGray} no-underline">Odhlásiť</a>
      </div>
    </div>

    ${notice ? `<div class="mb-4 px-4 py-3 bg-green-50 border border-green-200 text-green-800 font-semibold rounded-xl text-sm">${escapeHtml(notice)}</div>` : ''}
    ${error ? `<div class="mb-4 px-4 py-3 bg-red-50 border border-red-200 text-red-800 font-semibold rounded-xl text-sm">${escapeHtml(error)}</div>` : ''}

    <div class="bg-white border border-gray-200 rounded-2xl shadow-sm p-4 mb-4">
      <form class="flex items-end gap-3 flex-wrap" method="get" action="/admin">
        <label class="block"><span class="${tw.label}">Dátum</span><input type="date" name="date" value="${escapeHtml(menuDate)}" class="${tw.input}"></label>
        <button type="submit" class="${tw.btnGray}">Filtrovať</button>
      </form>
    </div>

    <div class="flex gap-2 mb-4 flex-wrap">
      <button class="tab-btn px-5 py-2 rounded-full text-sm font-bold border cursor-pointer" data-tab="polozky">Položky</button>
      <button class="tab-btn px-5 py-2 rounded-full text-sm font-bold border cursor-pointer" data-tab="restauracie">Reštaurácie</button>
      <button class="tab-btn px-5 py-2 rounded-full text-sm font-bold border cursor-pointer" data-tab="lokality">Lokality</button>
      ${isAdminUser ? '<button class="tab-btn px-5 py-2 rounded-full text-sm font-bold border cursor-pointer" data-tab="pouzivatelia">Používatelia</button>' : ''}
    </div>

    <!-- TAB: Položky -->
    <div id="tab-polozky" class="tab-panel">
      <div class="bg-white border border-gray-200 rounded-2xl shadow-sm p-5 mb-4">
        <h2 class="text-base font-bold mb-3">Pridať položku</h2>
        <form class="grid grid-cols-2 md:grid-cols-4 gap-3" method="post" action="/admin/items/create">
          <input type="hidden" name="_tab" value="polozky">
          <label class="block"><span class="${tw.label}">Dátum</span><input type="date" name="menu_date" value="${escapeHtml(menuDate)}" class="${tw.input}"></label>
          <label class="block"><span class="${tw.label}">Reštaurácia</span><select name="source_id" class="${tw.input}">${sourceOptions()}</select></label>
          <label class="block"><span class="${tw.label}">Kód</span><input name="menu_code" placeholder="01" class="${tw.input}"></label>
          <label class="block"><span class="${tw.label}">Kategória</span><select name="category" class="${tw.input}">${categoryOptions('main')}</select></label>
          <label class="block col-span-2"><span class="${tw.label}">Názov</span><input name="title" required class="${tw.input}"></label>
          <label class="block col-span-2"><span class="${tw.label}">Popis</span><textarea name="description" rows="2" class="${tw.input} resize-y"></textarea></label>
          <label class="block"><span class="${tw.label}">Cena EUR</span><input name="price_eur" inputmode="decimal" placeholder="8,90" class="${tw.input}"></label>
          <label class="block"><span class="${tw.label}">Mena</span><input name="currency" value="EUR" class="${tw.input}"></label>
          <label class="block col-span-2"><span class="${tw.label}">Alergény</span><input name="allergens" placeholder="1, 3, 7" class="${tw.input}"></label>
          <label class="block col-span-4"><span class="${tw.label}">Raw text</span><textarea name="raw_text" rows="2" class="${tw.input} resize-y"></textarea></label>
          <label class="flex items-center gap-2 text-sm col-span-3"><input type="checkbox" name="is_available" checked class="rounded"> Zobrazovať</label>
          <div class="flex justify-end items-end"><button type="submit" class="${tw.btnGreen}">Pridať</button></div>
        </form>
      </div>

      <div class="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
        <div class="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 class="text-base font-bold">Položky pre ${escapeHtml(menuDate)}</h2>
          <span class="text-sm text-gray-400">${items.length} položiek</span>
        </div>
        ${items.length ? `
        <div class="overflow-x-auto">
          <table class="min-w-full divide-y divide-gray-100">
            <thead class="bg-gray-50">
              <tr>
                <th class="${tw.th}">Kód</th>
                <th class="${tw.th}">Názov</th>
                <th class="${tw.th}">Kategória</th>
                <th class="${tw.th}">Cena</th>
                <th class="${tw.th}">Akcie</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 bg-white">
              ${itemTableRows}
            </tbody>
          </table>
        </div>
        ` : '<p class="px-5 py-6 text-sm text-gray-400">Pre tento dátum nie sú žiadne položky.</p>'}
      </div>
    </div>

    <!-- TAB: Reštaurácie -->
    <div id="tab-restauracie" class="tab-panel">
      <div class="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
        <div class="px-5 py-3 border-b border-gray-100">
          <h2 class="text-base font-bold">Reštaurácie</h2>
          <p class="text-sm text-gray-400 mt-0.5">Lokalita určuje skupinu, pod ktorou sa reštaurácia zobrazí na hlavnej stránke.</p>
        </div>
        <div class="overflow-x-auto">
          <table class="min-w-full divide-y divide-gray-100">
            <thead class="bg-gray-50">
              <tr>
                <th class="${tw.th}">Reštaurácia</th>
                <th class="${tw.th}">Typ</th>
                <th class="${tw.th}">Lokalita</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 bg-white">
              ${restaurantTableRows}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TAB: Lokality -->
    <div id="tab-lokality" class="tab-panel">
      <div class="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
        <div class="px-5 py-3 border-b border-gray-100">
          <h2 class="text-base font-bold">Lokality</h2>
          <p class="text-sm text-gray-400 mt-0.5">Nižšia váha = lokalita sa zobrazí skôr na hlavnej stránke.</p>
        </div>
        <div class="overflow-x-auto">
          <table class="min-w-full divide-y divide-gray-100">
            <thead class="bg-gray-50">
              <tr>
                <th class="${tw.th}">Lokalita</th>
                <th class="${tw.th}">Váha</th>
                <th class="${tw.th}">Akcie</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 bg-white">
              ${locationTableRows || `<tr><td colspan="3" class="px-5 py-6 text-sm text-gray-400">Žiadne lokality.</td></tr>`}
            </tbody>
          </table>
        </div>
        <div class="px-5 py-4 border-t border-gray-100 bg-gray-50">
          <form class="flex items-end gap-3 flex-wrap" method="post" action="/admin/locations/create">
            <input type="hidden" name="_tab" value="lokality">
            <label class="block"><span class="${tw.label}">Nová lokalita</span><input name="name" placeholder="napr. Centrum" class="${tw.input} w-44"></label>
            <label class="block"><span class="${tw.label}">Váha</span><input type="number" name="weight" value="100" min="0" max="9999" class="${tw.input} w-24"></label>
            <div class="flex items-end"><button type="submit" class="${tw.btnGreen}">Pridať lokalitu</button></div>
          </form>
        </div>
      </div>
    </div>

    ${isAdminUser ? `
    <!-- TAB: Používatelia -->
    <div id="tab-pouzivatelia" class="tab-panel">
      <div class="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
        <div class="px-5 py-3 border-b border-gray-100">
          <h2 class="text-base font-bold">Používatelia</h2>
          <p class="text-sm text-gray-400 mt-0.5">Nové registrácie musíš schváliť, kým sa používateľ bude môcť prihlásiť.</p>
        </div>
        <div class="overflow-x-auto">
          <table class="min-w-full divide-y divide-gray-100">
            <thead class="bg-gray-50">
              <tr>
                <th class="${tw.th}">E-mail</th>
                <th class="${tw.th}">Rola</th>
                <th class="${tw.th}">Stav</th>
                <th class="${tw.th}">Registrovaný</th>
                <th class="${tw.th}">Akcie</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 bg-white">
              ${userTableRows || `<tr><td colspan="5" class="px-5 py-6 text-sm text-gray-400">Žiadni používatelia.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    ` : ''}

  </main>
  <script>
    function toggleRow(id) { document.getElementById(id).classList.toggle('hidden'); }
    const TABS = ${JSON.stringify(tabs)};
    function activateTab(name) {
      if (!TABS.includes(name)) name = 'polozky';
      TABS.forEach((t) => {
        document.getElementById('tab-' + t).classList.toggle('active', t === name);
      });
      document.querySelectorAll('.tab-btn').forEach((btn) => {
        const on = btn.dataset.tab === name;
        btn.className = 'tab-btn px-5 py-2 rounded-full text-sm font-bold border cursor-pointer ' +
          (on ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50');
      });
      history.replaceState(null, '', location.pathname + location.search + '#' + name);
    }
    document.querySelectorAll('.tab-btn').forEach((btn) => btn.addEventListener('click', () => activateTab(btn.dataset.tab)));
    activateTab('${escapeHtml(activeTab)}' || location.hash.slice(1) || 'polozky');
  </script>
</body>
</html>`;
}

async function adminGet(req, res, url) {
  const user = await getSessionUser(req);
  if (!user) {
    return sendHtml(res, 401, renderAuthPage({
      hasUsers: (await countUsers()) > 0,
      error: url.searchParams.get('error') || '',
      notice: url.searchParams.get('notice') || '',
    }));
  }

  const menuDate = url.searchParams.get('date') || todayIso();
  const data = await queryAdminData(menuDate);
  const users = user.role === 'admin' ? await listUsers() : [];
  sendHtml(res, 200, renderAdminPage({
    ...data,
    users,
    currentUser: user,
    menuDate,
    notice: url.searchParams.get('notice') || '',
    error: url.searchParams.get('error') || '',
    activeTab: url.searchParams.get('tab') || 'polozky',
  }));
}

async function adminPost(req, res, url) {
  if (url.pathname === '/admin/login') {
    const form = await readForm(req);
    try {
      const user = await authenticateUser(form);
      const token = await createSession(user.id);
      return redirect(res, '/admin', { 'set-cookie': sessionCookie(token) });
    } catch (err) {
      return redirect(res, `/admin?error=${encodeURIComponent(err.message)}`);
    }
  }

  if (url.pathname === '/admin/register') {
    const form = await readForm(req);
    try {
      const user = await registerUser(form);
      if (user.is_approved) {
        const token = await createSession(user.id);
        return redirect(res, '/admin', { 'set-cookie': sessionCookie(token) });
      }
      return redirect(res, `/admin?notice=${encodeURIComponent('Registrácia prebehla. Prihlásiť sa budeš môcť po schválení adminom.')}`);
    } catch (err) {
      return redirect(res, `/admin?error=${encodeURIComponent(err.message)}`);
    }
  }

  const user = await getSessionUser(req);
  if (!user) return redirect(res, `/admin?error=${encodeURIComponent('Neautorizovaný prístup')}`);

  const form = await readForm(req);
  const menuDate = clean(form.menu_date, todayIso());
  const tab = clean(form._tab, 'polozky');
  try {
    if (url.pathname === '/admin/users/approve' || url.pathname === '/admin/users/delete') {
      if (user.role !== 'admin') throw new Error('Len admin môže spravovať používateľov.');
      if (url.pathname === '/admin/users/approve') await approveUser(form);
      else await deleteUser(form, user);
    }
    else if (url.pathname === '/admin/items/create') await createItem(form);
    else if (url.pathname === '/admin/items/update') await updateItem(form);
    else if (url.pathname === '/admin/items/delete') await deleteItem(form);
    else if (url.pathname === '/admin/restaurants/update') await updateRestaurant(form);
    else if (url.pathname === '/admin/locations/create') await createLocation(form);
    else if (url.pathname === '/admin/locations/update') await updateLocation(form);
    else if (url.pathname === '/admin/locations/delete') await deleteLocation(form);
    else return sendHtml(res, 404, '<h1>404</h1>');

    redirect(res, `/admin?date=${encodeURIComponent(menuDate)}&tab=${encodeURIComponent(tab)}&notice=${encodeURIComponent('Zmena bola uložená.')}`);
  } catch (err) {
    redirect(res, `/admin?date=${encodeURIComponent(menuDate)}&tab=${encodeURIComponent(tab)}&error=${encodeURIComponent(err.message)}`);
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

    if (req.method === 'GET' && url.pathname === '/favicon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=604800' });
      res.end(faviconSvg);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/tailwind.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=3600' });
      res.end(tailwindCss);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/logout') {
      await destroySession(req);
      return redirect(res, '/admin', { 'set-cookie': 'lunch_session=; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=0' });
    }

    if (req.method === 'GET' && url.pathname === '/admin') return await adminGet(req, res, url);
    if (req.method === 'POST' && url.pathname.startsWith('/admin/')) return await adminPost(req, res, url);

    if (req.method === 'GET' && url.pathname === '/') {
      const { items, lastUpdatedAt } = await queryTodayMenu();
      return sendHtml(res, 200, renderPublicPage(items, null, lastUpdatedAt));
    }

    sendHtml(res, 404, '<h1>404</h1>');
  } catch (err) {
    console.error(`${req.method} ${url.pathname} zlyhalo:`, err);
    sendHtml(res, 500, `<h1>Chyba</h1><pre>${escapeHtml(IS_PRODUCTION ? 'Interná chyba servera.' : err.message)}</pre>`);
  }
});

async function start() {
  await ensureSchemaWithRetry();
  server.listen(PORT, '0.0.0.0', () => console.log(`obedove-menu listening on ${PORT}`));
}

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
