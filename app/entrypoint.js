const http = require('http');
const fs = require('fs');
const path = require('path');

const faviconPath = path.join(__dirname, 'favicon.svg');
const faviconSvg = fs.readFileSync(faviconPath, 'utf8');
const faviconLink = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';

const originalCreateServer = http.createServer;

http.createServer = function createServerWithFavicon(listener) {
  return originalCreateServer(function faviconAwareListener(req, res) {
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
    res.end = function endWithFaviconLink(chunk, encoding, callback) {
      const contentType = String(res.getHeader('content-type') || '').toLowerCase();

      if (chunk && contentType.includes('text/html')) {
        const body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);

        if (body.includes('</head>') && !body.includes('href="/favicon.svg"')) {
          return originalEnd(body.replace('</head>', `  ${faviconLink}\n</head>`), encoding, callback);
        }
      }

      return originalEnd(chunk, encoding, callback);
    };

    return listener(req, res);
  });
};

require('./server');
