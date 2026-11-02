'use strict';
/*
 * Move users (and their progress, friends, battles) from the laptop server into the online database.
 *   DATABASE_URL="postgresql://..." node scripts/import-db.js path/to/server/data/db.json
 * Safe to run again: existing rows are updated, nothing is deleted.
 */
const fs = require('fs');
const { q, close } = require('../lib/db');
const { pid, xpOf } = require('../lib/pure');
(async () => {
  const file = process.argv[2];
  if (!file || !process.env.DATABASE_URL) { console.error('Usage: DATABASE_URL=... node scripts/import-db.js path/to/db.json'); process.exit(1); }
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  let n = 0, nb = 0;
  for (const u of Object.values(old.users || {})) {
    await q(`insert into users (email, pid, status, xp, name, created, data) values ($1,$2,$3,$4,$5,$6,$7)
             on conflict (email) do update set status = excluded.status, xp = excluded.xp, name = excluded.name, data = excluded.data`,
      [u.email, pid(u.email), u.status, xpOf(u), u.name, u.created || Date.now(), u]);
    n++;
  }
  for (const b of Object.values(old.battles || {})) {
    await q(`insert into battles (id, a, b, status, created, ended, data) values ($1,$2,$3,$4,$5,$6,$7)
             on conflict (id) do update set status = excluded.status, ended = excluded.ended, data = excluded.data`,
      [b.id, b.a, b.b, b.status, b.created || Date.now(), b.end || 0, b]);
    nb++;
  }
  console.log('Imported ' + n + ' users and ' + nb + ' battles.');
  await close();
})().catch((e) => { console.error(e.message); process.exit(1); });
