const http = require('http');
const fs = require('fs');
const path = require('path');

const faviconPath = path.join(__dirname, 'favicon.svg');
const faviconSvg = fs.readFileSync(faviconPath, 'utf8');
const faviconLink = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';

const adminRestaurantCss = `<style id="admin-restaurant-table-css">
  .compact-restaurants-card{overflow:hidden}
  .compact-restaurants-card>p.muted{margin-bottom:12px}
  .restaurants-table{width:100%;border:1px solid var(--border);border-radius:16px;overflow:hidden;background:#fff}
  .restaurants-table-header,.compact-restaurant-row{display:grid;grid-template-columns:1.35fr 1.7fr 160px 52px;gap:0;align-items:center}
  .restaurants-table-header{background:#f9fafb;color:#6b7280;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid var(--border)}
  .restaurants-table-header>div,.compact-restaurant-row>div{padding:10px 12px;border-right:1px solid var(--border)}
  .restaurants-table-header>div:last-child,.compact-restaurant-row>div:last-child{border-right:0;text-align:center}
  .compact-restaurant-row{margin:0;border:0;border-radius:0;box-shadow:none;background:#fff;border-bottom:1px solid var(--border)}
  .compact-restaurant-row:last-child{border-bottom:0}
  .compact-restaurant-name strong{display:block;font-size:14px;line-height:1.2}
  .compact-restaurant-type{color:#6b7280;font-size:13px;line-height:1.3;word-break:break-word}
  .location-badge{display:inline-flex;align-items:center;min-height:32px;padding:7px 10px;border-radius:999px;background:#dcfce7;color:#166534;font-size:13px;font-weight:900;line-height:1.1}
  .compact-restaurant-location select{display:none;min-height:36px;padding:8px 10px;border-radius:12px;font-size:14px;text-transform:none;letter-spacing:0}
  .compact-restaurant-row.is-editing .location-badge{display:none}
  .compact-restaurant-row.is-editing .compact-restaurant-location select{display:block}
  .restaurant-edit-button{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;min-width:36px;min-height:36px;padding:0;border-radius:999px;background:#111827;color:#fff;font-size:16px;line-height:1;text-decoration:none}
  .compact-restaurant-row.is-editing .restaurant-edit-button{background:#16a34a;font-size:15px}
  @media(max-width:720px){.restaurants-table-header{display:none}.compact-restaurant-row{grid-template-columns:1fr 44px;gap:0}.compact-restaurant-row>div{border-right:0}.compact-restaurant-name{padding-bottom:3px}.compact-restaurant-type{grid-column:1/2;padding-top:0;font-size:12px}.compact-restaurant-location{grid-column:1/2;padding-top:4px}.compact-restaurant-action{grid-column:2/3;grid-row:1/4;align-self:center}.location-badge{min-height:30px}.compact-restaurant-location select{max-width:220px}}
</style>`;

const adminRestaurantJs = `<script id="admin-restaurant-table-js">
(function(){
  function ready(fn){document.readyState==='loading'?document.addEventListener('DOMContentLoaded',fn):fn();}
  ready(function(){
    var cards=[].slice.call(document.querySelectorAll('section.card'));
    var card=cards.find(function(c){var h=c.querySelector('h2');return h&&h.textContent.trim()==='Reštaurácie a lokality';});
    if(!card||card.classList.contains('compact-restaurants-card'))return;
    var forms=[].slice.call(card.querySelectorAll('form.restaurant-row'));
    if(!forms.length)return;
    card.classList.add('compact-restaurants-card');
    var table=document.createElement('div');
    table.className='restaurants-table';
    table.innerHTML='<div class="restaurants-table-header"><div>Názov</div><div>Typ</div><div>Lokalita</div><div></div></div>';
    forms.forEach(function(form){
      var hidden=form.querySelector('input[name="source_id"]');
      var sourceId=hidden?hidden.value:'';
      var oldInfo=form.querySelector('div');
      var name=oldInfo&&oldInfo.querySelector('strong')?oldInfo.querySelector('strong').textContent.trim():sourceId;
      var typeText=oldInfo&&oldInfo.querySelector('small')?oldInfo.querySelector('small').textContent.trim():sourceId;
      var select=form.querySelector('select[name="source_location"]');
      var oldButton=form.querySelector('button');
      var selected=select&&select.options[select.selectedIndex]?select.options[select.selectedIndex].textContent.trim():'Praca';
      form.className='compact-restaurant-row';
      form.innerHTML='';
      if(hidden)form.appendChild(hidden);
      var c1=document.createElement('div');c1.className='compact-restaurant-name';c1.innerHTML='<strong></strong>';c1.querySelector('strong').textContent=name;
      var c2=document.createElement('div');c2.className='compact-restaurant-type';c2.textContent=typeText;
      var c3=document.createElement('div');c3.className='compact-restaurant-location';
      var badge=document.createElement('span');badge.className='location-badge';badge.textContent=selected;
      c3.appendChild(badge);if(select)c3.appendChild(select);
      var c4=document.createElement('div');c4.className='compact-restaurant-action';
      var button=oldButton||document.createElement('button');
      button.type='button';button.className='restaurant-edit-button';button.textContent='✏️';button.title='Zmeniť lokalitu';button.setAttribute('aria-label','Zmeniť lokalitu pre '+name);
      button.addEventListener('click',function(){
        if(!form.classList.contains('is-editing')){form.classList.add('is-editing');button.type='submit';button.textContent='💾';button.title='Uložiť lokalitu';if(select)select.focus();}
      });
      c4.appendChild(button);
      form.appendChild(c1);form.appendChild(c2);form.appendChild(c3);form.appendChild(c4);
      table.appendChild(form);
    });
    card.appendChild(table);
  });
})();
</script>`;

const originalCreateServer = http.createServer;

http.createServer = function createServerWithEnhancements(listener) {
  return originalCreateServer(function enhancedListener(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/favicon.svg') {
      res.writeHead(200, {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'public, max-age=604800',
      });
      res.end(faviconSvg);
      return;
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
          if (body.includes('</head>') && !body.includes('admin-restaurant-table-css')) {
            body = body.replace('</head>', `  ${adminRestaurantCss}\n</head>`);
          }
          if (body.includes('</body>') && !body.includes('admin-restaurant-table-js')) {
            body = body.replace('</body>', `  ${adminRestaurantJs}\n</body>`);
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
