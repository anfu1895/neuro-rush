const http = require('node:http');
const { readFile } = require('node:fs/promises');
const { networkInterfaces } = require('node:os');
const path = require('node:path');

const host = '0.0.0.0';
const port = Number(process.env.PORT) || 3004;
const indexPath = path.join(__dirname, 'index.html');

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (requestUrl.pathname !== '/' && requestUrl.pathname !== '/index.html') {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  try {
    const html = await readFile(indexPath);
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    response.end(html);
  } catch (error) {
    console.error(error);
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Could not load index.html');
  }
});

server.listen(port, host, () => {
  console.log(`Neuro Rush is running at http://localhost:${port}`);

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) {
        console.log(`Open on your phone: http://${address.address}:${port}`);
      }
    }
  }

  console.log('Keep this terminal open. Press Ctrl+C to stop the server.');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Try: $env:PORT=3001; npm start`);
    process.exitCode = 1;
    return;
  }

  throw error;
});
