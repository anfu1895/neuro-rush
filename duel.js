/*
  ============================================================
  NEURO RUSH ⚡ — Duelo online 1v1 (WebSocket)
  Copyright © 2026 Angel Fuentes. Todos los derechos reservados.
  ============================================================

  Protocolo (JSON, campo "t" = tipo):

  Cliente → Servidor:
    hello    {playerId, name}   identificación (obligatoria primero)
    quick                       entrar a la cola de partida rápida
    create                      crear sala privada (devuelve código)
    join     {code}             unirse a una sala por código
    cancel                      salir de la cola / cancelar sala
    score    {value}            puntaje propio (se reenvía al rival)
    sabotage {kind}             freeze | bombs | storm
    final    {score}            puntaje final al terminar el tiempo
    rematch                     pedir revancha

  Servidor → Cliente:
    queued                      esperando rival en la cola
    room     {code}             sala creada, comparte el código
    matched  {seed, duration, opponent:{name}}
    opp_score{value}            puntaje del rival en vivo
    sabotaged{kind, from}       el rival te atacó
    rematch_wait                el rival ya pidió revancha
    result   {you, opp, outcome, forfeit?}   win | lose | tie
    opp_left                    el rival se desconectó
    error    {code}             room_not_found | room_full | not_registered
*/

const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const db = require('./db');

const DUEL_MS = 65000;
const MAX_SCORE = 200000;
const SABOTAGE_KINDS = new Set(['freeze', 'bombs', 'storm']);
const MAX_SABOTAGES_PER_MATCH = 12; // freno de cordura contra spam
// Sin caracteres confundibles (I, L, O, 0, 1)
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ';

const wss = new WebSocketServer({ noServer: true });
const queue = [];
const rooms = new Map(); // code -> room

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function partnerOf(room, ws) {
  return room.players.find(p => p !== ws);
}

function removeFromQueue(ws) {
  const i = queue.indexOf(ws);
  if (i !== -1) queue.splice(i, 1);
}

function leaveRoom(ws, notifyPartner) {
  const room = ws.meta.room;
  if (!room) return;
  const partner = partnerOf(room, ws);

  // Abandono en pleno duelo → derrota por abandono
  if (room.startedAt && !room.finished && room.players.length === 2) {
    finishMatch(room, ws);
  } else if (partner && notifyPartner) {
    send(partner, { t: 'opp_left' });
  }

  room.players = room.players.filter(p => p !== ws);
  ws.meta.room = null;
  if (partner && room.finished) send(partner, { t: 'opp_left' });
  if (!room.players.length) rooms.delete(room.code);
}

function startMatch(room) {
  room.seed = crypto.randomInt(2 ** 31);
  room.startedAt = Date.now();
  room.finished = false;
  room.finals = new Map();
  room.rematch = new Set();
  if (room.finalTimer) { clearTimeout(room.finalTimer); room.finalTimer = null; }

  for (const ws of room.players) {
    ws.meta.lastScore = 0;
    ws.meta.sabotages = 0;
    const opp = partnerOf(room, ws);
    send(ws, {
      t: 'matched',
      seed: room.seed,
      duration: DUEL_MS,
      opponent: { name: opp.meta.name }
    });
  }
}

function finishMatch(room, forfeiter) {
  if (room.finished) return;
  room.finished = true;
  if (room.finalTimer) { clearTimeout(room.finalTimer); room.finalTimer = null; }

  const [a, b] = room.players;
  const scoreA = room.finals.has(a) ? room.finals.get(a) : (a.meta.lastScore || 0);
  const scoreB = room.finals.has(b) ? room.finals.get(b) : (b.meta.lastScore || 0);

  let winner = null;
  if (forfeiter) winner = partnerOf(room, forfeiter);
  else if (scoreA > scoreB) winner = a;
  else if (scoreB > scoreA) winner = b;

  const forfeit = !!forfeiter;
  for (const ws of room.players) {
    const mine = ws === a ? scoreA : scoreB;
    const theirs = ws === a ? scoreB : scoreA;
    const outcome = winner === null ? 'tie' : (winner === ws ? 'win' : 'lose');
    send(ws, { t: 'result', you: mine, opp: theirs, outcome, forfeit });
  }

  if (db.enabled()) {
    db.saveMatch(
      a.meta.playerId, b.meta.playerId,
      Math.min(scoreA, MAX_SCORE), Math.min(scoreB, MAX_SCORE),
      winner ? winner.meta.playerId : null
    ).catch(err => console.error('No se pudo guardar el match:', err.message));
  }
}

function handleMessage(ws, msg) {
  const meta = ws.meta;

  if (msg.t === 'hello') {
    meta.playerId = String(msg.playerId || '');
    meta.name = String(msg.name || '').slice(0, 16);
    return;
  }
  if (!meta.playerId) return send(ws, { t: 'error', code: 'not_registered' });

  switch (msg.t) {
    case 'quick': {
      removeFromQueue(ws);
      // Buscar un rival vivo en la cola
      let other = null;
      while (queue.length && !other) {
        const cand = queue.shift();
        if (cand !== ws && cand.readyState === 1) other = cand;
      }
      if (!other) { queue.push(ws); return send(ws, { t: 'queued' }); }
      const room = { code: makeCode(), players: [other, ws], startedAt: 0, finished: false };
      rooms.set(room.code, room);
      other.meta.room = room;
      ws.meta.room = room;
      startMatch(room);
      break;
    }

    case 'create': {
      leaveRoom(ws, true);
      removeFromQueue(ws);
      const room = { code: makeCode(), players: [ws], startedAt: 0, finished: false };
      rooms.set(room.code, room);
      meta.room = room;
      send(ws, { t: 'room', code: room.code });
      break;
    }

    case 'join': {
      const code = String(msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { t: 'error', code: 'room_not_found' });
      if (room.players.length >= 2) return send(ws, { t: 'error', code: 'room_full' });
      leaveRoom(ws, true);
      removeFromQueue(ws);
      room.players.push(ws);
      meta.room = room;
      startMatch(room);
      break;
    }

    case 'cancel':
      removeFromQueue(ws);
      leaveRoom(ws, true);
      break;

    case 'score': {
      const value = Math.floor(Number(msg.value));
      if (!Number.isFinite(value) || value < 0 || value > MAX_SCORE) return;
      meta.lastScore = value;
      const room = meta.room;
      if (room && !room.finished) {
        const partner = partnerOf(room, ws);
        if (partner) send(partner, { t: 'opp_score', value });
      }
      break;
    }

    case 'sabotage': {
      const room = meta.room;
      if (!room || room.finished || !SABOTAGE_KINDS.has(msg.kind)) return;
      if (++meta.sabotages > MAX_SABOTAGES_PER_MATCH) return;
      const partner = partnerOf(room, ws);
      if (partner) send(partner, { t: 'sabotaged', kind: msg.kind, from: meta.name });
      break;
    }

    case 'final': {
      const room = meta.room;
      if (!room || room.finished || !room.startedAt) return;
      const value = Math.floor(Number(msg.score));
      room.finals.set(ws, (Number.isFinite(value) && value >= 0) ? Math.min(value, MAX_SCORE) : 0);
      if (room.finals.size >= 2) finishMatch(room);
      else if (!room.finalTimer) {
        // Si el rival nunca reporta, cerramos con su último puntaje conocido
        room.finalTimer = setTimeout(() => finishMatch(room), 8000);
      }
      break;
    }

    case 'rematch': {
      const room = meta.room;
      if (!room || !room.finished || room.players.length < 2) return;
      room.rematch.add(ws);
      const partner = partnerOf(room, ws);
      if (room.rematch.size >= 2) startMatch(room);
      else if (partner) send(partner, { t: 'rematch_wait' });
      break;
    }
  }
}

wss.on('connection', (ws) => {
  ws.meta = { playerId: null, name: '', room: null, lastScore: 0, sabotages: 0 };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try { handleMessage(ws, msg); }
    catch (err) { console.error('Error en mensaje de duelo:', err.message); }
  });

  ws.on('close', () => {
    removeFromQueue(ws);
    leaveRoom(ws, true);
  });
});

// Latido: expulsa conexiones muertas (y evita que el hosting las duerma)
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

function attach(server) {
  server.on('upgrade', (request, socket, head) => {
    if (!request.url.startsWith('/ws')) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });
}

module.exports = { attach };
