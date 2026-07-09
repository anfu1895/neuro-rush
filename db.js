/*
  ============================================================
  NEURO RUSH ⚡ — Database access (Sequelize / MySQL)
  Copyright © 2026 Angel Fuentes. All rights reserved.
  ============================================================

  Config lives in config/database.js, keyed by NODE_ENV.
  If there is no connection URL (or the connection fails), the game
  still runs without global records: the API replies 503 and the
  client treats it as "offline".
*/

const { Sequelize, DataTypes, fn, col, literal } = require('sequelize');
const configByEnv = require('./config/database');

const env = process.env.NODE_ENV || 'development';

let sequelize = null;
let Player = null;
let Score = null;
let Match = null;
let Purchase = null;
let Perk = null;
let ready = false;

function enabled() {
  return ready;
}

function defineModels() {
  Player = sequelize.define('Player', {
    id: {
      type: DataTypes.UUID,          // stored as CHAR(36) in MySQL
      defaultValue: DataTypes.UUIDV4, // server-generated identity
      primaryKey: true
    },
    name: {
      type: DataTypes.STRING(16),
      allowNull: false,
      unique: true // default collation (…_ai_ci) → case/accent-insensitive
    },
    coins: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0
    }
  }, { tableName: 'players' });

  Score = sequelize.define('Score', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true
    },
    player_id: {
      type: DataTypes.UUID,
      allowNull: false
    },
    mode: {
      type: DataTypes.ENUM('classic', 'power'),
      allowNull: false
    },
    score: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false
    }
  }, {
    tableName: 'scores',
    indexes: [{ fields: ['mode', 'score'] }]
  });

  Player.hasMany(Score, { foreignKey: 'player_id' });
  Score.belongsTo(Player, { foreignKey: 'player_id' });

  Match = sequelize.define('Match', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true
    },
    player_a: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'players', key: 'id' }
    },
    player_b: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'players', key: 'id' }
    },
    score_a: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0
    },
    score_b: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0
    },
    winner: {
      type: DataTypes.UUID,
      allowNull: true // null on a tie
    }
  }, { tableName: 'matches' });

  // Compras Stripe acreditadas: session_id UNIQUE = idempotencia
  // (Stripe puede reintentar el webhook sin duplicar monedas)
  Purchase = sequelize.define('Purchase', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true
    },
    player_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'players', key: 'id' }
    },
    session_id: {
      type: DataTypes.STRING(191),
      allowNull: false,
      unique: true
    },
    pack: { type: DataTypes.STRING(32), allowNull: false },
    coins: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    amount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    currency: { type: DataTypes.STRING(8), allowNull: false }
  }, { tableName: 'purchases' });

  // Consumibles del jugador: corazón del día, escudos y bomba rayo.
  // kind es VARCHAR (no ENUM) para no requerir migraciones al sumar poderes.
  Perk = sequelize.define('Perk', {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true
    },
    player_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'players', key: 'id' }
    },
    kind: {
      type: DataTypes.STRING(16), // heart_day | shield | raybomb
      allowNull: false
    },
    qty: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    day: { type: DataTypes.DATEONLY, allowNull: true }
  }, {
    tableName: 'perks',
    indexes: [{ unique: true, fields: ['player_id', 'kind'] }]
  });
}

async function init() {
  const cfg = configByEnv[env];
  // No database/host/user configured → records stay offline.
  if (!cfg || !cfg.database || !cfg.host || !cfg.username) return false;

  sequelize = new Sequelize(cfg.database, cfg.username, cfg.password, {
    host: cfg.host,
    port: cfg.port,
    dialect: cfg.dialect,
    logging: cfg.logging,
    define: cfg.define,
    dialectOptions: cfg.dialectOptions,
    pool: cfg.pool
  });

  defineModels();
  await sequelize.authenticate();
  // Creates missing tables. In dev, align columns with the models.
  await sequelize.sync({ alter: env === 'development' });

  // In production sync() does not ALTER existing tables:
  // make sure players.coins exists (idempotent, safe on every boot).
  const desc = await sequelize.getQueryInterface().describeTable('players');
  if (!desc.coins) {
    await sequelize.getQueryInterface().addColumn('players', 'coins', {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0
    });
  }

  // perks.kind pudo crearse como ENUM('heart_day','shield') antes de sumar
  // 'raybomb'. Convertir a VARCHAR es idempotente y evita migrar el ENUM.
  const perksDesc = await sequelize.getQueryInterface().describeTable('perks').catch(() => null);
  if (perksDesc && perksDesc.kind && /enum/i.test(perksDesc.kind.type || '')) {
    await sequelize.query('ALTER TABLE perks MODIFY COLUMN kind VARCHAR(16) NOT NULL');
  }

  ready = true;
  return true;
}

async function registerPlayer(name) {
  try {
    const player = await Player.create({ name });
    return { id: player.id, name: player.name };
  } catch (err) {
    if (err && err.name === 'SequelizeUniqueConstraintError') {
      return { error: 'name_taken' };
    }
    throw err;
  }
}

async function saveScore(playerId, mode, score) {
  try {
    await Score.create({ player_id: playerId, mode, score });
    return { saved: true };
  } catch (err) {
    if (err && err.name === 'SequelizeForeignKeyConstraintError') {
      return { error: 'unknown_player' };
    }
    throw err;
  }
}

async function leaderboard(mode) {
  const rows = await Score.findAll({
    attributes: [[fn('MAX', col('score')), 'best']],
    where: { mode },
    include: [{ model: Player, attributes: ['name'] }],
    group: ['Player.id', 'Player.name'],
    order: [[literal('best'), 'DESC']],
    limit: 10,
    raw: true
  });
  return rows.map(r => ({ name: r['Player.name'], best: Number(r.best) }));
}

async function saveMatch(playerA, playerB, scoreA, scoreB, winner) {
  await Match.create({
    player_a: playerA,
    player_b: playerB,
    score_a: scoreA,
    score_b: scoreB,
    winner: winner || null
  });
}

// ---------- Monedero y tienda ----------

function todayStr() {
  return new Date().toISOString().slice(0, 10); // día UTC
}

async function getWallet(playerId) {
  const player = await Player.findByPk(playerId);
  if (!player) return { error: 'unknown_player' };
  const perks = await Perk.findAll({ where: { player_id: playerId } });
  let heartToday = false;
  let shields = 0;
  let raybombs = 0;
  for (const perk of perks) {
    if (perk.kind === 'heart_day') heartToday = perk.day === todayStr();
    if (perk.kind === 'shield') shields = perk.qty;
    if (perk.kind === 'raybomb') raybombs = perk.qty;
  }
  return { coins: player.coins, heartToday, shields, raybombs };
}

// Acredita monedas de una compra Stripe. Idempotente por session_id.
async function creditPurchase(playerId, pack, coins, amount, currency, sessionId) {
  try {
    await sequelize.transaction(async t => {
      await Purchase.create(
        { player_id: playerId, session_id: sessionId, pack, coins, amount, currency },
        { transaction: t }
      );
      await Player.increment({ coins }, { where: { id: playerId }, transaction: t });
    });
    return { credited: true };
  } catch (err) {
    if (err && err.name === 'SequelizeUniqueConstraintError') {
      return { credited: false, already: true }; // ya se había acreditado
    }
    if (err && err.name === 'SequelizeForeignKeyConstraintError') {
      return { error: 'unknown_player' };
    }
    throw err;
  }
}

// Descuenta monedas de forma atómica: falla si el saldo no alcanza.
async function spendCoins(playerId, cost) {
  const [result] = await sequelize.query(
    'UPDATE players SET coins = coins - ? WHERE id = ? AND coins >= ?',
    { replacements: [cost, playerId, cost] }
  );
  return result.affectedRows > 0;
}

// Alta/actualización de un consumible (upsert por jugador+tipo)
async function grantPerk(playerId, kind, addQty, day) {
  const [perk, created] = await Perk.findOrCreate({
    where: { player_id: playerId, kind },
    defaults: { qty: addQty || 0, day: day || null }
  });
  if (!created) {
    if (day) perk.day = day;
    if (addQty) perk.qty += addQty;
    await perk.save();
  }
  return perk;
}

async function useShield(playerId) {
  const [result] = await sequelize.query(
    "UPDATE perks SET qty = qty - 1 WHERE player_id = ? AND kind = 'shield' AND qty > 0",
    { replacements: [playerId] }
  );
  return result.affectedRows > 0;
}

async function useRaybomb(playerId) {
  const [result] = await sequelize.query(
    "UPDATE perks SET qty = qty - 1 WHERE player_id = ? AND kind = 'raybomb' AND qty > 0",
    { replacements: [playerId] }
  );
  return result.affectedRows > 0;
}

module.exports = {
  enabled, init, registerPlayer, saveScore, leaderboard, saveMatch,
  getWallet, creditPurchase, spendCoins, grantPerk, useShield, useRaybomb, todayStr
};
