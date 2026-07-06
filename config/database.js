/*
  ============================================================
  NEURO RUSH ⚡ — Database configuration per environment
  Copyright © 2026 Angel Fuentes. All rights reserved.
  ============================================================

  Selected by NODE_ENV (defaults to "development").
  Credentials come from .env as separate fields (host/port/user/
  pass/name) — no connection URL, so special characters in the
  password need no URL-encoding.

  Production uses Railway's native MySQL variable names.
*/

require('dotenv').config();

const common = {
  dialect: 'mysql',
  define: {
    underscored: true,   // created_at, player_id, …
    timestamps: true,
    updatedAt: false
  }
};

module.exports = {
  development: {
    ...common,
    database: process.env.DEV_DB_NAME || null,
    username: process.env.DEV_DB_USER || null,
    password: process.env.DEV_DB_PASS || '',
    host: process.env.DEV_DB_HOST || '127.0.0.1',
    port: Number(process.env.DEV_DB_PORT) || 3306,
    logging: msg => console.log('[db]', msg), // verbose SQL in dev
    dialectOptions: process.env.DEV_DB_SSL === 'true'
      ? { ssl: { rejectUnauthorized: true } }
      : {}
  },

  production: {
    ...common,
    database: process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || null,
    username: process.env.MYSQLUSER || null,
    password: process.env.MYSQLPASSWORD || '',
    host: process.env.MYSQLHOST || null,
    port: Number(process.env.MYSQLPORT) || 3306,
    logging: false, // silent in prod
    dialectOptions: {},
    pool: { max: 10, min: 0, idle: 10000, acquire: 30000 }
  }
};
