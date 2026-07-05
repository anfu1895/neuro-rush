/*
  Neuro Rush local server
  Copyright © 2026 Angel Fuentes. All rights reserved.

  Run with: npm start
*/

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('./db');

const HTTP_PORT = Number(process.env.PORT) || 3004;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
const HOST = '0.0.0.0';
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon'
};

// ---------- API JSON (jugadores y récords) ----------

const NAME_RE = /^[\p{L}\p{N}_\-]{3,16}$/u;
const MODES = new Set(['classic', 'power']);
const MAX_SCORE = 200000; // tope de cordura contra puntajes absurdos
const MAX_BODY = 10 * 1024;

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', chunk => {
      data += chunk;
      if (data.length > MAX_BODY) {
        reject(new Error('body_too_large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { reject(new Error('bad_json')); }
    });
    request.on('error', reject);
  });
}

async function handleApi(request, response) {
  const [pathname, query] = request.url.split('?');

  if (!db.enabled()) {
    sendJson(response, 503, { error: 'db_disabled' });
    return;
  }

  try {
    if (request.method === 'POST' && pathname === '/api/register') {
      const body = await readJsonBody(request);
      const name = String(body.name || '').trim();
      if (!NAME_RE.test(name)) return sendJson(response, 400, { error: 'invalid_name' });
      const result = await db.registerPlayer(name);
      if (result.error) return sendJson(response, 409, result);
      return sendJson(response, 201, result);
    }

    if (request.method === 'POST' && pathname === '/api/score') {
      const body = await readJsonBody(request);
      const score = Math.floor(Number(body.score));
      if (!MODES.has(body.mode) || !Number.isFinite(score) || score < 0 || score > MAX_SCORE) {
        return sendJson(response, 400, { error: 'invalid_score' });
      }
      const result = await db.saveScore(String(body.playerId || ''), body.mode, score);
      if (result.error) return sendJson(response, 400, result);
      return sendJson(response, 201, result);
    }

    if (request.method === 'GET' && pathname === '/api/leaderboard') {
      const mode = new URLSearchParams(query || '').get('mode');
      if (!MODES.has(mode)) return sendJson(response, 400, { error: 'invalid_mode' });
      return sendJson(response, 200, { top: await db.leaderboard(mode) });
    }

    return sendJson(response, 404, { error: 'not_found' });
  } catch (error) {
    const message = error && error.message;
    if (message === 'bad_json' || message === 'body_too_large') {
      return sendJson(response, 400, { error: message });
    }
    console.error('Error de API:', error);
    return sendJson(response, 500, { error: 'server_error' });
  }
}

function handler(request, response) {
  if (request.url.startsWith('/api/')) {
    handleApi(request, response);
    return;
  }

  let url;

  try {
    url = decodeURIComponent(request.url.split('?')[0]);
  } catch {
    response.writeHead(400);
    response.end('Solicitud inválida');
    return;
  }

  if (url === '/') url = '/index.html';

  const relativePath = path.normalize(url).replace(/^([/\\])+/u, '');
  const filePath = path.resolve(ROOT, relativePath);

  if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${path.sep}`)) {
    response.writeHead(403);
    response.end('Prohibido');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end('No encontrado');
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      'Content-Type': MIME[extension] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    response.end(data);
  });
}

function localIPv4Addresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(address => address && address.family === 'IPv4' && !address.internal)
    .map(address => address.address);
}

function printPhoneUrls(protocol, port) {
  const addresses = localIPv4Addresses();

  if (!addresses.length) {
    console.log('No se encontró una dirección IPv4 local. Verifica tu conexión WiFi.');
    return;
  }

  for (const address of addresses) {
    console.log(`Celular  → ${protocol}://${address}:${port}`);
  }
}

db.init()
  .then(ok => {
    console.log(ok
      ? 'BD       → MySQL conectada, tablas listas'
      : 'BD       → sin DATABASE_URL: récords globales desactivados');
  })
  .catch(error => {
    console.error(`BD       → error de conexión: ${error.message}. Récords desactivados.`);
  });

http.createServer(handler).listen(HTTP_PORT, HOST, () => {
  console.log(`PC       → http://localhost:${HTTP_PORT}`);
  printPhoneUrls('http', HTTP_PORT);
});

const keyPath = path.join(ROOT, 'cert', 'key.pem');
const certPath = path.join(ROOT, 'cert', 'cert.pem');

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  const options = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  };

  https.createServer(options, handler).listen(HTTPS_PORT, HOST, () => {
    console.log(`PC HTTPS → https://localhost:${HTTPS_PORT}`);
    printPhoneUrls('https', HTTPS_PORT);
  });
} else {
  console.log('HTTPS no disponible: faltan cert/key.pem y cert/cert.pem.');
}
