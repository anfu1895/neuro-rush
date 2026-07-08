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
const duel = require('./duel');
const shop = require('./shop');

const HTTP_PORT = Number(process.env.PORT) || 3004;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
const HOST = '0.0.0.0';
const ROOT = __dirname;

console.log(`Música   → Jamendo ${process.env.JAMENDO_CLIENT_ID ? 'activado' : 'sin JAMENDO_CLIENT_ID'}`);

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
const GETSONGBPM_API_KEY = process.env.GETSONGBPM_API_KEY || '';
const JAMENDO_CLIENT_ID = process.env.JAMENDO_CLIENT_ID || '';

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

  if (request.method === 'GET' && pathname === '/api/rhythm-audio') {
    return handleRhythmAudio(query, response);
  }

  if (request.method === 'GET' && pathname === '/api/rhythm-songs') {
    return handleRhythmSongs(query, response);
  }

  // Tienda y pagos: maneja sus propios bodies (el webhook de Stripe
  // necesita el body crudo para verificar la firma)
  if (pathname === '/api/wallet' || pathname.startsWith('/api/shop/') || pathname === '/api/stripe/webhook') {
    return shop.handle(request, response, pathname, query);
  }

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

function isAllowedRhythmAudioUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' && (
      parsed.hostname === 'usercontent.jamendo.com' ||
      parsed.hostname.endsWith('.jamendo.com')
    );
  } catch {
    return false;
  }
}

function proxyAudio(rawUrl, response, redirectsLeft = 3) {
  if (!isAllowedRhythmAudioUrl(rawUrl)) {
    response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'invalid_audio_url' }));
    return;
  }

  const req = https.get(rawUrl, upstream => {
    const redirect = upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location;
    if (redirect && redirectsLeft > 0) {
      upstream.resume();
      const nextUrl = new URL(upstream.headers.location, rawUrl).toString();
      proxyAudio(nextUrl, response, redirectsLeft - 1);
      return;
    }

    if ((upstream.statusCode || 0) >= 400) {
      upstream.resume();
      response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'audio_unavailable' }));
      return;
    }

    response.writeHead(200, {
      'Content-Type': upstream.headers['content-type'] || 'audio/mpeg',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*'
    });
    upstream.pipe(response);
  });

  req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  req.on('error', () => {
    if (!response.headersSent) {
      response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    response.end(JSON.stringify({ error: 'audio_proxy_error' }));
  });
}

function handleRhythmAudio(query, response) {
  const params = new URLSearchParams(query || '');
  const audioUrl = String(params.get('url') || '');
  proxyAudio(audioUrl, response);
}

function requestJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 0, data: JSON.parse(data || '{}') });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function handleRhythmSongs(query, response) {
  const params = new URLSearchParams(query || '');
  const lookup = String(params.get('q') || '').trim().slice(0, 80);
  if (lookup.length < 2) return sendJson(response, 200, { songs: [] });

  if (JAMENDO_CLIENT_ID) {
    try {
      const baseJamendoUrl = [
        'https://api.jamendo.com/v3.0/tracks/',
        `?client_id=${encodeURIComponent(JAMENDO_CLIENT_ID)}`,
        '&format=json&limit=12&audioformat=mp31&include=musicinfo',
        '&type=single%20albumtrack&order=relevance'
      ].join('');

      const jamendoQueries = [
        `${baseJamendoUrl}&search=${encodeURIComponent(lookup)}`,
        `${baseJamendoUrl}&namesearch=${encodeURIComponent(lookup)}`,
        `${baseJamendoUrl}&artist_name=${encodeURIComponent(lookup)}`
      ];

      const foundSongs = new Map();
      let hasSuccessfulSearch = false;

      for (const apiUrl of jamendoQueries) {
        const result = await requestJson(apiUrl);
        if (result.status < 200 || result.status >= 300 || result.data.headers?.status === 'failed') {
          continue;
        }

        hasSuccessfulSearch = true;
        for (const song of (result.data.results || [])) {
          if (!song || !song.name || !song.audio) continue;
          foundSongs.set(String(song.audio), song);
        }
      }

      if (!hasSuccessfulSearch) {
        return sendJson(response, 502, { error: 'jamendo_error' });
      }

      const songs = [...foundSongs.values()]
        .map(song => {
          const rawAudio = String(song.audio);
          return {
            title: String(song.name),
            artist: String(song.artist_name || 'Unknown artist'),
            bpm: null,
            audio: `/api/rhythm-audio?url=${encodeURIComponent(rawAudio)}`,
            sourceAudio: rawAudio,
            image: String(song.album_image || song.image || ''),
            source: String(song.shareurl || 'https://www.jamendo.com/'),
            provider: 'Jamendo'
          };
        });

      return sendJson(response, 200, { songs, provider: 'jamendo' });
    } catch (error) {
      console.error('Jamendo API error:', error.message);
      return sendJson(response, 502, { error: 'jamendo_unavailable' });
    }
  }

  if (!GETSONGBPM_API_KEY) {
    return sendJson(response, 503, { error: 'missing_music_api_key' });
  }

  try {
    const apiUrl = `https://api.getsong.co/search/?type=song&limit=12&lookup=${encodeURIComponent(lookup)}`;
    const result = await requestJson(apiUrl, { 'X-API-KEY': GETSONGBPM_API_KEY });
    if (result.status < 200 || result.status >= 300) {
      return sendJson(response, 502, { error: 'getsongbpm_error' });
    }

    const songs = (result.data.search || [])
      .filter(song => song && song.title && song.tempo)
      .map(song => ({
        title: String(song.title),
        artist: String((song.artist && song.artist.name) || 'Unknown artist'),
        bpm: Math.round(Number(song.tempo)),
        audio: '',
        source: String(song.uri || 'https://getsongbpm.com/'),
        provider: 'GetSongBPM'
      }))
      .filter(song => Number.isFinite(song.bpm) && song.bpm > 0);

    return sendJson(response, 200, { songs });
  } catch (error) {
    console.error('GetSongBPM API error:', error.message);
    return sendJson(response, 502, { error: 'getsongbpm_unavailable' });
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

const httpServer = http.createServer(handler);
duel.attach(httpServer);
httpServer.listen(HTTP_PORT, HOST, () => {
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

  const httpsServer = https.createServer(options, handler);
  duel.attach(httpsServer);
  httpsServer.listen(HTTPS_PORT, HOST, () => {
    console.log(`PC HTTPS → https://localhost:${HTTPS_PORT}`);
    printPhoneUrls('https', HTTPS_PORT);
  });
} else {
  console.log('HTTPS no disponible: faltan cert/key.pem y cert/cert.pem.');
}
