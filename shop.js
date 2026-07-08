/*
  ============================================================
  NEURO RUSH ⚡ — Tienda y pagos (Stripe Checkout)
  Copyright © 2026 Angel Fuentes. Todos los derechos reservados.
  ============================================================

  Flujo de compra de monedas:
    1. POST /api/shop/checkout {playerId, pack}
         → crea una Stripe Checkout Session y devuelve {url}
    2. El jugador paga en la página alojada de Stripe.
    3a. Stripe llama POST /api/stripe/webhook (producción)
    3b. Al volver, el cliente llama GET /api/shop/confirm?session_id=...
        (respaldo para desarrollo local sin webhook)
    Ambos caminos acreditan monedas de forma IDEMPOTENTE:
    la tabla purchases tiene session_id UNIQUE.

  Gasto de monedas (validado siempre en servidor):
    POST /api/shop/spend {playerId, item}
      revive      80  → segunda vida en la partida actual
      heart_day   60  → partidas de hoy con 4 vidas
      shield_pack 100 → 3 escudos de inicio (modo power)
      use_shield   0  → consume 1 escudo al iniciar partida

  Config (.env):
    STRIPE_SECRET_KEY      sk_test_... / sk_live_...
    STRIPE_WEBHOOK_SECRET  whsec_...   (opcional en desarrollo)
    SHOP_CURRENCY          mxn (default)
*/

const db = require('./db');

const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const CURRENCY = (process.env.SHOP_CURRENCY || 'mxn').toLowerCase();

// Paquetes de monedas (amount en centavos)
const PACKS = {
  small:  { coins: 200,  amount: 2900,  name: 'NEURO RUSH — 200 Neuro Monedas' },
  medium: { coins: 700,  amount: 8900,  name: 'NEURO RUSH — 700 Neuro Monedas' },
  large:  { coins: 1600, amount: 17900, name: 'NEURO RUSH — 1600 Neuro Monedas' }
};

// Consumibles comprables con monedas
const ITEM_COST = { revive: 80, heart_day: 60, shield_pack: 100 };
const MAX_BODY = 64 * 1024;

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function readRawBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body_too_large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function readJson(request) {
  const raw = await readRawBody(request);
  try { return JSON.parse(raw.toString('utf8') || '{}'); }
  catch { throw new Error('bad_json'); }
}

function requestOrigin(request) {
  const proto = request.headers['x-forwarded-proto']
    || (request.socket && request.socket.encrypted ? 'https' : 'http');
  return `${proto}://${request.headers.host}`;
}

// Acreditación compartida entre webhook y confirm (idempotente)
async function creditFromSession(session) {
  if (!session || session.payment_status !== 'paid') return { error: 'not_paid' };
  const meta = session.metadata || {};
  const pack = PACKS[meta.pack];
  if (!meta.playerId || !pack) return { error: 'bad_metadata' };
  return db.creditPurchase(
    meta.playerId, meta.pack, pack.coins,
    session.amount_total || pack.amount,
    session.currency || CURRENCY,
    session.id
  );
}

async function handleCheckout(request, response) {
  if (!stripe) return sendJson(response, 503, { error: 'shop_disabled' });
  const body = await readJson(request);
  const pack = PACKS[body.pack];
  const playerId = String(body.playerId || '');
  if (!pack) return sendJson(response, 400, { error: 'invalid_pack' });

  const wallet = await db.getWallet(playerId);
  if (wallet.error) return sendJson(response, 400, wallet);

  const origin = requestOrigin(request);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: CURRENCY,
        unit_amount: pack.amount,
        product_data: { name: pack.name }
      }
    }],
    metadata: { playerId, pack: String(body.pack) },
    success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/?checkout=cancel`
  });

  return sendJson(response, 200, { url: session.url });
}

async function handleConfirm(query, response) {
  if (!stripe) return sendJson(response, 503, { error: 'shop_disabled' });
  const sessionId = new URLSearchParams(query || '').get('session_id') || '';
  if (!sessionId) return sendJson(response, 400, { error: 'missing_session' });

  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const credited = await creditFromSession(session);
  if (credited.error) return sendJson(response, 400, credited);

  const meta = session.metadata || {};
  const wallet = await db.getWallet(meta.playerId);
  return sendJson(response, 200, wallet);
}

async function handleWebhook(request, response) {
  if (!stripe) return sendJson(response, 503, { error: 'shop_disabled' });
  if (!WEBHOOK_SECRET) return sendJson(response, 501, { error: 'webhook_not_configured' });

  const raw = await readRawBody(request);
  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, request.headers['stripe-signature'], WEBHOOK_SECRET);
  } catch (err) {
    return sendJson(response, 400, { error: 'invalid_signature' });
  }

  if (event.type === 'checkout.session.completed') {
    const result = await creditFromSession(event.data.object);
    // unknown_player / bad_metadata: no reintentar, es un fallo permanente
    if (result.error && result.error !== 'not_paid') {
      console.error('Webhook: no se pudo acreditar:', result.error);
    }
  }
  return sendJson(response, 200, { received: true });
}

async function handleSpend(request, response) {
  const body = await readJson(request);
  const playerId = String(body.playerId || '');
  const item = String(body.item || '');

  if (item === 'use_shield') {
    const used = await db.useShield(playerId);
    if (!used) return sendJson(response, 400, { error: 'no_shields' });
    return sendJson(response, 200, await db.getWallet(playerId));
  }

  const cost = ITEM_COST[item];
  if (!cost) return sendJson(response, 400, { error: 'invalid_item' });

  const wallet = await db.getWallet(playerId);
  if (wallet.error) return sendJson(response, 400, wallet);
  if (item === 'heart_day' && wallet.heartToday) {
    return sendJson(response, 400, { error: 'already_active' });
  }

  const paid = await db.spendCoins(playerId, cost);
  if (!paid) return sendJson(response, 400, { error: 'insufficient_coins' });

  if (item === 'heart_day') await db.grantPerk(playerId, 'heart_day', 0, db.todayStr());
  else if (item === 'shield_pack') await db.grantPerk(playerId, 'shield', 3, null);
  // revive: solo descuenta — el efecto es inmediato en el cliente

  return sendJson(response, 200, await db.getWallet(playerId));
}

async function handleWallet(query, response) {
  const playerId = new URLSearchParams(query || '').get('playerId') || '';
  const wallet = await db.getWallet(playerId);
  if (wallet.error) return sendJson(response, 400, wallet);
  return sendJson(response, 200, wallet);
}

// Router de la tienda: /api/wallet, /api/shop/*, /api/stripe/webhook
async function handle(request, response, pathname, query) {
  if (!db.enabled()) return sendJson(response, 503, { error: 'db_disabled' });

  try {
    if (request.method === 'GET' && pathname === '/api/wallet') {
      return await handleWallet(query, response);
    }
    if (request.method === 'POST' && pathname === '/api/shop/checkout') {
      return await handleCheckout(request, response);
    }
    if (request.method === 'GET' && pathname === '/api/shop/confirm') {
      return await handleConfirm(query, response);
    }
    if (request.method === 'POST' && pathname === '/api/shop/spend') {
      return await handleSpend(request, response);
    }
    if (request.method === 'POST' && pathname === '/api/stripe/webhook') {
      return await handleWebhook(request, response);
    }
    return sendJson(response, 404, { error: 'not_found' });
  } catch (error) {
    const message = error && error.message;
    if (message === 'bad_json' || message === 'body_too_large') {
      return sendJson(response, 400, { error: message });
    }
    console.error('Error de tienda:', error);
    return sendJson(response, 500, { error: 'server_error' });
  }
}

function enabled() {
  return !!stripe;
}

module.exports = { handle, enabled };
