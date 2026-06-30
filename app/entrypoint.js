const http = require('http');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const faviconPath = path.join(__dirname, 'favicon.svg');
const faviconSvg = fs.readFileSync(faviconPath, 'utf8');
const faviconLink = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';

const adminCssPath = path.join(__dirname, 'admin-enhancements.css');
const adminJsPath = path.join(__dirname, 'admin-enhancements.js');
const adminCss = fs.existsSync(adminCssPath) ? fs.readFileSync(adminCssPath, 'utf8') : '';
const adminJs = fs.existsSync(adminJsPath) ? fs.readFileSync(adminJsPath, 'utf8') : '';
const adminCssBlock = `<style id="admin-tabs-enhancements-css">\n${adminCss}\n</style>`;
const adminJsBlock = `<script id="admin-tabs-enhancements-js">\n${adminJs}\n</script>`;

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const dbConfig = {
  host: process.env.DB_HOST || 'obedove-menu-db',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'obedove_menu',
  user: process.env.DB_USER || 'obedove_menu_user',
  password: process.env.DB_PASSWORD || '',
};

const publicLocationOrderJs = `<script id="public-location-order-js">
(function(){
  function ready(fn){document.readyState==='loading'?document.addEventListener('DOMContentLoaded',fn):fn();}
  function text(el){return (el&&el.textContent?el.textContent:'').trim();}
  ready(function(){
    var content=document.querySelector('section.content');
    if(!content)return;
    fetch('/location-order.json',{cache:'no-store'})
      .then(function(res){return res.ok?res.json():{order:{}};})
      .then(function(data){
        var order=data.order||{};
        var groups=[];
        var titles=Array.prototype.slice.call(content.querySelectorAll('h2.location-title'));
        titles.forEach(function(title){
          var nodes=[title];
          var next=title.nextElementSibling;
          while(next && !(next.matches&&next.matches('h2.location-title'))){
            nodes.push(next);
            next=next.nextElementSibling;
          }
          var location=text(title);
          groups.push({location:location,weight:Number(order[location]||100),nodes:nodes});
        });
        if(!groups.length)return;
        groups.sort(function(a,b){return a.weight-b.weight||a.location.localeCompare(b.location,'sk');});
        groups.forEach(function(group){group.nodes.forEach(function(node){content.appendChild(node);});});
      })
      .catch(function(){});
  });
})();
</script>`;

function parseCookies(req) {
  return String(req.headers.cookie || '').split(';').reduce((acc, part) => {
    const [k, ...r] = part.trim().split('=');
    if (k) acc[k] = decodeURIComponent(r.join('=') || '');
    return acc;
  }, {});
}

function isAdminRequest(req) {
  return ADMIN_TOKEN && parseCookies(req).lunch_admin_token === ADMIN_TOKEN;
}

function readBody(req, limit = 1024 * 64) {
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

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function newClient() {
  return new Client(dbConfig);
}

async function ensureLocationOrderSchema(client) {
  await client.query(`ALTER TABLE public.lunch_sources ADD COLUMN IF NOT EXISTS source_location_order INTEGER NOT NULL DEFAULT 100`);
  await client.query(`UPDATE public.lunch_sources SET source_location_order = 10 WHERE source_location = 'Praca' AND source_location_order = 100`);
  await client.query(`UPDATE public.lunch_sources SET source_location_order = 20 WHERE source_location = 'Karlovka' AND source_location_order = 100`);
  await client.query(`UPDATE public.lunch_sources SET source_location_order = 30 WHERE source_location = 'Stupava' AND source_location_order = 100`);
}

async function getLocationOrder() {
  const client = newClient();
  await client.connect();
  try {
    await ensureLocationOrderSchema(client);
    const result = await client.query(`
      SELECT COALESCE(source_location, 'Praca') AS source_location, MIN(source_location_order)::int AS display_order
      FROM public.lunch_sources
      GROUP BY COALESCE(source_location, 'Praca')
      ORDER BY MIN(source_location_order), COALESCE(source_location, 'Praca')
    `);
    const order = {};
    for (const row of result.rows) order[row.source_location] = Number(row.display_order || 100);
    return order;
  } finally {
    await client.end();
  }
}

async function updateLocationOrder(sourceLocation, displayOrder) {
  const location = String(sourceLocation || '').trim();
  const weight = Number(displayOrder);
  if (!location) throw new Error('Lokalita je povinná.');
  if (!Number.isInteger(weight) || weight < 1) throw new Error('Váha musí byť celé číslo 1 alebo vyššie.');
  const client = newClient();
  await client.connect();
  try {
    await ensureLocationOrderSchema(client);
    await client.query(`
      UPDATE public.lunch_sources
      SET source_location_order = $2, updated_at = NOW()
      WHERE COALESCE(source_location, 'Praca') = $1
    `, [location, weight]);
  } finally {
    await client.end();
  }
}

const originalCreateServer = http.createServer;

http.createServer = function createServerWithEnhancements(listener) {
  return originalCreateServer(async function enhancedListener(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/favicon.svg') {
      res.writeHead(200, {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'public, max-age=604800',
      });
      res.end(faviconSvg);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/location-order.json') {
      try {
        return sendJson(res, 200, { ok: true, order: await getLocationOrder() });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/admin/location-order/update') {
      if (!isAdminRequest(req)) return sendJson(res, 401, { ok: false, error: 'Neautorizovaný prístup' });
      try {
        const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
        await updateLocationOrder(form.source_location, form.display_order);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    const originalEnd = res.end.bind(res);
    res.end = function endWithEnhancements(chunk, encoding, callback) {
      const contentType = String(res.getHeader('content-type') || '').toLowerCase();

      if (chunk && contentType.includes('text/html')) {
        let body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);

        if (body.includes('</head>') && !body.includes('href="/favicon.svg"')) {
          body = body.replace('</head>', `  ${faviconLink}\n</head>`);
        }

        if (req.method === 'GET' && url.pathname === '/admin') {
          if (adminCss && body.includes('</head>') && !body.includes('admin-tabs-enhancements-css')) {
            body = body.replace('</head>', `  ${adminCssBlock}\n</head>`);
          }
          if (adminJs && body.includes('</body>') && !body.includes('admin-tabs-enhancements-js')) {
            body = body.replace('</body>', `  ${adminJsBlock}\n</body>`);
          }
        }

        if (req.method === 'GET' && url.pathname === '/') {
          body = body.replace(/\s*<p class="hero-subtitle">Prehľad obedov zo všetkých tvojich zdrojov na jednom mieste\. Dáta importuje n8n a stránka číta priamo z PostgreSQL\.<\/p>/, '');
          if (body.includes('</body>') && !body.includes('public-location-order-js')) {
            body = body.replace('</body>', `  ${publicLocationOrderJs}\n</body>`);
          }
        }

        return originalEnd(body, encoding, callback);
      }

      return originalEnd(chunk, encoding, callback);
    };

    return listener(req, res);
  });
};

require('./server');
