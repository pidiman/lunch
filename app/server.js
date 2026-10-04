const http = require('http');
const net = require('net');
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
const RESET_CODE_TTL_MINUTES = 15;
const SMTP_HOST = process.env.SMTP_HOST || 'smtp-relay';
const SMTP_PORT = Number(process.env.SMTP_PORT || 25);
const SMTP_FROM = process.env.SMTP_FROM || 'obedove-menu@localhost';
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.lunch_password_resets (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES public.lunch_users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
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

// Minimal SMTP client for a trusted local relay (no auth, no TLS)
function sendMail(to, subject, text) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SMTP_PORT, SMTP_HOST);
    let buffer = '';
    let step = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(10000, () => fail(new Error('SMTP timeout')));
    socket.on('error', fail);

    const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
    const message = [
      `From: ${SITE_TITLE.replace(/[\r\n"]/g, '')} <${SMTP_FROM}>`,
      `To: <${to}>`,
      `Subject: ${encodedSubject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@obedove-menu>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      text,
    ].join('\r\n').replace(/\r?\n\./g, '\r\n..');

    const steps = [
      { expect: 220, send: `EHLO obedove-menu` },
      { expect: 250, send: `MAIL FROM:<${SMTP_FROM}>` },
      { expect: 250, send: `RCPT TO:<${to}>` },
      { expect: 250, send: 'DATA' },
      { expect: 354, send: `${message}\r\n.` },
      { expect: 250, send: 'QUIT' },
      { expect: 221, send: null },
    ];

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      // A reply is complete when its last line is "NNN<space>..."
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || !/^\d{3} /.test(last)) return;
      const code = Number(last.slice(0, 3));
      buffer = '';

      const current = steps[step];
      if (code !== current.expect) return fail(new Error(`SMTP odpoveď ${code}: ${last.slice(4)}`));
      if (current.send === null) {
        settled = true;
        socket.end();
        return resolve();
      }
      socket.write(current.send + '\r\n');
      step += 1;
    });
  });
}

async function requestPasswordReset(form) {
  const email = normalizeEmail(form.email);
  if (!EMAIL_RE.test(email)) throw new Error('Zadaj platnú e-mailovú adresu.');
  const result = await pool.query(`SELECT id FROM public.lunch_users WHERE email = $1`, [email]);
  const user = result.rows[0];
  if (!user) return; // same response whether or not the account exists

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await pool.query(`DELETE FROM public.lunch_password_resets WHERE user_id = $1`, [user.id]);
  await pool.query(`
    INSERT INTO public.lunch_password_resets (user_id, code_hash, expires_at)
    VALUES ($1, $2, NOW() + make_interval(mins => $3))
  `, [user.id, hashSessionToken(code), RESET_CODE_TTL_MINUTES]);

  await sendMail(
    email,
    `Obnovenie hesla · ${SITE_TITLE}`,
    `Ahoj,\r\n\r\ntvoj jednorazový kód na obnovenie hesla je: ${code}\r\n\r\nKód platí ${RESET_CODE_TTL_MINUTES} minút a dá sa použiť iba raz.\r\nAk si o obnovenie hesla nežiadal(a), tento e-mail ignoruj.\r\n\r\n${SITE_TITLE}`
  );
}

async function confirmPasswordReset(form) {
  const email = normalizeEmail(form.email);
  const code = clean(form.code);
  const password = String(form.password || '');
  if (!/^\d{6}$/.test(code)) throw new Error('Kód má 6 číslic.');
  if (password.length < 8) throw new Error('Heslo musí mať aspoň 8 znakov.');
  if (password !== String(form.password_confirm || '')) throw new Error('Heslá sa nezhodujú.');

  const result = await pool.query(`
    SELECT r.id, r.user_id
    FROM public.lunch_password_resets r
    JOIN public.lunch_users u ON u.id = r.user_id
    WHERE u.email = $1 AND r.code_hash = $2 AND r.expires_at > NOW() AND r.used_at IS NULL
  `, [email, hashSessionToken(code)]);
  const reset = result.rows[0];
  if (!reset) throw new Error('Neplatný alebo expirovaný kód.');

  const passwordHash = await hashPassword(password);
  await pool.query(`UPDATE public.lunch_password_resets SET used_at = NOW() WHERE id = $1`, [reset.id]);
  await pool.query(`UPDATE public.lunch_users SET password_hash = $2, updated_at = NOW() WHERE id = $1`, [reset.user_id, passwordHash]);
  await pool.query(`DELETE FROM public.lunch_sessions WHERE user_id = $1`, [reset.user_id]);
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

function categoryClasses(category) {
  return {
    soup: { badge: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300', text: 'text-orange-800 dark:text-orange-300' },
    main: { badge: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300', text: 'text-emerald-800 dark:text-emerald-300' },
    special: { badge: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300', text: 'text-amber-800 dark:text-amber-300' },
    pizza: { badge: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300', text: 'text-red-800 dark:text-red-300' },
    side: { badge: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300', text: 'text-yellow-800 dark:text-yellow-300' },
    dessert: { badge: 'bg-pink-100 text-pink-800 dark:bg-pink-950 dark:text-pink-300', text: 'text-pink-800 dark:text-pink-300' },
    drink: { badge: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300', text: 'text-sky-800 dark:text-sky-300' },
  }[category] || { badge: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300', text: 'text-slate-700 dark:text-slate-300' };
}

function plural(n, one, few, many) {
  if (n === 1) return one;
  return n >= 2 && n <= 4 ? few : many;
}

function formatHeroDate(value = new Date()) {
  const opts = { timeZone: 'Europe/Bratislava' };
  const weekday = new Intl.DateTimeFormat('sk-SK', { ...opts, weekday: 'long' }).format(value);
  const date = new Intl.DateTimeFormat('sk-SK', { ...opts, day: '2-digit', month: '2-digit', year: 'numeric' }).format(value);
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} · ${date}`;
}

function cheapestMainPrice(items) {
  const prices = (category) => items
    .filter((item) => !category || category.includes(item.category))
    .map((item) => Number(item.price_eur))
    .filter((n) => Number.isFinite(n) && n > 0);
  const mains = prices(['main', 'special', 'pizza']);
  const any = mains.length ? mains : prices(null);
  return any.length ? euro(Math.min(...any)).replace(' €', '€') : '—';
}

const ARROW_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg>';

function renderMenuItem(item, index = 0) {
  const code = clean(item.menu_code);
  const category = item.category || 'unknown';
  const label = categoryLabel(category);
  const cls = categoryClasses(category);
  const itemAllergens = Array.isArray(item.allergens) ? item.allergens : [];
  const itemPrice = euro(item.price_eur);

  return `
    <div class="grid grid-cols-[36px_minmax(0,1fr)_auto] gap-3.5 items-start py-3.5 border-t border-dashed border-line ${index >= 3 ? 'mobile-extra' : ''}">
      <span class="grid place-items-center w-9 h-9 rounded-full text-sm font-bold ${cls.badge}" aria-hidden="true">${escapeHtml(code || label.charAt(0))}</span>
      <div class="min-w-0">
        <div class="text-xs font-bold uppercase tracking-wider ${cls.text}">${code ? `<span class="sr-only">Menu ${escapeHtml(code)}, </span>` : ''}${escapeHtml(label)}</div>
        <h4 class="m-0 mt-0.5 text-[17px] font-semibold leading-snug">${escapeHtml(item.title)}</h4>
        ${item.description ? `<p class="m-0 mt-0.5 text-sm text-muted">${escapeHtml(item.description)}</p>` : ''}
        ${itemAllergens.length ? `<p class="m-0 mt-1 text-xs text-muted">Alergény ${escapeHtml(itemAllergens.join(', '))}</p>` : ''}
      </div>
      ${itemPrice ? `<div class="pt-3.5 font-display font-bold text-[19px] whitespace-nowrap">${escapeHtml(itemPrice)}</div>` : '<div></div>'}
    </div>
  `;
}

function renderPublicPage(items, error = null, lastUpdatedAt = null) {
  const today = formatHeroDate(new Date());
  const updatedAt = formatTime(lastUpdatedAt);
  const updatedLabel = updatedAt === '—' ? 'Zatiaľ bez aktualizácie' : `Aktualizované o ${updatedAt}`;
  const grouped = groupByLocationAndSource(items);
  const sourceCount = new Set(items.map((item) => item.source_id)).size;

  // Order comes from the DB query (already sorted by location weight), preserve insertion order
  const locations = Object.keys(grouped);
  const locationItemCount = (location) => Object.values(grouped[location]).reduce((sum, rows) => sum + rows.length, 0);

  const content = locations.map((location) => {
    const restaurantEntries = Object.entries(grouped[location]);
    const itemCount = locationItemCount(location);
    const restaurants = restaurantEntries.map(([sourceName, rows]) => {
      const sourceUrl = rows.find((row) => row.source_url)?.source_url;
      const collapsible = rows.length > 3;
      return `
        <article class="restaurant-card flex flex-col bg-surface border border-line rounded-3xl p-5 sm:p-6 ${collapsible ? 'mobile-collapsible' : ''}">
          <div class="flex items-center justify-between gap-3 pb-3.5">
            <h3 class="m-0 font-display font-bold text-2xl tracking-tight">${escapeHtml(sourceName)}</h3>
            ${sourceUrl ? `<a class="inline-flex items-center gap-1 min-h-11 text-sm font-semibold text-ink no-underline hover:text-accent" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">Zdroj menu ${ARROW_SVG}</a>` : ''}
          </div>
          <div>${rows.map((row, index) => renderMenuItem(row, index)).join('')}</div>
          ${collapsible ? `<button type="button" class="restaurant-toggle sm:hidden mt-1 min-h-11 w-full rounded-2xl border border-line-strong bg-transparent text-ink text-sm font-semibold cursor-pointer" aria-expanded="false"><span class="toggle-more">Zobraziť všetko (${rows.length})</span><span class="toggle-less">Zobraziť menej</span></button>` : ''}
        </article>
      `;
    }).join('');

    return `
      <section class="location-section pb-10" data-location="${escapeHtml(location)}">
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-4">
          <span class="w-2.5 h-2.5 rounded-full bg-accent self-center flex-none"></span>
          <h2 class="m-0 font-display font-bold text-3xl tracking-tight">${escapeHtml(location)}</h2>
          <span class="text-sm text-muted">${restaurantEntries.length} ${plural(restaurantEntries.length, 'reštaurácia', 'reštaurácie', 'reštaurácií')} · ${itemCount} ${plural(itemCount, 'jedlo', 'jedlá', 'jedál')}</span>
        </div>
        <div class="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))]">${restaurants}</div>
      </section>
    `;
  }).join('');

  const tabClass = 'location-tab inline-flex items-center gap-2 h-11 px-4.5 rounded-full border text-[15px] font-semibold cursor-pointer bg-surface text-ink border-line-strong hover:border-ink aria-pressed:bg-ink aria-pressed:text-ground aria-pressed:border-ink';
  const tabs = locations.length > 1 ? [
    `<button type="button" class="${tabClass}" data-location="all" aria-pressed="true">Všetky lokality <span class="text-[13px] opacity-70">${items.length}</span></button>`,
    ...locations.map((location) => `<button type="button" class="${tabClass}" data-location="${escapeHtml(location)}" aria-pressed="false">${escapeHtml(location)} <span class="text-[13px] opacity-70">${locationItemCount(location)}</span></button>`),
  ].join('') : '';

  const statTile = (value, label) => `
    <div class="bg-surface border border-line rounded-[18px] p-3.5 sm:p-4">
      <div class="font-display font-extrabold text-[28px] sm:text-[34px] leading-none">${escapeHtml(value)}</div>
      <div class="mt-1.5 text-[13px] font-semibold text-muted">${escapeHtml(label)}</div>
    </div>`;

  const notice = (title, text) => `<div class="bg-surface border border-line rounded-3xl p-6 mb-10"><h2 class="m-0 font-display font-bold text-2xl tracking-tight">${escapeHtml(title)}</h2><p class="m-0 mt-2 text-muted">${escapeHtml(text)}</p></div>`;
  const inputClass = 'mt-1 w-full border border-line-strong rounded-xl px-4 py-3 text-base bg-ground text-ink focus:outline-none focus:ring-2 focus:ring-accent';
  const labelClass = 'block text-xs font-bold text-muted uppercase tracking-wide';
  const paneBtnClass = 'auth-pane-btn h-10 px-4 rounded-full text-sm font-semibold border cursor-pointer bg-surface text-muted border-line-strong aria-pressed:bg-ink aria-pressed:text-ground aria-pressed:border-ink';

  return `<!doctype html>
<html lang="sk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>${escapeHtml(SITE_TITLE)}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&family=Figtree:wght@400;500;600;700&display=swap">
  <link rel="stylesheet" href="/tailwind.css">
  <script>
    (function () {
      let saved = null;
      try { saved = localStorage.getItem('lunch_theme'); } catch {}
      if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
      }
    })();
  </script>
  <style>
    @media (max-width: 639px) {
      .mobile-collapsible:not(.expanded) .mobile-extra { display: none; }
    }
    .restaurant-card .toggle-less, .restaurant-card.expanded .toggle-more { display: none; }
    .restaurant-card.expanded .toggle-less { display: inline; }
  </style>
</head>
<body class="min-h-screen bg-ground text-ink font-body antialiased">
  <div class="max-w-[1160px] mx-auto px-4">

    <header class="flex items-center justify-between gap-3 py-5">
      <div class="flex items-center gap-2.5 sm:gap-3 min-w-0">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true"><rect width="40" height="40" rx="12" class="fill-ink"/><circle cx="20" cy="21" r="10" stroke-width="2.4" class="stroke-ground"/><path d="M15 12c2-2 8-2 10 0" stroke-width="2.4" stroke-linecap="round" class="stroke-accent"/></svg>
        <span class="font-display font-bold text-lg sm:text-xl tracking-tight truncate">${escapeHtml(SITE_TITLE)}</span>
      </div>
      <div class="flex items-center gap-2 flex-none">
        <button id="theme-toggle" type="button" aria-label="Prepnúť tmavý režim" class="grid place-items-center w-11 h-11 rounded-xl border border-line-strong bg-surface text-ink cursor-pointer hover:border-ink">
          <svg class="dark:hidden" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
          <svg class="hidden dark:block" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        </button>
        <button id="login-open" type="button" class="h-11 px-3.5 sm:px-4.5 rounded-xl border-0 bg-ink text-ground text-[15px] font-semibold cursor-pointer hover:opacity-90">Prihlásiť sa</button>
      </div>
    </header>

    <section class="flex flex-wrap items-end justify-between gap-8 pt-6 sm:pt-10 pb-8">
      <div class="flex-[1_1_520px] min-w-0">
        <p class="m-0 mb-3.5 text-[15px] font-semibold text-muted">${escapeHtml(today)}</p>
        <h1 class="m-0 font-display font-extrabold text-[clamp(44px,7vw,88px)] leading-[0.95] tracking-[-0.035em]">Čo je dnes<br>na obed?</h1>
      </div>
      <div class="flex-[0_1_400px] grid grid-cols-3 gap-2.5">
        ${statTile(String(items.length), plural(items.length, 'jedlo', 'jedlá', 'jedál'))}
        ${statTile(String(sourceCount), plural(sourceCount, 'reštaurácia', 'reštaurácie', 'reštaurácií'))}
        ${statTile(cheapestMainPrice(items), 'najlacnejšie')}
      </div>
    </section>

    <nav aria-label="Lokality" class="flex flex-wrap items-center gap-2 pt-3.5 pb-7 border-t border-line">
      ${tabs}
      <span class="ml-auto text-sm text-muted">${escapeHtml(updatedLabel)}</span>
    </nav>

    <main>
      ${error ? notice('Menu sa nepodarilo načítať', error) : ''}
      ${!error && items.length === 0 ? notice('Zatiaľ tu nie je menu', 'V databáze nie sú položky pre dnešný deň.') : ''}
      ${!error ? content : ''}
    </main>

    <footer class="flex flex-wrap justify-between gap-2 py-6 pb-10 border-t border-line text-[13px] text-muted">
      <span>${escapeHtml(SITE_TITLE)}</span>
      <span>n8n · PostgreSQL · Docker · Raspberry Pi</span>
    </footer>
  </div>

  <div id="login-modal" class="fixed inset-0 z-50 hidden items-center justify-center bg-black/60 p-4">
    <div role="dialog" aria-modal="true" aria-label="Prihlásenie" class="w-full max-w-md bg-surface text-ink border border-line rounded-3xl shadow-2xl p-6 relative">
      <button id="login-close" type="button" aria-label="Zavrieť" class="absolute top-4 right-4 grid place-items-center w-10 h-10 rounded-full bg-ground text-muted hover:text-ink cursor-pointer border-0">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>

      <div class="flex gap-2 mb-5">
        <button type="button" class="${paneBtnClass}" data-pane="login" aria-pressed="true">Prihlásenie</button>
        <button type="button" class="${paneBtnClass}" data-pane="register" aria-pressed="false">Registrácia</button>
      </div>

      <form id="pane-login" method="post" action="/admin/login" class="grid gap-3">
        <label class="block"><span class="${labelClass}">E-mail</span><input type="email" name="email" required autocomplete="username" class="${inputClass}"></label>
        <label class="block"><span class="${labelClass}">Heslo</span><input type="password" name="password" required autocomplete="current-password" class="${inputClass}"></label>
        <button type="submit" class="mt-1 w-full px-4 py-3 bg-ink text-ground font-bold rounded-xl cursor-pointer border-0 hover:opacity-90">Prihlásiť</button>
        <a href="/admin?view=reset" class="text-sm font-semibold text-muted hover:text-ink no-underline justify-self-start">Zabudnuté heslo?</a>
      </form>

      <form id="pane-register" method="post" action="/admin/register" class="hidden grid gap-3">
        <p class="m-0 text-sm text-muted">Nový účet musí schváliť admin. Úplne prvý zaregistrovaný účet sa stáva adminom.</p>
        <label class="block"><span class="${labelClass}">E-mail</span><input type="email" name="email" required autocomplete="username" class="${inputClass}"></label>
        <label class="block"><span class="${labelClass}">Heslo (min. 8 znakov)</span><input type="password" name="password" required minlength="8" autocomplete="new-password" class="${inputClass}"></label>
        <label class="block"><span class="${labelClass}">Heslo znova</span><input type="password" name="password_confirm" required minlength="8" autocomplete="new-password" class="${inputClass}"></label>
        <button type="submit" class="mt-1 w-full px-4 py-3 bg-ink text-ground font-bold rounded-xl cursor-pointer border-0 hover:opacity-90">Registrovať</button>
      </form>
    </div>
  </div>

  <script>
    document.querySelectorAll('.restaurant-toggle').forEach((button) => {
      button.addEventListener('click', () => {
        const expanded = button.closest('.restaurant-card').classList.toggle('expanded');
        button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      });
    });

    const locationTabs = document.querySelectorAll('.location-tab');
    locationTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const location = tab.dataset.location;
        locationTabs.forEach((t) => t.setAttribute('aria-pressed', t === tab ? 'true' : 'false'));
        document.querySelectorAll('.location-section').forEach((section) => {
          section.hidden = location !== 'all' && section.dataset.location !== location;
        });
      });
    });

    document.getElementById('theme-toggle').addEventListener('click', () => {
      const dark = document.documentElement.classList.toggle('dark');
      try { localStorage.setItem('lunch_theme', dark ? 'dark' : 'light'); } catch {}
    });

    const loginModal = document.getElementById('login-modal');
    function setModalOpen(open) {
      loginModal.classList.toggle('hidden', !open);
      loginModal.classList.toggle('flex', open);
      if (open) loginModal.querySelector('#pane-login input[name="email"]').focus();
    }
    function setPane(name) {
      document.getElementById('pane-login').classList.toggle('hidden', name !== 'login');
      document.getElementById('pane-register').classList.toggle('hidden', name !== 'register');
      document.querySelectorAll('.auth-pane-btn').forEach((btn) => btn.setAttribute('aria-pressed', btn.dataset.pane === name ? 'true' : 'false'));
    }
    document.getElementById('login-open').addEventListener('click', () => setModalOpen(true));
    document.getElementById('login-close').addEventListener('click', () => setModalOpen(false));
    loginModal.addEventListener('click', (event) => { if (event.target === loginModal) setModalOpen(false); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setModalOpen(false); });
    document.querySelectorAll('.auth-pane-btn').forEach((btn) => btn.addEventListener('click', () => setPane(btn.dataset.pane)));
  </script>
</body>
</html>`;
}

function renderAuthPage({ view = 'login', error = '', notice = '' } = {}) {
  const authInput = 'mt-1 w-full border border-gray-300 rounded-xl px-4 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-gray-900';
  const authLabel = 'block text-xs font-bold text-gray-500 uppercase tracking-wide';

  const loginView = `
    <div class="bg-white border border-gray-200 rounded-3xl shadow-lg p-6">
      <h1 class="m-0 text-3xl font-black tracking-tight">Admin menu</h1>
      <p class="mt-1 mb-5 text-sm text-gray-500">Prihlás sa e-mailom a heslom.</p>

      <form method="post" action="/admin/login" class="grid gap-3">
        <label class="block"><span class="${authLabel}">E-mail</span><input type="email" name="email" required autocomplete="username" autofocus class="${authInput}"></label>
        <label class="block"><span class="${authLabel}">Heslo</span><input type="password" name="password" required autocomplete="current-password" class="${authInput}"></label>
        <button type="submit" class="mt-1 w-full px-4 py-3 bg-gray-900 hover:bg-gray-800 text-white font-black rounded-xl cursor-pointer border-0">Prihlásiť</button>
      </form>

      <div class="flex justify-between mt-4 text-sm">
        <a href="/admin?view=reset" class="font-bold text-gray-500 hover:text-gray-900 no-underline">Zabudnuté heslo?</a>
        <a href="/" class="font-bold text-gray-500 hover:text-gray-900 no-underline">← Späť na menu</a>
      </div>
    </div>`;

  const resetView = `
    <div class="bg-white border border-gray-200 rounded-3xl shadow-lg p-6">
      <h1 class="m-0 text-2xl font-black tracking-tight">Obnovenie hesla</h1>
      <p class="mt-1 mb-5 text-sm text-gray-500">Pošleme ti jednorazový kód platný ${RESET_CODE_TTL_MINUTES} minút.</p>

      <form method="post" action="/admin/reset/request" class="grid gap-3">
        <label class="block"><span class="${authLabel}">E-mail</span><input type="email" name="email" required autocomplete="username" autofocus class="${authInput}"></label>
        <button type="submit" class="mt-1 w-full px-4 py-3 bg-gray-900 hover:bg-gray-800 text-white font-black rounded-xl cursor-pointer border-0">Poslať kód</button>
      </form>
    </div>

    <div class="bg-white border border-gray-200 rounded-3xl shadow-lg p-6 mt-4">
      <h2 class="m-0 text-lg font-black tracking-tight">Už máš kód?</h2>
      <p class="mt-1 mb-4 text-sm text-gray-500">Zadaj kód z e-mailu a nové heslo.</p>
      <form method="post" action="/admin/reset/confirm" class="grid gap-3">
        <label class="block"><span class="${authLabel}">E-mail</span><input type="email" name="email" required autocomplete="username" class="${authInput}"></label>
        <label class="block"><span class="${authLabel}">Kód z e-mailu</span><input name="code" required inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="123456" class="${authInput}"></label>
        <label class="block"><span class="${authLabel}">Nové heslo (min. 8 znakov)</span><input type="password" name="password" required minlength="8" autocomplete="new-password" class="${authInput}"></label>
        <label class="block"><span class="${authLabel}">Nové heslo znova</span><input type="password" name="password_confirm" required minlength="8" autocomplete="new-password" class="${authInput}"></label>
        <button type="submit" class="mt-1 w-full px-4 py-3 bg-green-600 hover:bg-green-700 text-white font-black rounded-xl cursor-pointer border-0">Zmeniť heslo</button>
      </form>
      <div class="mt-4 text-sm">
        <a href="/admin" class="font-bold text-gray-500 hover:text-gray-900 no-underline">← Späť na prihlásenie</a>
      </div>
    </div>`;

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
    ${error ? `<div class="mb-4 px-4 py-3 bg-red-50 border border-red-200 text-red-800 font-semibold rounded-xl text-sm">${escapeHtml(error)}</div>` : ''}
    ${notice ? `<div class="mb-4 px-4 py-3 bg-green-50 border border-green-200 text-green-800 font-semibold rounded-xl text-sm">${escapeHtml(notice)}</div>` : ''}
    ${view === 'reset' ? resetView : loginView}
  </main>
</body>
</html>`;
}

function renderAdminPage({ items, sources, locations, users = [], currentUser, menuDate, notice = '', error = '', activeTab = 'polozky' }) {
  const isAdminUser = currentUser.role === 'admin';
  // The 'user' role can only adjust location display weights
  const tabs = isAdminUser ? ['polozky', 'restauracie', 'lokality', 'pouzivatelia'] : ['lokality'];
  const tabLabels = { polozky: 'Položky', restauracie: 'Reštaurácie', lokality: 'Lokality', pouzivatelia: 'Používatelia' };
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
      ${isAdminUser ? `<td class="${tw.td}">
        <form method="post" action="/admin/locations/delete" onsubmit="return confirm('Naozaj zmazať lokalitu ${escapeHtml(loc.name)}?')">
          <input type="hidden" name="_tab" value="lokality">
          <input type="hidden" name="name" value="${escapeHtml(loc.name)}">
          <button type="submit" class="${tw.btnRed}">Zmazať</button>
        </form>
      </td>` : ''}
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
        <p class="text-gray-500 mt-1 text-sm">${isAdminUser ? 'Správa položiek, reštaurácií a lokalít.' : 'Úprava poradia lokalít na hlavnej stránke.'}</p>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <span class="px-3 py-2 bg-white border border-gray-200 rounded-full text-sm text-gray-600">${escapeHtml(currentUser.email)} <span class="ml-1 px-2 py-0.5 rounded-full text-xs font-bold ${isAdminUser ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}">${isAdminUser ? 'admin' : 'user'}</span></span>
        <a href="/" class="${tw.btnGray} no-underline">Web</a>
        <a href="/admin/logout" class="${tw.btnGray} no-underline">Odhlásiť</a>
      </div>
    </div>

    ${notice ? `<div class="mb-4 px-4 py-3 bg-green-50 border border-green-200 text-green-800 font-semibold rounded-xl text-sm">${escapeHtml(notice)}</div>` : ''}
    ${error ? `<div class="mb-4 px-4 py-3 bg-red-50 border border-red-200 text-red-800 font-semibold rounded-xl text-sm">${escapeHtml(error)}</div>` : ''}

    ${isAdminUser ? `
    <div class="bg-white border border-gray-200 rounded-2xl shadow-sm p-4 mb-4">
      <form class="flex items-end gap-3 flex-wrap" method="get" action="/admin">
        <label class="block"><span class="${tw.label}">Dátum</span><input type="date" name="date" value="${escapeHtml(menuDate)}" class="${tw.input}"></label>
        <button type="submit" class="${tw.btnGray}">Filtrovať</button>
      </form>
    </div>
    ` : ''}

    <div class="flex gap-2 mb-4 flex-wrap">
      ${tabs.map((t) => `<button class="tab-btn px-5 py-2 rounded-full text-sm font-bold border cursor-pointer" data-tab="${t}">${tabLabels[t]}</button>`).join('')}
    </div>

    ${isAdminUser ? `
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

    ` : ''}

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
                ${isAdminUser ? `<th class="${tw.th}">Akcie</th>` : ''}
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 bg-white">
              ${locationTableRows || `<tr><td colspan="${isAdminUser ? 3 : 2}" class="px-5 py-6 text-sm text-gray-400">Žiadne lokality.</td></tr>`}
            </tbody>
          </table>
        </div>
        ${isAdminUser ? `
        <div class="px-5 py-4 border-t border-gray-100 bg-gray-50">
          <form class="flex items-end gap-3 flex-wrap" method="post" action="/admin/locations/create">
            <input type="hidden" name="_tab" value="lokality">
            <label class="block"><span class="${tw.label}">Nová lokalita</span><input name="name" placeholder="napr. Centrum" class="${tw.input} w-44"></label>
            <label class="block"><span class="${tw.label}">Váha</span><input type="number" name="weight" value="100" min="0" max="9999" class="${tw.input} w-24"></label>
            <div class="flex items-end"><button type="submit" class="${tw.btnGreen}">Pridať lokalitu</button></div>
          </form>
        </div>
        ` : ''}
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
      if (!TABS.includes(name)) name = TABS[0];
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
      view: url.searchParams.get('view') || 'login',
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
    activeTab: url.searchParams.get('tab') || (user.role === 'admin' ? 'polozky' : 'lokality'),
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

  if (url.pathname === '/admin/reset/request') {
    const form = await readForm(req);
    try {
      await requestPasswordReset(form);
      return redirect(res, `/admin?view=reset&notice=${encodeURIComponent('Ak účet existuje, poslali sme kód na zadaný e-mail.')}`);
    } catch (err) {
      console.error('Password reset request failed:', err);
      const message = err.message.startsWith('Zadaj') ? err.message : 'Kód sa nepodarilo odoslať. Skús to neskôr.';
      return redirect(res, `/admin?view=reset&error=${encodeURIComponent(message)}`);
    }
  }

  if (url.pathname === '/admin/reset/confirm') {
    const form = await readForm(req);
    try {
      await confirmPasswordReset(form);
      return redirect(res, `/admin?notice=${encodeURIComponent('Heslo bolo zmenené. Prihlás sa novým heslom.')}`);
    } catch (err) {
      return redirect(res, `/admin?view=reset&error=${encodeURIComponent(err.message)}`);
    }
  }

  const user = await getSessionUser(req);
  if (!user) return redirect(res, `/admin?error=${encodeURIComponent('Neautorizovaný prístup')}`);

  const form = await readForm(req);
  const menuDate = clean(form.menu_date, todayIso());
  const tab = clean(form._tab, 'polozky');
  try {
    // The 'user' role may only adjust location weights
    if (user.role !== 'admin' && url.pathname !== '/admin/locations/update') {
      throw new Error('Na túto akciu potrebuješ rolu admin.');
    }

    if (url.pathname === '/admin/users/approve' || url.pathname === '/admin/users/delete') {
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
