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
      revive       80  → segunda vida en la partida actual
      heart_day    60  → partidas de hoy con 4 vidas
      shield       50  → 1 escudo de inicio (modo power); máx. 2 en posesión
      raybomb     120  → 1 bomba rayo que rompe escudos; máx. 1 en posesión
      use_shield    0  → consume 1 escudo al iniciar partida
      use_raybomb   0  → consume 1 bomba rayo (rompe el escudo del rival)

  Config (.env):
    STRIPE_SECRET_KEY      sk_test_... / sk_live_...
    STRIPE_WEBHOOK_SECRET  whsec_...   (opcional en desarrollo)
    SHOP_CURRENCY          mxn (default)
    DEV_FREE_SHOP          true → tienda de desarrollo: TODO gratis (0 monedas).
                           Solo para pruebas locales. NUNCA en producción.
*/

const db = require('./db');

const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const CURRENCY = (process.env.SHOP_CURRENCY || 'mxn').toLowerCase();

function envFlag(name) {
  const value = String(process.env[name] || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .toLowerCase();
  return ['true', '1', 'yes', 'on'].includes(value);
}

// Tienda de desarrollo: si está activa, toda compra con monedas cuesta 0.
// Solo afecta el gasto de monedas; los topes y las compras únicas se respetan.
const DEV_FREE_SHOP = envFlag('DEV_FREE_SHOP');
if (DEV_FREE_SHOP) {
  console.warn('⚠️  DEV_FREE_SHOP ACTIVO: todas las compras de la tienda son GRATIS. No usar en producción.');
}

// Descuenta monedas salvo que la tienda de desarrollo esté activa (entonces es gratis).
async function chargeCoins(playerId, cost) {
  if (DEV_FREE_SHOP) return true;
  return db.spendCoins(playerId, cost);
}

// Paquetes de monedas (amount en centavos)
const PACKS = {
  starter: { coins: 300,  amount: 1900,  name: 'NEURO RUSH — Pack de Inicio (300 monedas + escudo + corazón)' },
  small:  { coins: 200,  amount: 2900,  name: 'NEURO RUSH — 200 Neuro Monedas' },
  medium: { coins: 700,  amount: 8900,  name: 'NEURO RUSH — 700 Neuro Monedas' },
  large:  { coins: 1600, amount: 17900, name: 'NEURO RUSH — 1600 Neuro Monedas' }
};

// Consumibles comprables con monedas
const ITEM_COST = {
  revive: 80, heart_day: 30, shield: 50, raybomb: 120,
  shield_slot: 500, badge_star: 200,
  emote_mind: 60, emote_clown: 60,
  theme_lava: 250, theme_ocean: 250, theme_retro: 250,
  slowmo: 40, magnet: 50, double: 60
};
// Tope de unidades que un jugador puede tener a la vez
// (el tope real de escudos viene de wallet.shieldMax: 2, o 3 con el slot extra)
const PERK_MAX = { raybomb: 1 };
// Poderes de modos SOLO: máximo 3 de cada uno
const SOLO_POWERS = new Set(['slowmo', 'magnet', 'double']);
const SOLO_MAX = 3;
// Compras únicas (permanentes) — el pack base de emotes ahora es gratis
const ONE_TIME = new Set(['emote_mind', 'emote_clown', 'theme_lava', 'theme_ocean', 'theme_retro']);
// Regalo diario por entrar al juego
const DAILY_COINS = 5;
// Oferta del día: rota según la fecha (misma para todos)
const DEALS = [
  { item: 'shield',    cost: 35 },
  { item: 'heart_day', cost: 20 },
  { item: 'slowmo',    cost: 25 },
  { item: 'raybomb',   cost: 85 },
  { item: 'magnet',    cost: 30 },
  { item: 'double',    cost: 40 }
];
function todaysDeal() {
  const day = Math.floor(Date.now() / 86400000);
  const deal = DEALS[day % DEALS.length];
  return { item: deal.item, cost: deal.cost, normal: ITEM_COST[deal.item] };
}
async function walletWithDeal(playerId) {
  const w = await db.getWallet(playerId);
  if (!w.error) { w.deal = todaysDeal(); w.devFreeShop = DEV_FREE_SHOP; }
  return w;
}
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
  const result = await db.creditPurchase(
    meta.playerId, meta.pack, pack.coins,
    session.amount_total || pack.amount,
    session.currency || CURRENCY,
    session.id
  );
  // Regalos del Pack de Inicio (solo al acreditar por primera vez)
  if (result.credited && meta.pack === 'starter') {
    const w = await db.getWallet(meta.playerId);
    if (!w.error) {
      if (w.shields < w.shieldMax) await db.grantPerk(meta.playerId, 'shield', 1, null);
      if (!w.heartToday) await db.grantPerk(meta.playerId, 'heart_day', 0, db.todayStr());
    }
  }
  return result;
}

async function handleCheckout(request, response) {
  const body = await readJson(request);
  const pack = PACKS[body.pack];
  const playerId = String(body.playerId || '');
  if (!pack) return sendJson(response, 400, { error: 'invalid_pack' });

  const wallet = await db.getWallet(playerId);
  if (wallet.error) return sendJson(response, 400, wallet);
  // El Pack de Inicio es una sola vez por jugador
  if (body.pack === 'starter' && !wallet.starterAvailable) {
    return sendJson(response, 400, { error: 'starter_already' });
  }

  if (DEV_FREE_SHOP) {
    const sessionId = `dev_free_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const result = await db.creditPurchase(playerId, body.pack, pack.coins, 0, CURRENCY, sessionId);
    if (result.error) return sendJson(response, 400, result);
    if (body.pack === 'starter' && result.credited) {
      const updated = await db.getWallet(playerId);
      if (!updated.error) {
        if (updated.shields < updated.shieldMax) await db.grantPerk(playerId, 'shield', 1, null);
        if (!updated.heartToday) await db.grantPerk(playerId, 'heart_day', 0, db.todayStr());
      }
    }
    return sendJson(response, 200, await walletWithDeal(playerId));
  }

  if (!stripe) return sendJson(response, 503, { error: 'shop_disabled' });

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
  const wallet = await walletWithDeal(meta.playerId);
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

  // Consumir un poder (no cuesta monedas): use_shield | use_raybomb | use_slowmo | use_magnet | use_double
  if (item.startsWith('use_')) {
    const kind = item.slice(4);
    const usable = new Set(['shield', 'raybomb', 'slowmo', 'magnet', 'double']);
    if (!usable.has(kind)) return sendJson(response, 400, { error: 'invalid_item' });
    const used = await db.usePerk(playerId, kind);
    if (!used) return sendJson(response, 400, { error: 'no_' + kind });
    return sendJson(response, 200, await walletWithDeal(playerId));
  }

  // Compra desde el loadout del duelo: mismo precio que la tienda, mismos topes
  if (item === 'loadout_shield' || item === 'loadout_raybomb') {
    const kind = item === 'loadout_shield' ? 'shield' : 'raybomb';
    const w = await db.getWallet(playerId);
    if (w.error) return sendJson(response, 400, w);
    if (kind === 'shield' && w.shields >= w.shieldMax) {
      return sendJson(response, 400, { error: 'max_shields' });
    }
    if (kind === 'raybomb' && w.raybombs >= PERK_MAX.raybomb) {
      return sendJson(response, 400, { error: 'max_raybombs' });
    }
    const paidLd = await chargeCoins(playerId, ITEM_COST[kind]);
    if (!paidLd) return sendJson(response, 400, { error: 'insufficient_coins' });
    await db.grantPerk(playerId, kind, 1, null);
    return sendJson(response, 200, await walletWithDeal(playerId));
  }

  // Oferta del día: mismo ítem, precio con descuento (validaciones normales)
  let buyItem = item;
  let price = ITEM_COST[item];
  if (item === 'daily_deal') {
    const deal = todaysDeal();
    buyItem = deal.item;
    price = deal.cost;
  }
  if (!price) return sendJson(response, 400, { error: 'invalid_item' });

  const wallet = await db.getWallet(playerId);
  if (wallet.error) return sendJson(response, 400, wallet);
  if (buyItem === 'heart_day' && wallet.heartToday) {
    return sendJson(response, 400, { error: 'already_active' });
  }
  // Topes de posesión (escudo: 2, o 3 con el slot extra)
  if (buyItem === 'shield' && wallet.shields >= wallet.shieldMax) {
    return sendJson(response, 400, { error: 'max_shields' });
  }
  if (buyItem === 'raybomb' && wallet.raybombs >= PERK_MAX.raybomb) {
    return sendJson(response, 400, { error: 'max_raybombs' });
  }
  // Poderes solo: máximo 3 de cada uno
  if (SOLO_POWERS.has(buyItem) && wallet[buyItem] >= SOLO_MAX) {
    return sendJson(response, 400, { error: 'max_items' });
  }
  // Compras únicas
  if (buyItem === 'shield_slot' && wallet.shieldMax >= 3) {
    return sendJson(response, 400, { error: 'already_owned' });
  }
  if (buyItem === 'badge_star' && wallet.badgeStar) {
    return sendJson(response, 400, { error: 'already_owned' });
  }
  if (buyItem === 'emote_mind' && wallet.emoteMind) {
    return sendJson(response, 400, { error: 'already_owned' });
  }
  if (buyItem === 'emote_clown' && wallet.emoteClown) {
    return sendJson(response, 400, { error: 'already_owned' });
  }
  if (buyItem.startsWith('theme_') && wallet.themes[buyItem.slice(6)]) {
    return sendJson(response, 400, { error: 'already_owned' });
  }

  const paid = await chargeCoins(playerId, price);
  if (!paid) return sendJson(response, 400, { error: 'insufficient_coins' });

  if (buyItem === 'heart_day') await db.grantPerk(playerId, 'heart_day', 0, db.todayStr());
  else if (buyItem === 'shield_slot') await db.grantPerk(playerId, 'slot3', 1, null);
  else if (buyItem !== 'revive') await db.grantPerk(playerId, buyItem, 1, null);
  // revive: solo descuenta — el efecto es inmediato en el cliente

  return sendJson(response, 200, await walletWithDeal(playerId));
}

async function handleWallet(query, response) {
  const playerId = new URLSearchParams(query || '').get('playerId') || '';
  const wallet = await walletWithDeal(playerId);
  if (wallet.error) return sendJson(response, 400, wallet);
  return sendJson(response, 200, wallet);
}

function handleConfig(response) {
  return sendJson(response, 200, {
    devFreeShop: DEV_FREE_SHOP,
    nodeEnv: process.env.NODE_ENV || null,
    shopCurrency: CURRENCY,
    stripeConfigured: !!stripe
  });
}

// Router de la tienda: /api/wallet, /api/shop/*, /api/stripe/webhook
async function handle(request, response, pathname, query) {
  if (request.method === 'GET' && pathname === '/api/shop/config') {
    return handleConfig(response);
  }

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
    if (request.method === 'POST' && pathname === '/api/shop/daily') {
      const body = await readJson(request);
      const playerId = String(body.playerId || '');
      const wallet = await db.getWallet(playerId);
      if (wallet.error) return sendJson(response, 400, wallet);
      if (!wallet.dailyAvailable) return sendJson(response, 400, { error: 'already_claimed' });
      const claimed = await db.claimDaily(playerId, DAILY_COINS);
      if (claimed.error) return sendJson(response, 400, claimed);
      return sendJson(response, 200, await walletWithDeal(playerId));
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
