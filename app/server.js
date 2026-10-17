const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { requireEnv, createPool } = require('./db');

const scryptAsync = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT || 3000);
const SITE_TITLE = process.env.SITE_TITLE || 'Obedové menu';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_TTL_DAYS = 30;
const RESET_CODE_TTL_MINUTES = 15;
const SMTP_HOST = requireEnv('SMTP_HOST');
const SMTP_PORT = Number(process.env.SMTP_PORT || 25);
const SMTP_FROM = requireEnv('SMTP_FROM');
const CATEGORIES = ['soup', 'main', 'special', 'pizza', 'side', 'dessert', 'drink', 'unknown'];
// Optional: n8n "test zdroja" webhook behind the admin's "Otestovať" button
const N8N_TEST_WEBHOOK_URL = process.env.N8N_TEST_WEBHOOK_URL || '';
const N8N_TEST_WEBHOOK_TOKEN = process.env.N8N_TEST_WEBHOOK_TOKEN || '';

// Parser registry shared with the n8n parser workflow (its Switch routes on these keys)
const PARSERS = {
  ai_extract: { label: 'AI extrakcia (odporúčané)', sourceType: 'html_daily_menu_page', hint: 'Ľubovoľný web reštaurácie, aj menu v PDF alebo na obrázku: Claude z neho vytiahne denné menu. Účtuje sa podľa použitia (rádovo centy za deň), over ho testom.' },
  sme_restauracie: { label: 'SME Reštaurácie', sourceType: 'html_daily_menu_page', hint: 'URL „Denné menu“ na restauracie.sme.sk. Pozor: SME chráni stránky captchou a automatické čítanie často zablokuje.' },
  woocommerce_category: { label: 'WooCommerce kategória', sourceType: 'html_woocommerce_category', hint: 'Kategória „denné menu“ v e-shope na WooCommerce (ako BelaVery). Jedlá v tvare „01 – Názov … 7,90 €“.' },
  amelia: { label: 'Ostravárna Amélia', sourceType: 'html_daily_menu_page', hint: 'Iba pre web ameliarestaurant.sk.' },
  zark_pdf: { label: 'ZARK týždenné PDF', sourceType: 'pdf_weekly_menu', hint: 'Iba pre ZARK. PDF sa hľadá na stránke z „discoveryUrl“ a kontroluje sa, či je z aktuálneho týždňa.' },
  manual: { label: 'Ručne v admine', sourceType: 'manual', hint: 'Bez automatického importu, jedlá zadávaš v záložke Položky.' },
};

const pool = createPool({ max: 5 });

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
// Content hash in the stylesheet URL: a new build gets a new URL, so the long cache is safe
const TAILWIND_URL = `/tailwind.css?v=${crypto.createHash('sha1').update(tailwindCss).digest('hex').slice(0, 10)}`;

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

// Calendar dates (YYYY-MM-DD) are handled as UTC midnight so day arithmetic ignores DST
function parseIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d;
}

function shiftIsoDate(value, days) {
  const d = parseIsoDate(value);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  return Math.round((parseIsoDate(toIso) - parseIsoDate(fromIso)) / 86400000);
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

// The session is site-wide (the public page is personalized). Each call also expires the
// cookie older versions scoped to Path=/admin, so it can't shadow the current one.
function sessionCookies(token, maxAgeSeconds = SESSION_TTL_DAYS * 86400) {
  return [
    `lunch_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`,
    'lunch_session=; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=0',
  ];
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
    SELECT u.id, u.email, u.role, u.is_approved, u.default_location, u.page_layout
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

// userId is null for anonymous visitors: personal joins then match nothing and the
// global order applies. Logged-in users get their own location order and favorites first.
async function queryMenu(menuDate, userId = null) {
  const menu = await pool.query(`
      SELECT
        m.source_id,
        m.source_name,
        m.source_url,
        s.source_location,
        m.menu_date,
        m.menu_code,
        m.category,
        m.title,
        m.description,
        m.price_eur,
        m.currency,
        m.allergens,
        m.parsed_at,
        (fav.source_id IS NOT NULL) AS is_favorite
      FROM public.lunch_menu_items m
      LEFT JOIN public.lunch_sources s ON s.source_id = m.source_id
      LEFT JOIN public.lunch_locations loc ON loc.name = s.source_location
      LEFT JOIN public.lunch_user_location_weights ulw ON ulw.location_name = s.source_location AND ulw.user_id = $1
      LEFT JOIN public.lunch_user_favorites fav ON fav.source_id = m.source_id AND fav.user_id = $1
      WHERE m.menu_date = $2::date
        AND m.is_available = TRUE
      ORDER BY
        COALESCE(ulw.weight, loc.weight, 999),
        s.source_location,
        (fav.source_id IS NULL),
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
  `, [userId, menuDate]);

  const meta = await pool.query(`
    SELECT MAX(created_at) AS last_updated_at
    FROM public.lunch_menu_items
    WHERE menu_date = $1::date
      AND is_available = TRUE
  `, [menuDate]);

  // Every enabled restaurant, so ones without a menu that day still show (as closed).
  // Same order as the menu: location, then open before closed, favorites first.
  const sources = await pool.query(`
    SELECT
      s.source_id,
      s.source_name,
      s.source_location,
      s.source_url,
      (fav.source_id IS NOT NULL) AS is_favorite,
      EXISTS (
        SELECT 1 FROM public.lunch_menu_items m
        WHERE m.source_id = s.source_id AND m.menu_date = $2::date AND m.is_available = TRUE
      ) AS has_menu
    FROM public.lunch_sources s
    LEFT JOIN public.lunch_locations loc ON loc.name = s.source_location
    LEFT JOIN public.lunch_user_location_weights ulw ON ulw.location_name = s.source_location AND ulw.user_id = $1
    LEFT JOIN public.lunch_user_favorites fav ON fav.source_id = s.source_id AND fav.user_id = $1
    WHERE s.enabled
       OR EXISTS (SELECT 1 FROM public.lunch_menu_items m WHERE m.source_id = s.source_id AND m.menu_date = $2::date AND m.is_available = TRUE)
    ORDER BY COALESCE(ulw.weight, loc.weight, 999), s.source_location, has_menu DESC, (fav.source_id IS NULL), s.source_name
  `, [userId, menuDate]);

  return { items: menu.rows, sources: sources.rows, lastUpdatedAt: meta.rows[0]?.last_updated_at || null };
}

// All locations in the user's effective order (personal weight, else global)
async function queryUserLocations(userId) {
  const result = await pool.query(`
    SELECT l.name
    FROM public.lunch_locations l
    LEFT JOIN public.lunch_user_location_weights ulw ON ulw.location_name = l.name AND ulw.user_id = $1
    ORDER BY COALESCE(ulw.weight, l.weight), l.name
  `, [userId]);
  return result.rows.map((r) => r.name);
}

async function toggleFavorite(userId, sourceId) {
  const removed = await pool.query(`DELETE FROM public.lunch_user_favorites WHERE user_id = $1 AND source_id = $2`, [userId, sourceId]);
  if (removed.rowCount) return false;
  try {
    await pool.query(`INSERT INTO public.lunch_user_favorites (user_id, source_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, sourceId]);
  } catch (err) {
    if (err.code === '23503') throw new Error('Neznáma reštaurácia.');
    throw err;
  }
  return true;
}

async function savePreferences(userId, params) {
  const globalOrder = (await pool.query(`SELECT name FROM public.lunch_locations ORDER BY weight, name`)).rows.map((r) => r.name);
  const known = new Set(globalOrder);

  const defaultLocation = clean(params.get('default_location'));
  if (defaultLocation && !known.has(defaultLocation)) throw new Error('Neznáma lokalita.');

  const order = [...new Set(params.getAll('order').map((name) => clean(name)))].filter((name) => known.has(name));
  // Matching the global order (or an explicit reset) means "follow the admin's order"
  const followGlobal = params.get('action') === 'reset_order' || order.join('\n') === globalOrder.join('\n');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE public.lunch_users SET default_location = $2, updated_at = NOW() WHERE id = $1`, [userId, defaultLocation || null]);
    await client.query(`DELETE FROM public.lunch_user_location_weights WHERE user_id = $1`, [userId]);
    if (!followGlobal) {
      for (const [index, name] of order.entries()) {
        await client.query(`
          INSERT INTO public.lunch_user_location_weights (user_id, location_name, weight) VALUES ($1, $2, $3)
        `, [userId, name, (index + 1) * 10]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
      s.source_id,
      s.source_name,
      s.source_type,
      s.source_url,
      s.source_location,
      s.enabled,
      COALESCE(s.parser_name, 'manual') AS parser_name,
      s.parser_config,
      s.has_weekend_menu,
      (SELECT COUNT(*) FROM public.lunch_menu_items m WHERE m.source_id = s.source_id AND m.menu_date = $1::date AND m.is_available)::int AS items_on_date,
      (SELECT MAX(m.menu_date)::text FROM public.lunch_menu_items m WHERE m.source_id = s.source_id) AS last_menu_date
    FROM public.lunch_sources s
    ORDER BY s.enabled DESC, s.source_location, s.source_name
  `, [menuDate]);

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

// "Ostravárna Amélia" -> "ostravarna-amelia"
function slugify(value) {
  return clean(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// Validated restaurant fields from an admin form (shared by create, update and test)
async function restaurantFromForm(form) {
  const name = clean(form.source_name);
  if (!name) throw new Error('Názov reštaurácie je povinný.');
  const parser = clean(form.parser_name, 'manual');
  if (!PARSERS[parser]) throw new Error('Neznámy typ parsera.');
  const url = clean(form.source_url);
  if (parser !== 'manual' && !/^https?:\/\/\S+$/i.test(url)) throw new Error('Zadaj URL stránky s menu (začína http:// alebo https://).');
  const location = clean(form.source_location);
  const known = await pool.query(`SELECT 1 FROM public.lunch_locations WHERE name = $1`, [location]);
  if (!known.rowCount) throw new Error('Vyber existujúcu lokalitu.');
  let parserConfig = {};
  const rawConfig = clean(form.parser_config);
  if (rawConfig) {
    try { parserConfig = JSON.parse(rawConfig); } catch { throw new Error('Pokročilé nastavenia musia byť platný JSON.'); }
    if (!parserConfig || typeof parserConfig !== 'object' || Array.isArray(parserConfig)) throw new Error('Pokročilé nastavenia musia byť JSON objekt, napr. {}.');
  }
  return {
    name,
    parser,
    sourceType: PARSERS[parser].sourceType,
    url,
    location,
    parserConfig,
    hasWeekendMenu: form.has_weekend_menu === 'on',
    enabled: form.enabled === 'on',
  };
}

async function createRestaurant(form) {
  const r = await restaurantFromForm(form);
  let id = slugify(form.source_id || r.name);
  if (!id) throw new Error('Z názvu sa nedá vytvoriť ID, zadaj ho ručne (písmená a čísla).');
  const taken = new Set((await pool.query(`SELECT source_id FROM public.lunch_sources WHERE source_id LIKE $1`, [`${id}%`])).rows.map((row) => row.source_id));
  for (let n = 2; taken.has(id); n += 1) id = `${slugify(form.source_id || r.name).slice(0, 36)}-${n}`;
  await pool.query(`
    INSERT INTO public.lunch_sources
      (source_id, source_name, restaurant_name, source_type, source_url, source_location, parser_name, parser_config, has_weekend_menu, enabled, city)
    VALUES ($1, $2, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'Bratislava')
  `, [id, r.name, r.sourceType, r.url, r.location, r.parser, JSON.stringify(r.parserConfig), r.hasWeekendMenu, r.enabled]);
  return id;
}

async function updateRestaurant(form) {
  const r = await restaurantFromForm(form);
  const updated = await pool.query(`
    UPDATE public.lunch_sources
    SET source_name = $2, restaurant_name = $2, source_type = $3, source_url = $4, source_location = $5,
        parser_name = $6, parser_config = $7::jsonb, has_weekend_menu = $8, enabled = $9, updated_at = NOW()
    WHERE source_id = $1
  `, [clean(form.source_id), r.name, r.sourceType, r.url, r.location, r.parser, JSON.stringify(r.parserConfig), r.hasWeekendMenu, r.enabled]);
  if (!updated.rowCount) throw new Error('Reštaurácia neexistuje.');
}

// Runs the restaurant's parser through the n8n test webhook without writing anything to the DB
async function testRestaurant(form) {
  if (!N8N_TEST_WEBHOOK_URL) throw new Error('Test nie je nastavený: chýba premenná N8N_TEST_WEBHOOK_URL.');
  const r = await restaurantFromForm(form);
  if (r.parser === 'manual') throw new Error('Ručne zadávaná reštaurácia nemá čo testovať.');
  const menuDate = parseIsoDate(form.menu_date) ? form.menu_date : todayIso();
  let res;
  try {
    res = await fetch(N8N_TEST_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(N8N_TEST_WEBHOOK_TOKEN ? { 'x-menu-token': N8N_TEST_WEBHOOK_TOKEN } : {}) },
      body: JSON.stringify({
        source_id: clean(form.source_id) || slugify(r.name) || 'test',
        source_name: r.name,
        source_type: r.sourceType,
        source_url: r.url,
        parser_name: r.parser,
        parser_config: r.parserConfig,
        has_weekend_menu: r.hasWeekendMenu,
        menu_date: menuDate,
      }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    throw new Error(`n8n neodpovedá (${err.name === 'TimeoutError' ? 'vypršal čas' : err.message}).`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`n8n vrátilo neplatnú odpoveď (HTTP ${res.status}).`); }
  if (!res.ok && !data.errorMessage) throw new Error(`n8n vrátilo HTTP ${res.status}.`);
  return { ...data, menuDate };
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

async function setPageLayout(userId, form) {
  const layout = clean(form.page_layout);
  if (!['listok', 'palcom'].includes(layout)) throw new Error('Neznámy vzhľad.');
  await pool.query(`UPDATE public.lunch_users SET page_layout = $2, updated_at = NOW() WHERE id = $1`, [userId, layout]);
}

async function deleteLocation(form) {
  const name = clean(form.name);
  if (!name) throw new Error('Názov lokality je povinný.');
  await pool.query(`DELETE FROM public.lunch_locations WHERE name = $1`, [name]);
}

function plural(n, one, few, many) {
  if (n === 1) return one;
  return n >= 2 && n <= 4 ? few : many;
}

const capitalize = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const DATE_OPTS = { timeZone: 'Europe/Bratislava' };

// "Pondelok · 19. 10. 2026"
function formatHeroDate(value = new Date()) {
  const weekday = new Intl.DateTimeFormat('sk-SK', { ...DATE_OPTS, weekday: 'long' }).format(value);
  const date = new Intl.DateTimeFormat('sk-SK', { ...DATE_OPTS, day: '2-digit', month: '2-digit', year: 'numeric' }).format(value);
  return `${capitalize(weekday)} · ${date}`;
}

// "Po 19. 10."
function formatShortDate(value) {
  const weekday = new Intl.DateTimeFormat('sk-SK', { ...DATE_OPTS, weekday: 'short' }).format(value);
  const date = new Intl.DateTimeFormat('sk-SK', { ...DATE_OPTS, day: 'numeric', month: 'numeric' }).format(value);
  return `${capitalize(weekday)} ${date}`;
}

// Cheapest main course (falls back to any dish) with its restaurant
function cheapestMain(items) {
  const priced = (categories) => items
    .filter((item) => !categories || categories.includes(item.category))
    .filter((item) => Number(item.price_eur) > 0);
  const pool = priced(['main', 'special', 'pizza']).length ? priced(['main', 'special', 'pizza']) : priced(null);
  if (!pool.length) return null;
  const best = pool.reduce((a, b) => (Number(b.price_eur) < Number(a.price_eur) ? b : a));
  return { price: euro(best.price_eur), source: best.source_name };
}

// Short marker shown in front of a dish: the restaurant's own code, else P for soup / category initial
function dishCode(item) {
  const code = clean(item.menu_code);
  if (code) return code;
  return item.category === 'soup' ? 'P' : categoryLabel(item.category || 'unknown').charAt(0);
}

const ARROW_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg>';
const STAR_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/></svg>';
const CHEVRON_SVG = (d) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const PREV_PATH = 'm15 18-6-6 6-6';
const NEXT_PATH = 'm9 18 6-6-6-6';

const PAGE_LAYOUTS = {
  listok: {
    fonts: 'family=Archivo:wdth,wght@75..125,500..800&family=Atkinson+Hyperlegible:wght@400;700',
  },
  palcom: {
    fonts: 'family=Familjen+Grotesk:wght@500..700&family=Nunito+Sans:opsz,wght@6..12,400..800',
  },
};

// Everything both layouts share: data shaping, header controls, modals and page script.
// auth: { pane, error, notice } opens the login modal on load (after a failed login, registration, …)
// user / userLocations / flash are only set for logged-in visitors
function renderPublicPage(items, { sources = [], menuDate = todayIso(), error = null, lastUpdatedAt = null, user = null, userLocations = [], auth = null, flash = null } = {}) {
  const layout = user?.page_layout === 'palcom' ? 'palcom' : 'listok';
  const todayDate = todayIso();
  const dayOffset = daysBetween(todayDate, menuDate);
  const updatedAt = formatTime(lastUpdatedAt);

  // Restaurants in DB order (location weight, open before closed, favorites first), each with
  // that day's dishes; a restaurant without dishes is shown as closed
  const dishesBySource = new Map();
  for (const item of items) {
    if (!dishesBySource.has(item.source_id)) dishesBySource.set(item.source_id, []);
    dishesBySource.get(item.source_id).push(item);
  }
  const restaurants = sources.map((s) => ({
    sourceId: s.source_id,
    name: s.source_name || 'Neznámy zdroj',
    location: s.source_location,
    url: s.source_url,
    favorite: Boolean(s.is_favorite),
    dishes: dishesBySource.get(s.source_id) || [],
  }));
  const openCount = restaurants.filter((r) => r.dishes.length).length;
  const locations = [...new Set(restaurants.map((r) => r.location))];
  const locationCount = (location) => restaurants.filter((r) => r.location === location).reduce((sum, r) => sum + r.dishes.length, 0);
  // Pre-select the user's default location server-side, so there is no flash of "all"
  const activeLocation = user?.default_location && locations.length > 1 && locations.includes(user.default_location) ? user.default_location : 'all';
  const hiddenAttr = (location) => (activeLocation !== 'all' && activeLocation !== location ? 'hidden' : '');

  const ctx = {
    items, user, menuDate, todayDate, dayOffset, error, flash, restaurants, openCount, locations, locationCount, activeLocation, hiddenAttr,
    dateHref: (iso) => (iso === todayDate ? '/' : `/?date=${iso}`),
    updatedLabel: updatedAt === '—' ? 'Zatiaľ bez aktualizácie' : `Aktualizované o ${updatedAt}`,
    emptyText: dayOffset === 0 ? 'V databáze nie sú položky pre dnešný deň.' : 'Pre tento deň nie sú v databáze žiadne položky.',
    favButton: (r, cls) => (user ? `
      <form class="fav-form" method="post" action="/me/favorites/toggle">
        <input type="hidden" name="source_id" value="${escapeHtml(r.sourceId)}">
        <button type="submit" class="fav-btn ${cls}" aria-pressed="${r.favorite}" aria-label="${r.favorite ? 'Odobrať z obľúbených' : 'Pridať do obľúbených'}">${STAR_SVG}</button>
      </form>` : ''),
    themeButton: (cls) => `
      <button id="theme-toggle" type="button" aria-label="Prepnúť tmavý režim" class="${cls}">
        <svg class="dark:hidden" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
        <svg class="hidden dark:block" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      </button>`,
    initial: user ? escapeHtml(user.email.charAt(0).toUpperCase()) : '',
    message: (kind, text) => (text ? `<div class="mb-4 px-4 py-3 rounded-xl text-sm font-semibold border ${kind === 'error' ? 'bg-red-50 border-red-200 text-red-800 dark:bg-red-950 dark:border-red-900 dark:text-red-200' : 'bg-green-50 border-green-200 text-green-800 dark:bg-green-950 dark:border-green-900 dark:text-green-200'}">${escapeHtml(text)}</div>` : ''),
  };

  const body = layout === 'palcom' ? renderPalcomLayout(ctx) : renderListokLayout(ctx);

  return `<!doctype html>
<html lang="sk" class="layout-${layout}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>${escapeHtml(SITE_TITLE)}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?${PAGE_LAYOUTS[layout].fonts}&display=swap">
  <link rel="stylesheet" href="${TAILWIND_URL}">
  <script>
    (function () {
      let saved = null;
      try { saved = localStorage.getItem('lunch_theme'); } catch {}
      if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
      }
    })();
  </script>
</head>
<body class="font-body antialiased">
${body}
${renderLoginModal(user, auth, ctx.message)}${renderPrefsModal(user, userLocations, menuDate)}
  <script>
    document.getElementById('theme-toggle').addEventListener('click', () => {
      const dark = document.documentElement.classList.toggle('dark');
      try { localStorage.setItem('lunch_theme', dark ? 'dark' : 'light'); } catch {}
    });

    // Location filter: buttons carry data-location, filtered blocks carry data-loc-item
    const locButtons = document.querySelectorAll('.loc-filter');
    locButtons.forEach((button) => button.addEventListener('click', () => {
      const location = button.dataset.location;
      locButtons.forEach((b) => b.setAttribute('aria-pressed', b === button ? 'true' : 'false'));
      document.querySelectorAll('[data-loc-item]').forEach((el) => {
        el.hidden = location !== 'all' && el.dataset.location !== location;
      });
    }));

    // Collapsible restaurants (Palcom layout)
    document.querySelectorAll('.acc-toggle').forEach((button) => button.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      document.getElementById(button.getAttribute('aria-controls')).hidden = !open;
    }));

    // Shared modal wiring for the login and "Môj výber" dialogs
    const modals = [];
    function bindModal(modalId, openId, closeId, focusSelector) {
      const modal = document.getElementById(modalId);
      if (!modal) return;
      const setOpen = (open) => {
        modal.classList.toggle('hidden', !open);
        modal.classList.toggle('flex', open);
        if (open) modal.querySelector(focusSelector)?.focus();
      };
      modals.push(setOpen);
      document.getElementById(openId)?.addEventListener('click', () => setOpen(true));
      document.getElementById(closeId)?.addEventListener('click', () => setOpen(false));
      modal.addEventListener('click', (event) => { if (event.target === modal) setOpen(false); });
    }
    bindModal('login-modal', 'login-open', 'login-close', 'form:not(.hidden) input[name="email"]');
    bindModal('prefs-modal', 'prefs-open', 'prefs-close', 'select');
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') modals.forEach((setOpen) => setOpen(false)); });

    function setPane(name) {
      document.getElementById('pane-login').classList.toggle('hidden', name !== 'login');
      document.getElementById('pane-register').classList.toggle('hidden', name !== 'register');
      document.querySelectorAll('.auth-pane-btn').forEach((btn) => btn.setAttribute('aria-pressed', btn.dataset.pane === name ? 'true' : 'false'));
    }
    document.querySelectorAll('.auth-pane-btn').forEach((btn) => btn.addEventListener('click', () => setPane(btn.dataset.pane)));

    // Drop one-off ?auth=… / ?saved=… params so a reload doesn't show the message again; keep ?date
    const params = new URLSearchParams(location.search);
    ['auth', 'auth_error', 'auth_notice', 'saved', 'error'].forEach((name) => params.delete(name));
    history.replaceState(null, '', location.pathname + (params.size ? '?' + params : ''));

    const dateInput = document.getElementById('date-input');
    if (dateInput) {
      // Desktop browsers only open the picker from the icon; open it on any click
      dateInput.addEventListener('click', () => { try { dateInput.showPicker(); } catch {} });
      dateInput.addEventListener('change', () => {
        if (dateInput.value) location.href = dateInput.value === ${JSON.stringify(todayDate)} ? '/' : '/?date=' + dateInput.value;
      });
    }

    // Favorites: toggle in place via fetch; fall back to a normal form post
    document.querySelectorAll('.fav-form').forEach((form) => {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('.fav-btn');
        try {
          const res = await fetch(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)), headers: { accept: 'application/json' } });
          if (!res.ok) throw new Error(res.statusText);
          const { favorite } = await res.json();
          button.setAttribute('aria-pressed', favorite ? 'true' : 'false');
          button.setAttribute('aria-label', favorite ? 'Odobrať z obľúbených' : 'Pridať do obľúbených');
        } catch {
          form.submit();
        }
      });
    });

    // Location order: move items up/down; hidden inputs submit in DOM order
    const orderList = document.getElementById('order-list');
    function refreshMoveButtons() {
      const items = [...orderList.children];
      items.forEach((item, index) => {
        item.querySelector('[data-move="-1"]').disabled = index === 0;
        item.querySelector('[data-move="1"]').disabled = index === items.length - 1;
      });
    }
    if (orderList) {
      orderList.addEventListener('click', (event) => {
        const button = event.target.closest('.move-btn');
        if (!button) return;
        const item = button.closest('.order-item');
        if (button.dataset.move === '-1' && item.previousElementSibling) item.previousElementSibling.before(item);
        if (button.dataset.move === '1' && item.nextElementSibling) item.nextElementSibling.after(item);
        refreshMoveButtons();
        button.focus();
      });
      refreshMoveButtons();
    }
  </script>
</body>
</html>`;
}

// Layout A "Týždenný lístok": sticky week strip + location chips, dense printed-menu list
function renderListokLayout(ctx) {
  const { user, menuDate, todayDate, dayOffset, restaurants, locations, locationCount, activeLocation, hiddenAttr, dateHref } = ctx;
  const selected = parseIsoDate(menuDate);
  const monday = shiftIsoDate(menuDate, -((selected.getUTCDay() + 6) % 7));
  const weekdayShort = (iso) => new Intl.DateTimeFormat('sk-SK', { ...DATE_OPTS, weekday: 'short' }).format(parseIsoDate(iso));

  const week = [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const iso = shiftIsoDate(monday, i);
    const current = iso === menuDate;
    return `<a href="${dateHref(iso)}" class="l-day ${i >= 5 ? 'l-day-weekend' : ''}" ${current ? 'aria-current="date"' : ''} aria-label="${escapeHtml(formatHeroDate(parseIsoDate(iso)))}">
          <span>${iso === todayDate ? 'Dnes' : escapeHtml(weekdayShort(iso))}</span><strong>${parseIsoDate(iso).getUTCDate()}</strong></a>`;
  }).join('');

  const chips = locations.length > 1 ? `
      <div class="l-locs" role="group" aria-label="Lokalita">
        <button type="button" class="loc-filter l-loc" data-location="all" aria-pressed="${activeLocation === 'all'}">Všetko<small>${ctx.items.length}</small></button>
        ${locations.map((location) => `<button type="button" class="loc-filter l-loc" data-location="${escapeHtml(location)}" aria-pressed="${activeLocation === location}">${escapeHtml(location)}<small>${locationCount(location)}</small></button>`).join('')}
      </div>` : '';

  const relative = { 0: 'dnes', 1: 'zajtra', '-1': 'včera' }[dayOffset];
  const cheapest = cheapestMain(ctx.items);

  const list = restaurants.map((r) => `
    <section class="l-rest ${r.dishes.length ? '' : 'l-rest-closed'}" data-loc-item data-location="${escapeHtml(r.location)}" ${hiddenAttr(r.location)}>
      <div class="l-rest-head">
        <h2>${escapeHtml(r.name)}${r.favorite ? ' <span class="l-fav-tag">★ obľúbená</span>' : ''}</h2>
        ${r.url ? `<a class="l-where" href="${escapeHtml(r.url)}" target="_blank" rel="noreferrer" aria-label="Zdroj menu ${escapeHtml(r.name)}">${escapeHtml(r.location)} ${ARROW_SVG}</a>` : `<span class="l-where">${escapeHtml(r.location)}</span>`}
        ${ctx.favButton(r, 'l-star')}
      </div>
      <ul class="l-dishes">
        ${r.dishes.length ? '' : '<li class="l-dish"><span class="l-code">–</span><span class="l-name">Zatvorené<small>V tento deň bez obedového menu</small></span><span></span></li>'}
        ${r.dishes.map((d) => {
          const allergens = Array.isArray(d.allergens) ? d.allergens : [];
          const details = [d.description, allergens.length ? `Alergény ${allergens.join(', ')}` : ''].filter(Boolean).join(' · ');
          const price = Number(d.price_eur) > 0 ? Number(d.price_eur).toFixed(2).replace('.', ',') : '';
          return `<li class="l-dish">
          <span class="l-code" title="${escapeHtml(categoryLabel(d.category))}">${escapeHtml(dishCode(d))}</span>
          <span class="l-name">${escapeHtml(d.title)}${details ? `<small>${escapeHtml(details)}</small>` : ''}</span>
          <span class="l-price">${price ? `${price}<em>€</em>` : ''}</span>
        </li>`;
        }).join('')}
      </ul>
    </section>`).join('');

  return `
  <header class="l-top">
    <div class="l-wrap l-top-inner">
      <div class="l-bar">
        <span class="l-logo">${escapeHtml(SITE_TITLE)}</span>
        <div class="l-actions">
          ${ctx.themeButton('l-icon-btn')}
          ${user?.role === 'admin' ? '<a href="/admin" class="l-btn">Admin</a>' : ''}
          ${user
            ? `<button id="prefs-open" type="button" class="l-icon-btn l-avatar" aria-label="Môj výber (${escapeHtml(user.email)})">${ctx.initial}</button>`
            : '<button id="login-open" type="button" class="l-btn l-btn-primary">Prihlásiť</button>'}
        </div>
      </div>
      <nav class="l-week" aria-label="Deň v týždni">
        <a href="${dateHref(shiftIsoDate(menuDate, -7))}" class="l-arrow" aria-label="Predchádzajúci týždeň">${CHEVRON_SVG(PREV_PATH)}</a>
        ${week}
        <a href="${dateHref(shiftIsoDate(menuDate, 7))}" class="l-arrow" aria-label="Nasledujúci týždeň">${CHEVRON_SVG(NEXT_PATH)}</a>
      </nav>
      ${chips}
    </div>
  </header>

  <main class="l-wrap">
    ${ctx.flash ? `<div class="l-pad">${ctx.message(ctx.flash.kind, ctx.flash.text)}</div>` : ''}
    <div class="l-summary">
      <span><strong>${escapeHtml(formatHeroDate(selected))}</strong>${relative ? ` · ${relative}` : ''}</span>
      ${cheapest ? `<span>Najlacnejšie hlavné <strong>${escapeHtml(cheapest.price)} · ${escapeHtml(cheapest.source)}</strong></span>` : ''}
    </div>
    ${ctx.error ? `<p class="l-empty"><strong>Menu sa nepodarilo načítať.</strong> ${escapeHtml(ctx.error)}</p>` : ''}
    ${!ctx.error && !ctx.openCount ? `<p class="l-empty"><strong>Zatiaľ tu nie je menu.</strong> ${escapeHtml(ctx.emptyText)}</p>` : ''}
    ${!ctx.error ? list : ''}
    <p class="l-foot">${escapeHtml(ctx.updatedLabel)} · ${escapeHtml(SITE_TITLE)}</p>
  </main>`;
}

// Layout B "Palcom": favorites as swipe cards, collapsed restaurants, date dock at the bottom
function renderPalcomLayout(ctx) {
  const { user, menuDate, dayOffset, restaurants, locations, activeLocation, hiddenAttr, dateHref } = ctx;
  const selected = parseIsoDate(menuDate);
  const heading = { 0: 'Čo je dnes na obed?', 1: 'Čo bude zajtra na obed?', '-1': 'Čo bolo včera na obed?' }[dayOffset]
    || (dayOffset > 0 ? 'Čo bude na obed?' : 'Čo bolo na obed?');
  const dockLabel = { 0: 'Dnes', 1: 'Zajtra', '-1': 'Včera' }[dayOffset]
    || capitalize(new Intl.DateTimeFormat('sk-SK', { ...DATE_OPTS, weekday: 'long' }).format(selected));
  const priceOf = (d) => (Number(d.price_eur) > 0 ? euro(d.price_eur) : '');
  const badge = (d) => (d.category === 'soup' ? 'Polievka' : clean(d.menu_code) || categoryLabel(d.category || 'unknown'));

  const segs = locations.length > 1 ? `
      <div class="p-segs" role="group" aria-label="Lokalita">
        <button type="button" class="loc-filter p-seg" data-location="all" aria-pressed="${activeLocation === 'all'}">Všetko</button>
        ${locations.map((location) => `<button type="button" class="loc-filter p-seg" data-location="${escapeHtml(location)}" aria-pressed="${activeLocation === location}">${escapeHtml(location)}</button>`).join('')}
      </div>` : '';

  const favorites = restaurants.filter((r) => r.favorite);
  const cards = favorites.length ? `
    <div class="p-label"><span>Tvoje obľúbené</span><span>${favorites.length}</span></div>
    <div class="p-favs">
      ${favorites.map((r, i) => `
      <article class="p-card ${i || !r.dishes.length ? 'p-card-alt' : ''}" data-loc-item data-location="${escapeHtml(r.location)}" ${hiddenAttr(r.location)}>
        <div class="p-card-top"><div><h3>${escapeHtml(r.name)}</h3><span class="p-where">${escapeHtml(r.location)}${r.dishes.length ? ` · ${r.dishes.length} ${plural(r.dishes.length, 'jedlo', 'jedlá', 'jedál')}` : ''}</span></div><span class="p-card-star" aria-hidden="true">★</span></div>
        ${r.dishes.length ? '' : '<p class="p-closed-note">Zatvorené · v tento deň bez menu</p>'}
        <ul>
          ${r.dishes.slice(0, 3).map((d) => `<li><span>${escapeHtml(d.title)}</span><b>${escapeHtml(priceOf(d))}</b></li>`).join('')}
        </ul>
        ${r.dishes.length > 3 ? `<span class="p-more">+ ${r.dishes.length - 3} ${plural(r.dishes.length - 3, 'ďalšie', 'ďalšie', 'ďalších')}</span>` : ''}
      </article>`).join('')}
    </div>` : '';

  // With a favorites strip everything below starts collapsed; otherwise open the first restaurant
  const firstOpen = restaurants.findIndex((r) => r.dishes.length);
  const accordions = restaurants.map((r, i) => {
    if (!r.dishes.length) {
      return `
      <div class="p-acc p-acc-closed" data-loc-item data-location="${escapeHtml(r.location)}" ${hiddenAttr(r.location)}>
        <div class="p-acc-row">
          <div class="p-acc-btn">
            <h3>${escapeHtml(r.name)}</h3>
            <span class="p-meta">${escapeHtml(r.location)} · zatvorené</span>
          </div>
          ${ctx.favButton(r, 'p-star')}
        </div>
      </div>`;
    }
    const open = !favorites.length && i === firstOpen;
    const prices = r.dishes.map((d) => Number(d.price_eur)).filter((n) => n > 0);
    const id = `acc-${i}`;
    return `
      <div class="p-acc" data-loc-item data-location="${escapeHtml(r.location)}" ${hiddenAttr(r.location)}>
        <div class="p-acc-row">
          <button type="button" class="acc-toggle p-acc-btn" aria-expanded="${open}" aria-controls="${id}">
            <h3>${escapeHtml(r.name)}</h3>
            <span class="p-meta">${escapeHtml(r.location)} · ${r.dishes.length} ${plural(r.dishes.length, 'jedlo', 'jedlá', 'jedál')}${prices.length ? ` · od <b>${escapeHtml(euro(Math.min(...prices)))}</b>` : ''}</span>
            <span class="p-chev" aria-hidden="true">${CHEVRON_SVG('m6 9 6 6 6-6')}</span>
          </button>
          ${ctx.favButton(r, 'p-star')}
        </div>
        <div class="p-acc-body" id="${id}" ${open ? '' : 'hidden'}>
          ${r.dishes.map((d) => {
            const allergens = Array.isArray(d.allergens) ? d.allergens : [];
            return `<div class="p-dish"><span class="p-cat">${escapeHtml(badge(d))}</span><span>${escapeHtml(d.title)}${allergens.length ? `<small>Alergény ${escapeHtml(allergens.join(', '))}</small>` : ''}</span><b>${escapeHtml(priceOf(d))}</b></div>`;
          }).join('')}
          ${r.url ? `<a class="p-source" href="${escapeHtml(r.url)}" target="_blank" rel="noreferrer">Zdroj menu ${ARROW_SVG}</a>` : ''}
        </div>
      </div>`;
  }).join('');

  return `
  <div class="p-page">
    <header class="p-head">
      <div class="p-row">
        <span class="p-brand"><i aria-hidden="true"></i>${escapeHtml(SITE_TITLE)}</span>
        <div class="p-actions">
          ${ctx.themeButton('p-icon-btn')}
          ${user?.role === 'admin' ? '<a href="/admin" class="p-pill">Admin</a>' : ''}
          ${user
            ? `<button id="prefs-open" type="button" class="p-pill p-me" aria-label="Môj výber (${escapeHtml(user.email)})"><span>${ctx.initial}</span><em class="p-me-label">Môj výber</em></button>`
            : '<button id="login-open" type="button" class="p-pill p-pill-primary">Prihlásiť</button>'}
        </div>
      </div>
      <h1 class="p-title"><small>${escapeHtml(formatHeroDate(selected))}</small>${heading}</h1>
      ${segs}
    </header>

    <main>
      ${ctx.flash ? `<div class="p-pad">${ctx.message(ctx.flash.kind, ctx.flash.text)}</div>` : ''}
      ${ctx.error ? `<p class="p-empty"><strong>Menu sa nepodarilo načítať.</strong> ${escapeHtml(ctx.error)}</p>` : ''}
      ${!ctx.error && !ctx.openCount ? `<p class="p-empty"><strong>Zatiaľ tu nie je menu.</strong> ${escapeHtml(ctx.emptyText)}</p>` : ''}
      ${!ctx.error ? cards : ''}
      ${!ctx.error && restaurants.length ? `<div class="p-label"><span>Všetky reštaurácie</span><span>${restaurants.length}</span></div><div class="p-list">${accordions}</div>` : ''}
      <p class="p-foot">${escapeHtml(ctx.updatedLabel)}</p>
    </main>

    <div class="p-spacer"></div>
    <nav class="p-dock" aria-label="Výber dňa">
      <div class="p-dock-inner">
        <a href="${dateHref(shiftIsoDate(menuDate, -1))}" aria-label="Predchádzajúci deň">${CHEVRON_SVG(PREV_PATH)}</a>
        <!-- Transparent native date input over the label: tapping opens the OS date picker -->
        <div class="p-date">
          <strong>${escapeHtml(dockLabel)}</strong><small>${escapeHtml(formatShortDate(selected))}</small>
          <input id="date-input" type="date" value="${escapeHtml(menuDate)}" aria-label="Vybrať dátum">
        </div>
        <a href="${dateHref(shiftIsoDate(menuDate, 1))}" aria-label="Nasledujúci deň">${CHEVRON_SVG(NEXT_PATH)}</a>
      </div>
    </nav>
  </div>`;
}

const MODAL = {
  input: 'mt-1 w-full border border-line-strong rounded-xl px-4 py-3 text-base bg-ground text-ink focus:outline-none focus:ring-2 focus:ring-accent',
  label: 'block text-xs font-bold text-muted uppercase tracking-wide',
  pane: 'auth-pane-btn h-10 px-4 rounded-full text-sm font-semibold border cursor-pointer bg-surface text-muted border-line-strong aria-pressed:bg-ink aria-pressed:text-surface aria-pressed:border-ink',
  primary: 'w-full px-4 py-3 bg-ink text-surface font-bold rounded-xl cursor-pointer border-0 hover:opacity-90',
  close: (id) => `
      <button id="${id}" type="button" aria-label="Zavrieť" class="absolute top-4 right-4 grid place-items-center w-10 h-10 rounded-full bg-ground text-muted hover:text-ink cursor-pointer border-0">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>`,
};

function renderLoginModal(user, auth, message) {
  if (user) return '';
  const pane = auth?.pane === 'register' ? 'register' : 'login';
  return `
  <div id="login-modal" class="fixed inset-0 z-50 ${auth ? 'flex' : 'hidden'} items-center justify-center bg-black/60 p-4">
    <div role="dialog" aria-modal="true" aria-label="Prihlásenie" class="w-full max-w-md bg-surface text-ink border border-line rounded-3xl shadow-2xl p-6 relative">
      ${MODAL.close('login-close')}

      <div class="flex gap-2 mb-5">
        <button type="button" class="${MODAL.pane}" data-pane="login" aria-pressed="${pane === 'login'}">Prihlásenie</button>
        <button type="button" class="${MODAL.pane}" data-pane="register" aria-pressed="${pane === 'register'}">Registrácia</button>
      </div>

      ${message('error', auth?.error)}
      ${message('notice', auth?.notice)}

      <form id="pane-login" method="post" action="/admin/login" class="${pane === 'login' ? '' : 'hidden'} grid gap-3">
        <label class="block"><span class="${MODAL.label}">E-mail</span><input type="email" name="email" required autocomplete="username" class="${MODAL.input}"></label>
        <label class="block"><span class="${MODAL.label}">Heslo</span><input type="password" name="password" required autocomplete="current-password" class="${MODAL.input}"></label>
        <button type="submit" class="mt-1 ${MODAL.primary}">Prihlásiť</button>
        <a href="/admin?view=reset" class="text-sm font-semibold text-muted hover:text-ink no-underline justify-self-start">Zabudnuté heslo?</a>
      </form>

      <form id="pane-register" method="post" action="/admin/register" class="${pane === 'register' ? '' : 'hidden'} grid gap-3">
        <p class="m-0 text-sm text-muted">Nový účet musí schváliť admin. Úplne prvý zaregistrovaný účet sa stáva adminom.</p>
        <label class="block"><span class="${MODAL.label}">E-mail</span><input type="email" name="email" required autocomplete="username" class="${MODAL.input}"></label>
        <label class="block"><span class="${MODAL.label}">Heslo (min. 8 znakov)</span><input type="password" name="password" required minlength="8" autocomplete="new-password" class="${MODAL.input}"></label>
        <label class="block"><span class="${MODAL.label}">Heslo znova</span><input type="password" name="password_confirm" required minlength="8" autocomplete="new-password" class="${MODAL.input}"></label>
        <button type="submit" class="mt-1 ${MODAL.primary}">Registrovať</button>
      </form>
    </div>
  </div>`;
}

function renderPrefsModal(user, userLocations, menuDate) {
  if (!user) return '';
  const moveBtn = 'move-btn grid place-items-center w-11 h-11 rounded-lg border border-line-strong bg-surface text-ink cursor-pointer hover:border-ink disabled:opacity-30 disabled:cursor-default';
  return `
  <div id="prefs-modal" class="fixed inset-0 z-50 hidden items-center justify-center bg-black/60 p-4">
    <div role="dialog" aria-modal="true" aria-label="Môj výber" class="w-full max-w-md max-h-full overflow-y-auto bg-surface text-ink border border-line rounded-3xl shadow-2xl p-6 relative">
      ${MODAL.close('prefs-close')}
      <h2 class="m-0 font-display font-bold text-2xl tracking-tight">Môj výber</h2>
      <p class="m-0 mt-1 mb-5 text-sm text-muted break-all">${escapeHtml(user.email)}</p>

      <form method="post" action="/me/preferences" class="grid gap-5">
        <input type="hidden" name="date" value="${escapeHtml(menuDate)}">
        <label class="block"><span class="${MODAL.label}">Predvolená lokalita</span>
          <select name="default_location" class="${MODAL.input}">
            <option value="">Všetky lokality</option>
            ${userLocations.map((name) => `<option value="${escapeHtml(name)}" ${name === user.default_location ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}
          </select>
        </label>

        <div>
          <span class="${MODAL.label}">Poradie lokalít</span>
          <ol id="order-list" class="m-0 mt-1 p-0 list-none grid gap-2">
            ${userLocations.map((name) => `
            <li class="order-item flex items-center gap-2 border border-line rounded-xl pl-4 pr-1.5 py-1.5">
              <input type="hidden" name="order" value="${escapeHtml(name)}">
              <span class="flex-1 font-semibold min-w-0 truncate">${escapeHtml(name)}</span>
              <button type="button" class="${moveBtn}" data-move="-1" aria-label="Posunúť ${escapeHtml(name)} vyššie">↑</button>
              <button type="button" class="${moveBtn}" data-move="1" aria-label="Posunúť ${escapeHtml(name)} nižšie">↓</button>
            </li>`).join('')}
          </ol>
          <p class="m-0 mt-2 text-xs text-muted">Obľúbené reštaurácie označíš hviezdičkou, zobrazia sa navrchu svojej lokality.</p>
        </div>

        <div class="flex flex-wrap gap-2">
          <button type="submit" name="action" value="save" class="flex-1 px-4 py-3 bg-ink text-surface font-bold rounded-xl cursor-pointer border-0 hover:opacity-90">Uložiť</button>
          <button type="submit" name="action" value="reset_order" class="px-4 py-3 bg-transparent text-ink font-semibold rounded-xl cursor-pointer border border-line-strong hover:border-ink">Predvolené poradie</button>
        </div>
      </form>

      <div class="flex justify-end mt-5 pt-4 border-t border-line">
        <a href="/logout" class="text-sm font-semibold text-muted hover:text-ink no-underline">Odhlásiť sa</a>
      </div>
    </div>
  </div>`;
}

// Password reset flow; login and registration live in the modal on the home page
function renderResetPage({ error = '', notice = '' } = {}) {
  const authInput = 'mt-1 w-full border border-gray-300 rounded-xl px-4 py-3 text-base bg-white focus:outline-none focus:ring-2 focus:ring-gray-900';
  const authLabel = 'block text-xs font-bold text-gray-500 uppercase tracking-wide';

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
        <a href="/?auth=login" class="font-bold text-gray-500 hover:text-gray-900 no-underline">← Späť na prihlásenie</a>
      </div>
    </div>`;

  return `<!doctype html>
<html lang="sk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Obnovenie hesla · ${escapeHtml(SITE_TITLE)}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${TAILWIND_URL}">
</head>
<body class="min-h-screen grid place-items-center bg-gray-100 text-gray-900 antialiased px-3 py-8">
  <main class="w-full max-w-md">
    ${error ? `<div class="mb-4 px-4 py-3 bg-red-50 border border-red-200 text-red-800 font-semibold rounded-xl text-sm">${escapeHtml(error)}</div>` : ''}
    ${notice ? `<div class="mb-4 px-4 py-3 bg-green-50 border border-green-200 text-green-800 font-semibold rounded-xl text-sm">${escapeHtml(notice)}</div>` : ''}
    ${resetView}
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

  const locationOptions = (selected) => {
    const names = locations.map((l) => l.name);
    const opts = names.map((name) => `<option value="${escapeHtml(name)}" ${name === selected ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('');
    return opts + (!names.includes(selected) ? `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}</option>` : '');
  };

  const parserOptions = (selected) => Object.entries(PARSERS).map(([key, parser]) =>
    `<option value="${key}" ${key === selected ? 'selected' : ''}>${escapeHtml(parser.label)}</option>`
  ).join('');

  // One form per restaurant; src = null renders the "add" form
  const restaurantForm = (src) => {
    const isNew = !src;
    const r = src || { source_name: '', source_url: '', source_location: locations[0]?.name || '', parser_name: 'ai_extract', parser_config: {}, has_weekend_menu: false, enabled: true };
    const config = r.parser_config && Object.keys(r.parser_config).length ? JSON.stringify(r.parser_config) : '';
    const status = isNew ? ''
      : !r.enabled ? 'Vypnutá: nezobrazuje sa a n8n ju preskakuje.'
      : r.items_on_date ? `${r.items_on_date} ${plural(r.items_on_date, 'jedlo', 'jedlá', 'jedál')} na ${menuDate}`
      : r.parser_name === 'manual' ? 'Jedlá sa zadávajú ručne v záložke Položky.'
      : `Na ${menuDate} bez menu · ${r.last_menu_date ? `posledné menu ${r.last_menu_date}` : 'zatiaľ žiadne menu'}`;
    return `
      <form class="restaurant-form grid gap-3 p-5 ${!isNew && !r.enabled ? 'bg-gray-50' : ''}" method="post" action="/admin/restaurants/${isNew ? 'create' : 'update'}">
        <input type="hidden" name="_tab" value="restauracie">
        <input type="hidden" name="menu_date" value="${escapeHtml(menuDate)}">
        ${isNew ? '' : `<input type="hidden" name="source_id" value="${escapeHtml(r.source_id)}">`}
        <div class="grid gap-3 md:grid-cols-12">
          <label class="block md:col-span-4"><span class="${tw.label}">Názov${isNew ? '' : ` <span class="normal-case font-normal text-gray-400">· ${escapeHtml(r.source_id)}</span>`}</span><input name="source_name" required value="${escapeHtml(r.source_name)}" class="${tw.input}"></label>
          ${isNew ? `<label class="block md:col-span-2"><span class="${tw.label}">ID</span><input name="source_id" placeholder="automaticky" class="${tw.input}"></label>` : ''}
          <label class="block ${isNew ? 'md:col-span-2' : 'md:col-span-3'}"><span class="${tw.label}">Lokalita</span><select name="source_location" class="${tw.input}">${locationOptions(r.source_location)}</select></label>
          <label class="block ${isNew ? 'md:col-span-4' : 'md:col-span-5'}"><span class="${tw.label}">Typ parsera</span><select name="parser_name" class="parser-select ${tw.input}">${parserOptions(r.parser_name)}</select></label>
          <label class="block md:col-span-12"><span class="${tw.label}">URL stránky s menu</span><input name="source_url" type="url" value="${escapeHtml(r.source_url)}" placeholder="https://…" class="${tw.input}"></label>
        </div>
        <p class="parser-hint m-0 text-xs text-gray-500">${escapeHtml(PARSERS[r.parser_name]?.hint || '')}</p>
        <details class="text-sm">
          <summary class="cursor-pointer font-semibold text-gray-500">Pokročilé nastavenia</summary>
          <label class="block mt-2"><span class="${tw.label}">Konfigurácia parsera (JSON)</span><textarea name="parser_config" rows="2" placeholder="{}" class="${tw.input} font-mono">${escapeHtml(config)}</textarea></label>
        </details>
        <div class="flex flex-wrap items-center gap-x-5 gap-y-2">
          <label class="inline-flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" ${r.enabled ? 'checked' : ''}> Zapnutá</label>
          <label class="inline-flex items-center gap-2 text-sm"><input type="checkbox" name="has_weekend_menu" ${r.has_weekend_menu ? 'checked' : ''}> Má menu aj cez víkend</label>
          <span class="text-xs text-gray-400">${escapeHtml(status)}</span>
          <div class="flex gap-2 md:ml-auto">
            <button type="button" class="${tw.btnOutline} disabled:opacity-40 disabled:cursor-not-allowed" data-test-parser ${N8N_TEST_WEBHOOK_URL ? '' : 'disabled title="Test nie je nastavený (N8N_TEST_WEBHOOK_URL)"'}>Otestovať</button>
            <button type="submit" class="${tw.btnGreen}">${isNew ? 'Pridať reštauráciu' : 'Uložiť'}</button>
          </div>
        </div>
        <div class="test-result hidden rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm" aria-live="polite"></div>
      </form>`;
  };

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
  <link rel="stylesheet" href="${TAILWIND_URL}">
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
        <a href="/logout" class="${tw.btnGray} no-underline">Odhlásiť</a>
      </div>
    </div>

    ${notice ? `<div class="mb-4 px-4 py-3 bg-green-50 border border-green-200 text-green-800 font-semibold rounded-xl text-sm">${escapeHtml(notice)}</div>` : ''}
    ${error ? `<div class="mb-4 px-4 py-3 bg-red-50 border border-red-200 text-red-800 font-semibold rounded-xl text-sm">${escapeHtml(error)}</div>` : ''}

    <div class="bg-white border border-gray-200 rounded-2xl shadow-sm p-4 mb-4 flex items-center justify-between gap-3 flex-wrap">
      <div>
        <h2 class="text-base font-bold">Vzhľad hlavnej stránky</h2>
        <p class="text-sm text-gray-400 mt-0.5">Platí iba pre teba. Ostatní vidia Týždenný lístok.</p>
      </div>
      <form class="flex gap-1 p-1 bg-gray-100 rounded-full" method="post" action="/admin/layout">
        <input type="hidden" name="menu_date" value="${escapeHtml(menuDate)}">
        <input type="hidden" name="_tab" value="${escapeHtml(activeTab)}">
        ${[['listok', 'Týždenný lístok'], ['palcom', 'Palcom']].map(([value, label]) => {
          const on = (currentUser.page_layout || 'listok') === value;
          return `<button type="submit" name="page_layout" value="${value}" aria-pressed="${on}" class="px-4 py-2 rounded-full text-sm font-bold border-0 cursor-pointer ${on ? 'bg-gray-900 text-white' : 'bg-transparent text-gray-500 hover:text-gray-900'}">${label}</button>`;
        }).join('')}
      </form>
    </div>

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
      <div class="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden mb-4">
        <div class="px-5 py-3 border-b border-gray-100">
          <h2 class="text-base font-bold">Pridať reštauráciu</h2>
          <p class="text-sm text-gray-400 mt-0.5">Typ parsera určuje, ako n8n číta menu. Pred uložením ho over tlačidlom Otestovať (testuje sa dátum ${escapeHtml(menuDate)} z filtra hore).</p>
        </div>
        ${restaurantForm(null)}
      </div>
      <div class="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
        <div class="px-5 py-3 border-b border-gray-100">
          <h2 class="text-base font-bold">Reštaurácie (${sources.length})</h2>
          <p class="text-sm text-gray-400 mt-0.5">Lokalita určuje skupinu na hlavnej stránke. Vypnutá reštaurácia sa nezobrazuje a n8n ju preskakuje.</p>
        </div>
        <div class="divide-y divide-gray-100">${sources.map((src) => restaurantForm(src)).join('') || '<p class="px-5 py-6 text-sm text-gray-400">Žiadne reštaurácie.</p>'}</div>
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

    // Restaurants: parser hint follows the select; "Otestovať" runs the parser via n8n without saving
    const PARSER_HINTS = ${JSON.stringify(Object.fromEntries(Object.entries(PARSERS).map(([key, parser]) => [key, parser.hint])))};
    document.querySelectorAll('.parser-select').forEach((select) => select.addEventListener('change', () => {
      select.closest('form').querySelector('.parser-hint').textContent = PARSER_HINTS[select.value] || '';
    }));
    document.querySelectorAll('[data-test-parser]').forEach((button) => button.addEventListener('click', async () => {
      const form = button.closest('form');
      const out = form.querySelector('.test-result');
      const line = (text, cls) => { const p = document.createElement('p'); p.className = 'm-0 ' + (cls || ''); p.textContent = text; return p; };
      out.classList.remove('hidden');
      out.replaceChildren(line('Testujem parser… (AI extrakcia môže trvať aj minútu)', 'text-gray-500'));
      button.disabled = true;
      try {
        const res = await fetch('/admin/restaurants/test', { method: 'POST', body: new URLSearchParams(new FormData(form)), headers: { accept: 'application/json' } });
        const data = await res.json();
        const items = Array.isArray(data.items) ? data.items : [];
        if (items.length) {
          const noun = items.length === 1 ? 'jedlo' : items.length <= 4 ? 'jedlá' : 'jedál';
          out.replaceChildren(line('✓ Našiel som ' + items.length + ' ' + noun + ' na ' + data.menuDate + ':', 'font-bold text-green-700'));
          const list = document.createElement('ul');
          list.className = 'm-0 mt-2 pl-5 list-disc grid gap-0.5';
          items.forEach((item) => {
            const li = document.createElement('li');
            const price = item.price_eur != null && item.price_eur !== '' ? ' · ' + Number(item.price_eur).toFixed(2).replace('.', ',') + ' €' : '';
            li.textContent = (item.menu_code ? item.menu_code + ' – ' : '') + item.title + price + ' (' + (item.category || 'main') + ')';
            list.append(li);
          });
          out.append(list);
        } else {
          const skipped = data.status === 'skipped';
          out.replaceChildren(line((skipped ? 'Preskočené: ' : '✗ Nenašiel som žiadne jedlá. ') + (data.errorMessage || ''), skipped ? 'font-bold text-gray-600' : 'font-bold text-red-700'));
        }
      } catch (err) {
        out.replaceChildren(line('✗ Test zlyhal: ' + err.message, 'font-bold text-red-700'));
      } finally {
        button.disabled = false;
      }
    }));
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

// Login modal on the home page, opened with an optional message
function authUrl(pane, { error = '', notice = '' } = {}) {
  const params = new URLSearchParams({ auth: pane });
  if (error) params.set('auth_error', error);
  if (notice) params.set('auth_notice', notice);
  return `/?${params}`;
}

async function adminGet(req, res, url) {
  const user = await getSessionUser(req);
  if (!user) {
    if (url.searchParams.get('view') !== 'reset') return redirect(res, authUrl('login'));
    return sendHtml(res, 200, renderResetPage({
      error: url.searchParams.get('error') || '',
      notice: url.searchParams.get('notice') || '',
    }));
  }
  if (user.role !== 'admin') return redirect(res, '/');

  const menuDate = url.searchParams.get('date') || todayIso();
  const data = await queryAdminData(menuDate);
  sendHtml(res, 200, renderAdminPage({
    ...data,
    users: await listUsers(),
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
      return redirect(res, '/', { 'set-cookie': sessionCookies(token) });
    } catch (err) {
      return redirect(res, authUrl('login', { error: err.message }));
    }
  }

  if (url.pathname === '/admin/register') {
    const form = await readForm(req);
    try {
      const user = await registerUser(form);
      if (user.is_approved) {
        const token = await createSession(user.id);
        return redirect(res, '/', { 'set-cookie': sessionCookies(token) });
      }
      return redirect(res, authUrl('login', { notice: 'Registrácia prebehla. Prihlásiť sa budeš môcť po schválení adminom.' }));
    } catch (err) {
      return redirect(res, authUrl('register', { error: err.message }));
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
      return redirect(res, authUrl('login', { notice: 'Heslo bolo zmenené. Prihlás sa novým heslom.' }));
    } catch (err) {
      return redirect(res, `/admin?view=reset&error=${encodeURIComponent(err.message)}`);
    }
  }

  const user = await getSessionUser(req);
  if (!user) return redirect(res, authUrl('login', { error: 'Prihlás sa, prosím.' }));
  if (user.role !== 'admin') return redirect(res, '/');

  const form = await readForm(req);
  const menuDate = clean(form.menu_date, todayIso());
  const tab = clean(form._tab, 'polozky');

  if (url.pathname === '/admin/restaurants/test') {
    let status = 200;
    let payload;
    try {
      payload = await testRestaurant(form);
    } catch (err) {
      status = 400;
      payload = { ok: false, errorMessage: err.message };
    }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(payload));
  }

  try {
    if (url.pathname === '/admin/users/approve' || url.pathname === '/admin/users/delete') {
      if (url.pathname === '/admin/users/approve') await approveUser(form);
      else await deleteUser(form, user);
    }
    else if (url.pathname === '/admin/items/create') await createItem(form);
    else if (url.pathname === '/admin/items/update') await updateItem(form);
    else if (url.pathname === '/admin/items/delete') await deleteItem(form);
    else if (url.pathname === '/admin/restaurants/create') await createRestaurant(form);
    else if (url.pathname === '/admin/restaurants/update') await updateRestaurant(form);
    else if (url.pathname === '/admin/locations/create') await createLocation(form);
    else if (url.pathname === '/admin/locations/update') await updateLocation(form);
    else if (url.pathname === '/admin/locations/delete') await deleteLocation(form);
    else if (url.pathname === '/admin/layout') await setPageLayout(user.id, form);
    else return sendHtml(res, 404, '<h1>404</h1>');

    redirect(res, `/admin?date=${encodeURIComponent(menuDate)}&tab=${encodeURIComponent(tab)}&notice=${encodeURIComponent('Zmena bola uložená.')}`);
  } catch (err) {
    redirect(res, `/admin?date=${encodeURIComponent(menuDate)}&tab=${encodeURIComponent(tab)}&error=${encodeURIComponent(err.message)}`);
  }
}

// Logged-in user's own preferences (any approved role)
async function mePost(req, res, url) {
  const wantsJson = String(req.headers.accept || '').includes('application/json');
  const user = await getSessionUser(req);
  if (!user) {
    if (wantsJson) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    return redirect(res, authUrl('login', { error: 'Prihlás sa, prosím.' }));
  }

  const params = new URLSearchParams(await readBody(req));
  try {
    if (url.pathname === '/me/favorites/toggle') {
      const favorite = await toggleFavorite(user.id, clean(params.get('source_id')));
      if (wantsJson) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ favorite }));
      }
      return redirect(res, '/');
    }
    if (url.pathname === '/me/preferences') {
      await savePreferences(user.id, params);
      const date = parseIsoDate(params.get('date')) && params.get('date') !== todayIso() ? `&date=${params.get('date')}` : '';
      return redirect(res, `/?saved=1${date}`);
    }
    return sendHtml(res, 404, '<h1>404</h1>');
  } catch (err) {
    if (wantsJson) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: err.message }));
    }
    return redirect(res, `/?error=${encodeURIComponent(err.message)}`);
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
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' });
      res.end(tailwindCss);
      return;
    }

    // /admin/logout kept for old bookmarks
    if (req.method === 'GET' && (url.pathname === '/logout' || url.pathname === '/admin/logout')) {
      await destroySession(req);
      return redirect(res, '/', { 'set-cookie': sessionCookies('', 0) });
    }

    if (req.method === 'GET' && url.pathname === '/admin') return await adminGet(req, res, url);
    if (req.method === 'POST' && url.pathname.startsWith('/admin/')) return await adminPost(req, res, url);
    if (req.method === 'POST' && url.pathname.startsWith('/me/')) return await mePost(req, res, url);

    if (req.method === 'GET' && url.pathname === '/') {
      const user = await getSessionUser(req);
      const param = (name) => url.searchParams.get(name) || '';
      const menuDate = parseIsoDate(param('date')) ? param('date') : todayIso();
      const { items, sources, lastUpdatedAt } = await queryMenu(menuDate, user?.id ?? null);
      return sendHtml(res, 200, renderPublicPage(items, {
        sources,
        menuDate,
        lastUpdatedAt,
        user,
        userLocations: user ? await queryUserLocations(user.id) : [],
        auth: !user && param('auth') ? { pane: param('auth'), error: param('auth_error'), notice: param('auth_notice') } : null,
        flash: user && param('error') ? { kind: 'error', text: param('error') }
          : user && param('saved') ? { kind: 'notice', text: 'Tvoj výber bol uložený.' } : null,
      }));
    }

    sendHtml(res, 404, '<h1>404</h1>');
  } catch (err) {
    console.error(`${req.method} ${url.pathname} zlyhalo:`, err);
    sendHtml(res, 500, `<h1>Chyba</h1><pre>${escapeHtml(IS_PRODUCTION ? 'Interná chyba servera.' : err.message)}</pre>`);
  }
});

// Schema is managed by migrate.js (a separate one-off process), not at web startup
function start() {
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
