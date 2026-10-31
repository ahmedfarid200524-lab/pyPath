'use strict';
/* Postgres access (works with Neon, Supabase or any Postgres). One small pool per function instance. */
const { Pool } = require('pg');

let pool = null, ready = null;
function getPool() {
  if (!pool) {
    const cs = process.env.DATABASE_URL;
    if (!cs) { const e = new Error('Server is missing DATABASE_URL'); e.code = 'CONFIG'; throw e; }
    pool = new Pool({
      connectionString: cs,
      max: Number(process.env.PG_POOL_MAX || 1),
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 15000,
      ssl: /(localhost|127\.0\.0\.1)/.test(cs) ? false : { rejectUnauthorized: false }
    });
    pool.on('error', () => { /* idle client dropped: a new one is made on demand */ });
  }
  return pool;
}

const SCHEMA = [
  `create table if not exists users (
     email text primary key,
     pid text not null unique,
     status text not null,
     xp integer not null default 0,
     name text not null,
     created bigint not null,
     data jsonb not null)`,
  `create index if not exists users_rank on users (status, xp desc, name)`,
  `create table if not exists battles (
     id text primary key,
     a text not null,
     b text not null,
     status text not null,
     created bigint not null,
     ended bigint not null default 0,
     data jsonb not null)`,
  `create index if not exists battles_a on battles (a)`,
  `create index if not exists battles_b on battles (b)`,
  `create table if not exists rl (k text primary key, n integer not null, reset bigint not null)`
];

function ensure() {
  if (!ready) {
    ready = (async () => {
      const p = getPool();
      for (const sql of SCHEMA) await p.query(sql);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function q(text, params) { await ensure(); return getPool().query(text, params); }
async function tx(fn) {
  await ensure();
  const c = await getPool().connect();
  try {
    await c.query('begin');
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    try { await c.query('rollback'); } catch { /* ignore */ }
    throw e;
  } finally { c.release(); }
}
async function close() { if (pool) { await pool.end(); pool = null; ready = null; } }
module.exports = { q, tx, ensure, close, SCHEMA };
