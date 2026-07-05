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

module.exports = { enabled, init, registerPlayer, saveScore, leaderboard };
