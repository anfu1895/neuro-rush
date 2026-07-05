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

function handler(request, response) {
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
