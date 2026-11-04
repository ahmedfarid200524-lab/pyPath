#!/usr/bin/env node
'use strict';
/* Writes content/index.json: the list of courses the app offers.
   A course is listed only when every unit file named in its course.json exists.
   Run it after adding or changing a course:  node scripts/build-index.js */
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..', 'content'), out = [];
for (const id of fs.readdirSync(dir).sort()) {
  const mf = path.join(dir, id, 'course.json');
  if (!fs.existsSync(mf)) continue;
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  if (id.startsWith('zz') || m.hidden) continue;
  const files = m.units.map((u) => path.join(dir, id, u + '.json'));
  if (!files.every((f) => fs.existsSync(f))) { console.log('skipping ' + id + ' (unit files missing)'); continue; }
  const size = files.reduce((n, f) => n + JSON.parse(fs.readFileSync(f, 'utf8')).lessons.length + 3, 0);
  out.push({ id: m.id, t: m.t, e: m.e, d: m.d, lang: m.lang, size });
}
fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(out, null, 1) + '\n');
console.log('content/index.json lists: ' + (out.map((c) => c.id).join(', ') || '(nothing yet)'));
