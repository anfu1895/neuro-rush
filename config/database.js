/*
  ============================================================
  NEURO RUSH ⚡ — Database configuration per environment
  Copyright © 2026 Angel Fuentes. All rights reserved.
  ============================================================

  Selected by NODE_ENV (defaults to "development").
  Credentials come from .env as separate fields (host/port/user/
  pass/name) — no connection URL, so special characters in the
  password need no URL-encoding.

  Providers like TiDB Cloud and Aiven REQUIRE SSL: set *_DB_SSL=true.
  A plain local MySQL usually needs *_DB_SSL=false.
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
    database: process.env.PROD_DB_NAME || null,
    username: process.env.PROD_DB_USER || null,
    password: process.env.PROD_DB_PASS || '',
    host: process.env.PROD_DB_HOST || null,
    port: Number(process.env.PROD_DB_PORT) || 3306,
    logging: false, // silent in prod
    // SSL on by default in prod; set PROD_DB_SSL=false only to opt out.
    dialectOptions: process.env.PROD_DB_SSL === 'false'
      ? {}
      : { ssl: { rejectUnauthorized: true } },
    pool: { max: 10, min: 0, idle: 10000, acquire: 30000 }
  }
};
