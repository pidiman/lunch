const http = require('http');
const fs = require('fs');
const path = require('path');

const faviconPath = path.join(__dirname, 'favicon.svg');
const faviconSvg = fs.readFileSync(faviconPath, 'utf8');
const faviconLink = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';

const adminCssPath = path.join(__dirname, 'admin-enhancements.css');
const adminJsPath = path.join(__dirname, 'admin-enhancements.js');
const adminCss = fs.existsSync(adminCssPath) ? fs.readFileSync(adminCssPath, 'utf8') : '';
const adminJs = fs.existsSync(adminJsPath) ? fs.readFileSync(adminJsPath, 'utf8') : '';
const adminCssBlock = `<style id="admin-tabs-enhancements-css">\n${adminCss}\n</style>`;
const adminJsBlock = `<script id="admin-tabs-enhancements-js">\n${adminJs}\n</script>`;

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
          if (adminCss && body.includes('</head>') && !body.includes('admin-tabs-enhancements-css')) {
            body = body.replace('</head>', `  ${adminCssBlock}\n</head>`);
          }
          if (adminJs && body.includes('</body>') && !body.includes('admin-tabs-enhancements-js')) {
            body = body.replace('</body>', `  ${adminJsBlock}\n</body>`);
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
