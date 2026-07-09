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

const DUEL_MS = 90000; // tope de tiempo (guarda): si nadie llena la barra, gana quien esté adelante

// ---------- Barra tug-of-war ----------
// pull 0..100 desde la perspectiva del jugador A (50 = empate).
// Llega a 100 → gana A; llega a 0 → gana B.
const TUG_SENS = 0.06;     // % de barra por punto
const TUG_BAND_MAX = 1.3;  // empuje cuando vas MUY atrás (rubber-banding)
const TUG_BAND_MIN = 0.4;  // empuje en la zona final (dura): cuesta cerrar
function tugMove(pull, pts, forA) {
  if (forA) {
    const band = Math.max(TUG_BAND_MIN, TUG_BAND_MAX - pull / 100);
    return Math.min(100, pull + pts * TUG_SENS * band);
  }
  const band = Math.max(TUG_BAND_MIN, TUG_BAND_MAX - (100 - pull) / 100);
  return Math.max(0, pull - pts * TUG_SENS * band);
}
const MAX_SCORE = 200000;
const SABOTAGE_KINDS = new Set(['freeze', 'bombs', 'storm', 'raybomb']);
const EMOTES = new Set(['😂', '🔥', '😱', '👏', '😎', '💀']);
const MAX_EMOTES_PER_MATCH = 15;
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
  room.pull = 50; // barra tug-of-war centrada
  if (room.finalTimer) { clearTimeout(room.finalTimer); room.finalTimer = null; }

  for (const ws of room.players) {
    ws.meta.lastScore = 0;
    ws.meta.prevScore = 0;
    ws.meta.sabotages = 0;
    ws.meta.emotesSent = 0;
    const opp = partnerOf(room, ws);
    send(ws, {
      t: 'matched',
      seed: room.seed,
      duration: DUEL_MS,
      opponent: { name: opp.meta.name }
    });
  }
}

function finishMatch(room, forfeiter, tugWinner, reason) {
  if (room.finished) return;
  room.finished = true;
  if (room.finalTimer) { clearTimeout(room.finalTimer); room.finalTimer = null; }

  const [a, b] = room.players;
  const scoreA = room.finals.has(a) ? room.finals.get(a) : (a.meta.lastScore || 0);
  const scoreB = room.finals.has(b) ? room.finals.get(b) : (b.meta.lastScore || 0);
  const pull = room.pull == null ? 50 : room.pull;

  let winner = null;
  if (forfeiter) winner = partnerOf(room, forfeiter);
  else if (tugWinner) winner = tugWinner;   // llenó la barra
  else if (pull > 50) winner = a;           // tope de tiempo: gana quien va adelante
  else if (pull < 50) winner = b;

  const forfeit = !!forfeiter;
  const why = reason || (forfeit ? 'forfeit' : 'time');
  for (const ws of room.players) {
    const mine = ws === a ? scoreA : scoreB;
    const theirs = ws === a ? scoreB : scoreA;
    const outcome = winner === null ? 'tie' : (winner === ws ? 'win' : 'lose');
    send(ws, { t: 'result', you: mine, opp: theirs, outcome, forfeit, reason: why, pull: ws === a ? pull : 100 - pull });
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
      const room = meta.room;
      const delta = value - (meta.prevScore || 0);
      meta.prevScore = value;
      meta.lastScore = value;
      if (room && !room.finished) {
        const partner = partnerOf(room, ws);
        if (partner) send(partner, { t: 'opp_score', value });
        // Tug-of-war: cada punto empuja la barra (con rubber-banding en tugMove)
        if (room.startedAt && delta > 0) {
          const [a, b] = room.players;
          room.pull = tugMove(room.pull, delta, ws === a);
          send(a, { t: 'tug', me: room.pull });
          send(b, { t: 'tug', me: 100 - room.pull });
          if (room.pull >= 100) return finishMatch(room, null, a, 'filled');
          if (room.pull <= 0) return finishMatch(room, null, b, 'filled');
        }
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

    case 'emote': {
      // Burla comprada en tienda: se reenvía tal cual (con freno anti-spam)
      const room = meta.room;
      if (!room || !EMOTES.has(msg.e)) return;
      meta.emotesSent = (meta.emotesSent || 0) + 1;
      if (meta.emotesSent > MAX_EMOTES_PER_MATCH) return;
      const partner = partnerOf(room, ws);
      if (partner) send(partner, { t: 'emote', e: msg.e, from: meta.name });
      break;
    }

    case 'shield_up': {
      // Avisar al rival que este jugador activó escudo (7s) → puede tirar bomba rayo
      const room = meta.room;
      if (!room || room.finished) return;
      const partner = partnerOf(room, ws);
      if (partner) send(partner, { t: 'opp_shield', from: meta.name, duration: 7000 });
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
