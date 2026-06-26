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

async function queryTodayMenu() {
  const client = new Client(dbConfig);
  await client.connect();

  try {
    const result = await client.query(`
      SELECT
        source_id,
        source_name,
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
      ORDER BY source_name, category, menu_code NULLS LAST, title
    `);

    return result.rows;
  } finally {
    await client.end();
  }
}

function renderPage(items, error = null) {
  const today = new Intl.DateTimeFormat('sk-SK', {
    timeZone: 'Europe/Bratislava',
    dateStyle: 'full',
  }).format(new Date());

  const grouped = items.reduce((acc, item) => {
    const key = item.source_name || 'Neznámy zdroj';
    acc[key] ||= [];
    acc[key].push(item);
    return acc;
  }, {});

  const groupsHtml = Object.entries(grouped).map(([sourceName, rows]) => `
    <section class="card">
      <h2>${escapeHtml(sourceName)}</h2>
      <div class="items">
        ${rows.map((item) => `
          <article class="item">
            <div class="item-main">
              <div class="item-title">
                ${item.menu_code ? `<span class="code">${escapeHtml(item.menu_code)}</span>` : ''}
                ${escapeHtml(item.title)}
              </div>
              ${item.description ? `<div class="desc">${escapeHtml(item.description)}</div>` : ''}
              ${Array.isArray(item.allergens) && item.allergens.length ? `<div class="allergens">Alergény: ${escapeHtml(item.allergens.join(', '))}</div>` : ''}
            </div>
            <div class="price">
              ${item.price_eur !== null && item.price_eur !== undefined ? `${Number(item.price_eur).toFixed(2).replace('.', ',')} €` : ''}
            </div>
          </article>
        `).join('')}
      </div>
    </section>
  `).join('');

  return `<!doctype html>
<html lang="sk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(SITE_TITLE)}</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f4f4f5;
      color: #18181b;
    }
    body {
      margin: 0;
      padding: 24px;
    }
    main {
      max-width: 980px;
      margin: 0 auto;
    }
    header {
      margin-bottom: 24px;
    }
    h1 {
      margin: 0 0 6px;
      font-size: clamp(28px, 5vw, 44px);
    }
    .date {
      color: #71717a;
      font-size: 16px;
    }
    .card {
      background: white;
      border-radius: 18px;
      padding: 20px;
      margin-bottom: 18px;
      box-shadow: 0 8px 30px rgba(0,0,0,.06);
    }
    h2 {
      margin: 0 0 14px;
      font-size: 22px;
    }
    .item {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 14px;
      padding: 14px 0;
      border-top: 1px solid #e4e4e7;
    }
    .item:first-child {
      border-top: 0;
    }
    .item-title {
      font-weight: 700;
      font-size: 17px;
    }
    .code {
      display: inline-block;
      min-width: 34px;
      color: #71717a;
      font-weight: 600;
    }
    .desc {
      margin-top: 5px;
      color: #52525b;
      line-height: 1.45;
    }
    .allergens {
      margin-top: 5px;
      color: #71717a;
      font-size: 13px;
    }
    .price {
      font-weight: 800;
      font-size: 17px;
      white-space: nowrap;
    }
    .empty, .error {
      background: white;
      border-radius: 18px;
      padding: 20px;
      box-shadow: 0 8px 30px rgba(0,0,0,.06);
    }
    .error {
      border-left: 5px solid #dc2626;
    }
    footer {
      color: #71717a;
      font-size: 13px;
      margin-top: 24px;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        background: #09090b;
        color: #fafafa;
      }
      .card, .empty, .error {
        background: #18181b;
      }
      .item {
        border-top-color: #27272a;
      }
      .desc {
        color: #d4d4d8;
      }
      .date, .code, .allergens, footer {
        color: #a1a1aa;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(SITE_TITLE)}</h1>
      <div class="date">${escapeHtml(today)}</div>
    </header>

    ${error ? `<div class="error"><strong>Chyba načítania menu:</strong><br>${escapeHtml(error)}</div>` : ''}
    ${!error && items.length === 0 ? `<div class="empty">Na dnešný deň zatiaľ nie je v databáze žiadne menu.</div>` : ''}
    ${!error ? groupsHtml : ''}

    <footer>
      Dáta načítané z PostgreSQL tabuľky <code>lunch_menu_items</code>. Import zabezpečuje n8n.
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
