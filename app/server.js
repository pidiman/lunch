const http = require('http');
const { Client } = require('pg');

const PORT = Number(process.env.PORT || 3000);
const SITE_TITLE = process.env.SITE_TITLE || 'Obedové menu';

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

function formatPrice(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  if (Number.isNaN(number)) return '';
  return `${number.toFixed(2).replace('.', ',')} €`;
}

function categoryLabel(category) {
  const labels = {
    soup: 'Polievka',
    main: 'Hlavné jedlo',
    pizza: 'Pizza',
    special: 'Špeciál',
    side: 'Príloha',
    dessert: 'Dezert',
    drink: 'Nápoj',
    unknown: 'Menu',
  };

  return labels[category] || 'Menu';
}

function categoryIcon(category) {
  const icons = {
    soup: '🥣',
    main: '🍽️',
    pizza: '🍕',
    special: '⭐',
    side: '🥔',
    dessert: '🍰',
    drink: '🥤',
    unknown: '🍴',
  };

  return icons[category] || '🍴';
}

async function queryTodayMenu() {
  const client = new Client(dbConfig);
  await client.connect();

  try {
    const result = await client.query(`
      SELECT
        source_id,
        source_name,
        source_url,
        menu_date,
        menu_code,
        category,
        title,
        description,
        price_eur,
        currency,
        allergens,
        parsed_at
      FROM v_lunch_menu_today
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
    `);

    return result.rows;
  } finally {
    await client.end();
  }
}

function groupBySource(items) {
  return items.reduce((acc, item) => {
    const key = item.source_name || 'Neznámy zdroj';
    acc[key] ||= [];
    acc[key].push(item);
    return acc;
  }, {});
}

function renderMenuItem(item) {
  const price = formatPrice(item.price_eur);
  const allergens = Array.isArray(item.allergens) ? item.allergens : [];
  const code = item.menu_code ? String(item.menu_code).trim() : '';
  const category = item.category || 'unknown';

  return `
    <article class="menu-item">
      <div class="menu-item-body">
        <div class="menu-item-topline">
          ${code ? `<span class="menu-code">${escapeHtml(code)}</span>` : ''}
          <span class="category-chip category-${escapeHtml(category)}">
            <span aria-hidden="true">${categoryIcon(category)}</span>
            ${escapeHtml(categoryLabel(category))}
          </span>
        </div>

        <h3>${escapeHtml(item.title)}</h3>

        ${item.description ? `<p class="description">${escapeHtml(item.description)}</p>` : ''}

        ${allergens.length ? `
          <p class="allergens">
            <span>Alergény:</span> ${escapeHtml(allergens.join(', '))}
          </p>
        ` : ''}
      </div>

      ${price ? `<div class="price-badge">${escapeHtml(price)}</div>` : ''}
    </article>
  `;
}

function renderPage(items, error = null) {
  const now = new Date();
  const today = new Intl.DateTimeFormat('sk-SK', {
    timeZone: 'Europe/Bratislava',
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(now);

  const updatedAt = new Intl.DateTimeFormat('sk-SK', {
    timeZone: 'Europe/Bratislava',
    hour: '2-digit',
    minute: '2-digit',
  }).format(now);

  const grouped = groupBySource(items);
  const sourceCount = Object.keys(grouped).length;
  const itemCount = items.length;

  const groupsHtml = Object.entries(grouped).map(([sourceName, rows]) => {
    const sourceUrl = rows.find((row) => row.source_url)?.source_url;

    return `
      <section class="restaurant-card">
        <div class="restaurant-header">
          <div>
            <p class="eyebrow">Reštaurácia</p>
            <h2>${escapeHtml(sourceName)}</h2>
          </div>
          <div class="restaurant-count">${rows.length}</div>
        </div>

        <div class="menu-list">
          ${rows.map(renderMenuItem).join('')}
        </div>

        ${sourceUrl ? `
          <a class="source-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">
            Otvoriť zdroj menu
          </a>
        ` : ''}
      </section>
    `;
  }).join('');

  return `<!doctype html>
<html lang="sk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#111827">
  <title>${escapeHtml(SITE_TITLE)}</title>
  <style>
    :root {
      --bg: #f3f4f6;
      --surface: #ffffff;
      --surface-soft: #f9fafb;
      --text: #111827;
      --muted: #6b7280;
      --border: #e5e7eb;
      --accent: #16a34a;
      --accent-strong: #15803d;
      --danger: #dc2626;
      --shadow: 0 18px 45px rgba(15, 23, 42, 0.10);
      --radius-xl: 28px;
      --radius-lg: 20px;
      --radius-md: 14px;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }

    * {
      box-sizing: border-box;
    }

    html {
      min-height: 100%;
      background: var(--bg);
    }

    body {
      min-height: 100%;
      margin: 0;
      background:
        radial-gradient(circle at top left, rgba(34, 197, 94, .18), transparent 34rem),
        radial-gradient(circle at top right, rgba(59, 130, 246, .12), transparent 28rem),
        var(--bg);
    }

    a {
      color: inherit;
    }

    .page {
      width: min(1040px, 100%);
      margin: 0 auto;
      padding: 18px;
    }

    .hero {
      position: relative;
      overflow: hidden;
      border-radius: var(--radius-xl);
      padding: 28px;
      color: #fff;
      background:
        linear-gradient(135deg, rgba(17, 24, 39, .98), rgba(22, 101, 52, .92)),
        #111827;
      box-shadow: var(--shadow);
    }

    .hero::after {
      content: '';
      position: absolute;
      width: 220px;
      height: 220px;
      border-radius: 999px;
      right: -72px;
      top: -90px;
      background: rgba(255, 255, 255, .10);
    }

    .hero-content {
      position: relative;
      z-index: 1;
    }

    .hero-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 30px;
    }

    .app-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 9px 13px;
      border: 1px solid rgba(255,255,255,.18);
      border-radius: 999px;
      background: rgba(255,255,255,.10);
      font-size: 13px;
      font-weight: 700;
      letter-spacing: .02em;
      backdrop-filter: blur(10px);
    }

    .hero h1 {
      margin: 0;
      max-width: 720px;
      font-size: clamp(34px, 8vw, 64px);
      line-height: .95;
      letter-spacing: -.06em;
    }

    .hero-subtitle {
      max-width: 640px;
      margin: 16px 0 0;
      color: rgba(255,255,255,.78);
      font-size: clamp(15px, 3.8vw, 19px);
      line-height: 1.5;
    }

    .date-card {
      min-width: 164px;
      padding: 14px 16px;
      border-radius: 18px;
      background: rgba(255,255,255,.12);
      border: 1px solid rgba(255,255,255,.16);
      text-align: right;
      backdrop-filter: blur(10px);
    }

    .date-card strong {
      display: block;
      font-size: 14px;
    }

    .date-card span {
      display: block;
      margin-top: 4px;
      color: rgba(255,255,255,.72);
      font-size: 12px;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin-top: 26px;
    }

    .stat {
      padding: 14px;
      border-radius: 18px;
      background: rgba(255,255,255,.10);
      border: 1px solid rgba(255,255,255,.14);
    }

    .stat strong {
      display: block;
      font-size: 24px;
      line-height: 1;
    }

    .stat span {
      display: block;
      margin-top: 6px;
      color: rgba(255,255,255,.70);
      font-size: 12px;
      font-weight: 600;
    }

    .content {
      margin-top: 18px;
      display: grid;
      gap: 18px;
    }

    .restaurant-card,
    .empty-state,
    .error-state {
      border: 1px solid rgba(229, 231, 235, .9);
      border-radius: var(--radius-xl);
      background: rgba(255,255,255,.92);
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
    }

    .restaurant-card {
      padding: 18px;
    }

    .restaurant-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      padding: 4px 4px 16px;
      border-bottom: 1px solid var(--border);
    }

    .eyebrow {
      margin: 0 0 4px;
      color: var(--accent-strong);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .12em;
      text-transform: uppercase;
    }

    .restaurant-header h2 {
      margin: 0;
      font-size: clamp(22px, 5vw, 32px);
      letter-spacing: -.04em;
    }

    .restaurant-count {
      display: grid;
      place-items: center;
      min-width: 46px;
      height: 46px;
      border-radius: 16px;
      background: #dcfce7;
      color: #166534;
      font-weight: 900;
    }

    .menu-list {
      display: grid;
      gap: 12px;
      padding-top: 16px;
    }

    .menu-item {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 14px;
      align-items: start;
      padding: 15px;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--surface-soft);
    }

    .menu-item-topline {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 8px;
    }

    .menu-code {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 34px;
      height: 28px;
      padding: 0 9px;
      border-radius: 999px;
      background: #111827;
      color: #fff;
      font-size: 12px;
      font-weight: 900;
    }

    .category-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 28px;
      padding: 0 10px;
      border-radius: 999px;
      background: #eef2ff;
      color: #3730a3;
      font-size: 12px;
      font-weight: 800;
    }

    .category-soup { background: #ffedd5; color: #9a3412; }
    .category-main { background: #dcfce7; color: #166534; }
    .category-pizza { background: #fee2e2; color: #991b1b; }
    .category-special { background: #fef3c7; color: #92400e; }
    .category-side { background: #e0f2fe; color: #075985; }
    .category-dessert { background: #fce7f3; color: #9d174d; }
    .category-drink { background: #dbeafe; color: #1d4ed8; }

    .menu-item h3 {
      margin: 0;
      font-size: clamp(17px, 4vw, 21px);
      line-height: 1.22;
      letter-spacing: -.02em;
    }

    .description {
      margin: 8px 0 0;
      color: var(--muted);
      line-height: 1.5;
      font-size: 15px;
    }

    .allergens {
      margin: 10px 0 0;
      color: #6b7280;
      font-size: 13px;
    }

    .allergens span {
      font-weight: 800;
    }

    .price-badge {
      position: sticky;
      top: 12px;
      padding: 10px 12px;
      border-radius: 999px;
      background: #111827;
      color: #fff;
      font-weight: 900;
      white-space: nowrap;
      box-shadow: 0 10px 20px rgba(17, 24, 39, .18);
    }

    .source-link {
      display: inline-flex;
      align-items: center;
      margin-top: 14px;
      padding: 11px 14px;
      border-radius: 999px;
      background: #f3f4f6;
      color: #374151;
      font-size: 14px;
      font-weight: 800;
      text-decoration: none;
    }

    .source-link::after {
      content: '↗';
      margin-left: 7px;
    }

    .empty-state,
    .error-state {
      padding: 26px;
    }

    .empty-state h2,
    .error-state h2 {
      margin: 0 0 8px;
      font-size: 24px;
      letter-spacing: -.03em;
    }

    .empty-state p,
    .error-state p {
      margin: 0;
      color: var(--muted);
      line-height: 1.5;
    }

    .error-state {
      border-left: 6px solid var(--danger);
    }

    .footer {
      padding: 22px 4px 10px;
      color: var(--muted);
      font-size: 13px;
      text-align: center;
    }

    @media (max-width: 720px) {
      .page {
        padding: 12px;
      }

      .hero {
        padding: 22px;
        border-radius: 24px;
      }

      .hero-top {
        display: block;
      }

      .date-card {
        width: fit-content;
        margin-top: 18px;
        text-align: left;
      }

      .stats {
        grid-template-columns: 1fr;
      }

      .restaurant-card {
        padding: 14px;
        border-radius: 24px;
      }

      .restaurant-header {
        align-items: flex-start;
      }

      .menu-item {
        grid-template-columns: 1fr;
        gap: 12px;
      }

      .price-badge {
        position: static;
        justify-self: start;
      }
    }
  </style>
</head>
<body>
  <main class="page">
    <section class="hero">
      <div class="hero-content">
        <div class="hero-top">
          <div>
            <div class="app-pill">🍽️ ${escapeHtml(SITE_TITLE)}</div>
            <h1>Dnešné obedové menu</h1>
            <p class="hero-subtitle">
              Prehľad obedov zo všetkých tvojich zdrojov na jednom mieste. Dáta importuje n8n a stránka číta priamo z PostgreSQL.
            </p>
          </div>

          <div class="date-card">
            <strong>${escapeHtml(today)}</strong>
            <span>Aktualizované ${escapeHtml(updatedAt)}</span>
          </div>
        </div>

        <div class="stats" aria-label="Súhrn menu">
          <div class="stat">
            <strong>${itemCount}</strong>
            <span>položiek menu</span>
          </div>
          <div class="stat">
            <strong>${sourceCount}</strong>
            <span>zdrojov</span>
          </div>
          <div class="stat">
            <strong>SK</strong>
            <span>Europe/Bratislava</span>
          </div>
        </div>
      </div>
    </section>

    <section class="content">
      ${error ? `
        <div class="error-state">
          <h2>Menu sa nepodarilo načítať</h2>
          <p>${escapeHtml(error)}</p>
        </div>
      ` : ''}

      ${!error && items.length === 0 ? `
        <div class="empty-state">
          <h2>Zatiaľ tu nie je menu</h2>
          <p>V databáze nie sú položky pre dnešný deň. Skontroluj n8n import workflow alebo tabuľku <code>lunch_menu_items</code>.</p>
        </div>
      ` : ''}

      ${!error ? groupsHtml : ''}
    </section>

    <footer class="footer">
      Powered by n8n · PostgreSQL · Docker · Raspberry Pi homelab
    </footer>
  </main>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, service: 'obedove-menu' }));
    return;
  }

  try {
    const items = await queryTodayMenu();

    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(renderPage(items));
  } catch (err) {
    res.writeHead(500, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(renderPage([], err.message));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`obedove-menu listening on ${PORT}`);
});
