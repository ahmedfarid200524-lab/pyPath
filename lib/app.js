'use strict';
/*
 * pyPath online backend (for Vercel + a hosted Postgres such as Neon).
 * Same API as server/server.js, but all data lives in Postgres instead of a file.
 * Settings come from environment variables (see .env.example).
 */
const crypto = require('crypto');
const { q, tx } = require('./db');
const { num, str, cleanState, mergeState, pid, levelsDone, xpOf } = require('./pure');
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch { /* optional */ }

const env = (k, d = '') => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const TOKEN_DAYS = 30;
let APP_URL = env('APP_URL').replace(/\/+$/, '');

/* ---------- email ---------- */
const MAIL_FROM = () => env('MAIL_FROM', env('SMTP_USER', 'pypath@localhost'));
let transport = null;
function getTransport() {
  if (transport || !nodemailer || !env('SMTP_HOST')) return transport;
  const port = Number(env('SMTP_PORT', 587));
  transport = nodemailer.createTransport({
    host: env('SMTP_HOST'), port, secure: env('SMTP_SECURE', port === 465 ? 'true' : 'false') === 'true',
    auth: env('SMTP_USER') ? { user: env('SMTP_USER'), pass: env('SMTP_PASS') } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000
  });
  return transport;
}
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function sendMail(to, subject, text, html) {
  const t = getTransport();
  let status = 'not-configured', error = '';
  if (t) {
    try { await t.sendMail({ from: '"pyPath" <' + MAIL_FROM() + '>', to, subject, text, html }); status = 'sent'; }
    catch (e) { status = 'failed'; error = e.message; }
  }
  console.log('[mail] ' + status + ' to=' + to + ' subject=' + subject + (error ? ' error=' + error : ''));
  return { status, error };
}
const mails = {
  approved: (u) => ({
    subject: 'Your pyPath account is ready',
    text: 'Hi ' + u.name + ',\n\nGood news: your pyPath account has been approved and is ready to use.\n\nLog in here: ' + APP_URL + '\nUse the email and password you registered with.\n\nHappy coding!\nThe pyPath team',
    html: '<div style="font-family:system-ui,Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border:3px solid #15122e;border-radius:14px"><h2 style="margin:0 0 12px;color:#15122e">py<span style="color:#ff5c8a">Path</span></h2><p>Hi ' + escHtml(u.name) + ',</p><p><b>Your account is ready to use.</b> An admin approved your registration.</p><p><a href="' + escHtml(APP_URL) + '" style="display:inline-block;background:#ffc93c;color:#15122e;font-weight:700;padding:12px 22px;border-radius:10px;text-decoration:none">Open pyPath</a></p><p style="color:#555;font-size:14px">Log in with the email and password you registered with.</p></div>'
  }),
  rejected: (u) => ({
    subject: 'About your pyPath registration',
    text: 'Hi ' + u.name + ',\n\nThanks for your interest in pyPath. Unfortunately your registration was not approved this time.\n\nThe pyPath team',
    html: '<div style="font-family:system-ui,Arial,sans-serif;max-width:480px;margin:auto;padding:24px"><p>Hi ' + escHtml(u.name) + ',</p><p>Thanks for your interest in pyPath. Unfortunately your registration was not approved this time.</p></div>'
  }),
  adminNotice: (u) => ({
    subject: 'New pyPath registration: ' + u.name,
    text: 'A new person wants to join pyPath.\n\nName: ' + u.name + '\nEmail: ' + u.email + '\nAge: ' + u.age + '\nCollege: ' + u.college + '\n\nReview it here: ' + APP_URL + '/admin',
    html: '<p>A new person wants to join pyPath.</p><ul><li><b>Name:</b> ' + escHtml(u.name) + '</li><li><b>Email:</b> ' + escHtml(u.email) + '</li><li><b>Age:</b> ' + u.age + '</li><li><b>College:</b> ' + escHtml(u.college) + '</li></ul><p><a href="' + escHtml(APP_URL) + '/admin">Open the admin page</a></p>'
  })
};

/* ---------- passwords + tokens ---------- */
function scrypt(pw, salt) {
  return new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
}
function secret() {
  const s = env('TOKEN_SECRET');
  if (s.length < 16) { const e = new Error('Server is missing TOKEN_SECRET (at least 16 characters)'); e.code = 'CONFIG'; throw e; }
  return s;
}
function sign(payload, days) {
  const body = Buffer.from(JSON.stringify(Object.assign({}, payload, { exp: Date.now() + days * 864e5 }))).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', secret()).update(body).digest('base64url');
}
function verifyToken(tok) {
  if (typeof tok !== 'string') return null;
  const i = tok.indexOf('.'); if (i < 1) return null;
  const body = tok.slice(0, i);
  const want = crypto.createHmac('sha256', secret()).update(body).digest();
  let got; try { got = Buffer.from(tok.slice(i + 1), 'base64url'); } catch { return null; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

/* ---------- rate limiter (kept in the database so it works across serverless instances) ---------- */
async function limited(key, max, ms) {
  const now = Date.now();
  const r = await q(
    `insert into rl (k, n, reset) values ($1, 1, $2)
     on conflict (k) do update set
       n = case when rl.reset < $3 then 1 else rl.n + 1 end,
       reset = case when rl.reset < $3 then $2 else rl.reset end
     returning n`, [key, now + ms, now]);
  if (Math.random() < 0.02) q('delete from rl where reset < $1', [now]).catch(() => {});
  return r.rows[0].n > max;
}

/* ---------- users ---------- */
async function getUser(c, email, lock) {
  const r = await c.query('select data from users where email = $1' + (lock ? ' for update' : ''), [email]);
  return r.rows[0] ? r.rows[0].data : null;
}
async function putUser(c, u) {
  await c.query('update users set data = $2, status = $3, xp = $4, name = $5 where email = $1', [u.email, u, u.status, xpOf(u), u.name]);
}
async function userByPid(id) {
  const r = await q("select data from users where pid = $1 and status = 'approved'", [id]);
  return r.rows[0] ? r.rows[0].data : null;
}
async function usersByPids(ids) {
  if (!ids.length) return [];
  const r = await q("select data from users where pid = any($1) and status = 'approved'", [ids]);
  return r.rows.map((x) => x.data);
}
const publicUser = (u) => ({ name: u.name, email: u.email, age: u.age, college: u.college });
function card(x) {
  const pr = x.state && x.state.extra && x.state.extra.profile ? x.state.extra.profile : {};
  return { id: pid(x.email), name: x.name, xp: xpOf(x), streak: x.state ? x.state.progress.streak : 0, levels: levelsDone(x), g: pr.gender || '', av: pr.av || {} };
}

/* ---------- battles ---------- */
async function getBattle(c, id, lock) {
  const r = await c.query('select data from battles where id = $1' + (lock ? ' for update' : ''), [id]);
  return r.rows[0] ? r.rows[0].data : null;
}
async function putBattle(c, b) {
  await c.query('update battles set data = $2, status = $3, ended = $4 where id = $1', [b.id, b, b.status, b.end || 0]);
}
function refreshBattle(b) {   // returns true when it changed (expired)
  const now = Date.now();
  if (b.status === 'pending' && now - b.created > 864e5) { b.status = 'expired'; b.end = now; return true; }
  if (b.status === 'active' && now - b.startAt > 20 * 60e3) { b.status = 'expired'; b.end = now; return true; }
  return false;
}
function battleView(b, cardOf) {
  return { id: b.id, status: b.status, lang: b.lang, level: b.level, p: b.p, a: cardOf(b.a), b: cardOf(b.b),
    startAt: b.startAt || 0, now: Date.now(), prog: b.prog, winner: b.winner || '', left: b.left || '' };
}
const LEVELS_OK = { easy: [0, 5], medium: [6, 11], hard: [12, 17] };

async function socialView(u) {
  const me = pid(u.email), fr = u.friends || {};
  const lbR = await q("select data from users where status = 'approved' order by xp desc, name asc limit 100");
  const rk = await q("select count(*)::int as c from users where status = 'approved' and (xp > $1 or (xp = $1 and name < $2))", [xpOf(u), u.name]);
  const cards = {};
  const lb = lbR.rows.map((r, i) => {
    const x = r.data, c = card(x); cards[c.id] = c;
    return Object.assign({ rank: i + 1, rel: x.email === u.email ? 'me' : (fr[c.id] || '') }, c);
  });
  const friendUsers = await usersByPids(Object.keys(fr));
  friendUsers.forEach((x) => { const c = card(x); cards[c.id] = c; });
  const pick = (rel) => Object.keys(fr).filter((k) => fr[k] === rel && cards[k]).map((k) => cards[k]);
  const br = await q('select data from battles where a = $1 or b = $1 order by created desc limit 40', [me]);
  const list = [];
  for (const row of br.rows) {
    const b = row.data;
    if (refreshBattle(b)) q('update battles set data = $2, status = $3, ended = $4 where id = $1', [b.id, b, b.status, b.end || 0]).catch(() => {});
    if (b.status === 'pending' || b.status === 'active' || (b.end && Date.now() - b.end < 60000)) list.push(b);
  }
  const missing = [...new Set(list.flatMap((b) => [b.a, b.b]))].filter((id) => !cards[id]);
  (await usersByPids(missing)).forEach((x) => { const c = card(x); cards[c.id] = c; });
  const cardOf = (id) => cards[id] || { id, name: '?' };
  return { me: { id: me, name: u.name, rank: rk.rows[0].c + 1, xp: xpOf(u) }, lb, friends: pick('friend'), incoming: pick('in'), outgoing: pick('out'), battles: list.map((b) => battleView(b, cardOf)) };
}
async function battleViewFor(b) {
  const us = await usersByPids([b.a, b.b]);
  const m = {}; us.forEach((x) => { m[pid(x.email)] = card(x); });
  return battleView(b, (id) => m[id] || { id, name: '?' });
}

async function friendsAction(u0, b) {
  const me = pid(u0.email), id = str(b.id, 20), act = str(b.action, 12);
  const o0 = await userByPid(id);
  if (!o0 || id === me) return [404, { error: 'Player not found' }];
  return tx(async (c) => {
    const rows = await c.query('select data from users where email = any($1) order by email for update', [[u0.email, o0.email]]);
    const byEmail = {}; rows.rows.forEach((r) => { byEmail[r.data.email] = r.data; });
    const u = byEmail[u0.email], other = byEmail[o0.email];
    if (!u || !other) return [404, { error: 'Player not found' }];
    u.friends = u.friends || {}; other.friends = other.friends || {};
    const mine = u.friends[id] || '';
    const del = () => { delete u.friends[id]; delete other.friends[me]; };
    const both = () => { u.friends[id] = 'friend'; other.friends[me] = 'friend'; };
    if (act === 'request') {
      if (mine === 'friend' || mine === 'out') return [200, { ok: true }];
      if (Object.keys(u.friends).length >= 300) return [400, { error: 'Friend list is full' }];
      if (mine === 'in') both(); else { u.friends[id] = 'out'; other.friends[me] = 'in'; }
    } else if (act === 'accept') { if (mine !== 'in') return [400, { error: 'No request to accept' }]; both(); }
    else if (act === 'decline' || act === 'cancel') { if (mine !== 'in' && mine !== 'out') return [400, { error: 'No such request' }]; del(); }
    else if (act === 'remove') {
      del();
      const bs = await c.query("select data from battles where status = 'pending' and ((a = $1 and b = $2) or (a = $2 and b = $1)) for update", [me, id]);
      for (const r of bs.rows) { r.data.status = 'cancelled'; r.data.end = Date.now(); await putBattle(c, r.data); }
    } else return [400, { error: 'Unknown action' }];
    await putUser(c, u); await putUser(c, other);
    return [200, { ok: true }];
  });
}

async function battleAction(u, b) {
  const me = pid(u.email), act = str(b.action, 12);
  if (act === 'invite') {
    if (await limited('inv:' + me, 20, 600e3)) return [429, { error: 'Too many invites. Please wait a few minutes.' }];
    const to = str(b.to, 20), other = await userByPid(to), lang = str(b.lang, 4), level = str(b.level, 8), p = Number(b.p);
    if (!other || (u.friends || {})[to] !== 'friend') return [400, { error: 'You can only challenge friends' }];
    if (lang !== 'py' && lang !== 'js') return [400, { error: 'Pick Python or JavaScript' }];
    const r = LEVELS_OK[level];
    if (!r || !Number.isInteger(p) || p < r[0] || p > r[1]) return [400, { error: 'Bad level' }];
    const open = await q("select data from battles where status in ('pending','active') and ((a = $1 and b = $2) or (a = $2 and b = $1))", [me, to]);
    let busy = false;
    for (const row of open.rows) { const x = row.data; if (refreshBattle(x)) await q('update battles set data = $2, status = $3, ended = $4 where id = $1', [x.id, x, x.status, x.end || 0]); else busy = true; }
    if (busy) return [400, { error: 'You already have a battle with this friend' }];
    const id = crypto.randomBytes(9).toString('base64url'), now = Date.now();
    const bt = { id, a: me, b: to, lang, level, p, status: 'pending', created: now, startAt: 0, prog: {}, winner: '' };
    await q('insert into battles (id, a, b, status, created, ended, data) values ($1,$2,$3,$4,$5,0,$6)', [id, me, to, 'pending', now, bt]);
    await q('delete from battles where (ended > 0 and ended < $1) or created < $2', [now - 864e5, now - 5 * 864e5]);
    return [200, { ok: true, id }];
  }
  const out = await tx(async (c) => {
    const bt = await getBattle(c, str(b.bid, 40), true);
    if (!bt || (bt.a !== me && bt.b !== me)) return [404, { error: 'No such battle' }];
    refreshBattle(bt);
    if (act === 'accept') {
      if (bt.b !== me || bt.status !== 'pending') return [400, { error: 'This invite is no longer open' }];
      bt.status = 'active'; bt.startAt = Date.now() + 4000;
    } else if (act === 'decline') {
      if (bt.b !== me || bt.status !== 'pending') return [400, { error: 'This invite is no longer open' }];
      bt.status = 'declined'; bt.end = Date.now();
    } else if (act === 'cancel') {
      if (bt.a !== me || bt.status !== 'pending') return [400, { error: 'This invite is no longer open' }];
      bt.status = 'cancelled'; bt.end = Date.now();
    } else if (act === 'leave') {
      if (bt.status !== 'active') return [400, { error: 'This battle is not running' }];
      bt.status = 'left'; bt.left = me; bt.winner = bt.a === me ? bt.b : bt.a; bt.end = Date.now();
    } else if (act === 'progress') {
      if (bt.status !== 'active') return [200, { ok: true, bt }];
      if (Date.now() < bt.startAt - 500) return [400, { error: 'The battle has not started yet' }];
      const total = Math.min(40, Math.max(0, Math.floor(Number(b.total)) || 0)), passed = Math.min(total, Math.max(0, Math.floor(Number(b.passed)) || 0));
      bt.prog[me] = { passed, total, t: Date.now() };
      if (total > 0 && passed === total && !bt.winner) { bt.winner = me; bt.status = 'done'; bt.end = Date.now(); }
    } else return [400, { error: 'Unknown action' }];
    await putBattle(c, bt);
    return [200, { ok: true, bt }];
  });
  if (out[1].bt) { const bt = out[1].bt; return [out[0], { ok: true, battle: await battleViewFor(bt), me }]; }
  return out;
}

/* ---------- http helpers ---------- */
function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}
const fail = (res, code, msg, extra) => send(res, code, Object.assign({ error: msg }, extra));
function httpErr(code, msg) { return Object.assign(new Error(msg), { code }); }
async function readBody(req, limit = 512 * 1024) {
  let raw;
  if (req.body !== undefined && req.body !== null) {      // already parsed by the platform
    if (Buffer.isBuffer(req.body)) raw = req.body.toString();
    else if (typeof req.body === 'string') raw = req.body;
    else if (typeof req.body === 'object') return req.body;
  }
  if (raw === undefined) {
    raw = await new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (ch) => { size += ch.length; if (size > limit) reject(httpErr(413, 'Request too large')); else chunks.push(ch); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString()));
      req.on('error', reject);
    });
  }
  if (raw.length > limit) throw httpErr(413, 'Request too large');
  if (!raw) return {};
  try { const j = JSON.parse(raw); return j && typeof j === 'object' ? j : {}; } catch { throw httpErr(400, 'Bad JSON'); }
}
const bearer = (req) => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? verifyToken(h.slice(7)) : null; };
const ipOf = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '?';
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/* ---------- routes ---------- */
async function api(req, res, url) {
  const route = req.method + ' ' + url.pathname.replace(/\/+$/, '');
  if (!APP_URL) APP_URL = (req.headers['x-forwarded-proto'] || 'https') + '://' + req.headers.host;

  if (route === 'GET /api/health') { await q('select 1'); return send(res, 200, { ok: true }); }

  /* --- people --- */
  if (route === 'POST /api/register') {
    if (await limited('reg:' + ipOf(req), 10, 3600e3)) return fail(res, 429, 'Too many attempts. Please try again later.');
    const b = await readBody(req, 8192);
    const name = str(b.name, 80).trim().replace(/\s+/g, ' '), email = str(b.email, 320).trim().toLowerCase(), college = str(b.college, 120).trim().replace(/\s+/g, ' ');
    const age = Number(b.age), pw = typeof b.password === 'string' ? b.password : '';
    if (name.length < 2) return fail(res, 400, 'Please enter your full name');
    if (!EMAIL_RE.test(email)) return fail(res, 400, 'Please enter a valid email address');
    if (!Number.isInteger(age) || age < 5 || age > 120) return fail(res, 400, 'Please enter a valid age');
    if (college.length < 2) return fail(res, 400, 'Please enter your college or university');
    if (pw.length < 6 || pw.length > 200) return fail(res, 400, 'Password must be at least 6 characters');
    const oldR = await q('select status from users where email = $1', [email]);
    if (oldR.rows[0]) return fail(res, 409, oldR.rows[0].status === 'pending' ? 'This email already has a registration waiting for approval' : 'This email is already registered. Try logging in.');
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(pw, salt);
    const u = { email, name, age, college, salt: salt.toString('base64'), hash: hash.toString('base64'), status: 'pending', created: Date.now(), approvedAt: 0, state: null, updated: 0 };
    const ins = await q('insert into users (email, pid, status, xp, name, created, data) values ($1,$2,$3,0,$4,$5,$6) on conflict (email) do nothing', [email, pid(email), 'pending', name, u.created, u]);
    if (!ins.rowCount) return fail(res, 409, 'This email is already registered. Try logging in.');
    if (env('ADMIN_EMAIL')) { const m = mails.adminNotice(u); await sendMail(env('ADMIN_EMAIL'), m.subject, m.text, m.html); }
    return send(res, 201, { ok: true, status: 'pending' });
  }

  if (route === 'POST /api/login') {
    if (await limited('login:' + ipOf(req), 10, 900e3)) return fail(res, 429, 'Too many attempts. Please wait a few minutes.');
    const b = await readBody(req, 4096);
    const email = str(b.email, 320).trim().toLowerCase(), pw = typeof b.password === 'string' ? b.password : '';
    const r = await q('select data from users where email = $1', [email]);
    const u = r.rows[0] ? r.rows[0].data : null;
    const hash = await scrypt(pw, u ? Buffer.from(u.salt, 'base64') : crypto.randomBytes(16)); // same work either way
    if (!u || !crypto.timingSafeEqual(hash, Buffer.from(u.hash, 'base64'))) return fail(res, 401, 'Wrong email or password');
    if (u.status === 'pending') return fail(res, 403, 'Your registration is waiting for admin approval. You will get an email when it is ready.', { status: 'pending' });
    if (u.status === 'rejected') return fail(res, 403, 'Your registration was not approved.', { status: 'rejected' });
    return send(res, 200, { token: sign({ u: email }, TOKEN_DAYS), user: publicUser(u) });
  }

  /* --- admin --- */
  if (route === 'POST /api/admin/login') {
    if (await limited('adm:' + ipOf(req), 8, 900e3)) return fail(res, 429, 'Too many attempts. Please wait a few minutes.');
    const b = await readBody(req, 2048);
    const ap = env('ADMIN_PASSWORD');
    if (!ap) throw Object.assign(new Error('Server is missing ADMIN_PASSWORD'), { code: 'CONFIG' });
    if (!crypto.timingSafeEqual(sha(b.password), sha(ap))) return fail(res, 401, 'Wrong admin password');
    return send(res, 200, { token: sign({ r: 'admin' }, 0.5) });
  }
  if (url.pathname.startsWith('/api/admin/')) {
    const t = bearer(req);
    if (!t || t.r !== 'admin') return fail(res, 401, 'Admin login required');
    if (route === 'GET /api/admin/users') {
      const r = await q('select data from users order by created desc');
      const users = r.rows.map((x) => x.data).map((u) => Object.assign(publicUser(u), {
        status: u.status, created: u.created, approvedAt: u.approvedAt, xp: u.state ? u.state.progress.xp : 0, streak: u.state ? u.state.progress.streak : 0, levels: levelsDone(u)
      }));
      return send(res, 200, { users, mail: { configured: !!getTransport(), installed: !!nodemailer } });
    }
    const b = await readBody(req, 2048);
    const email = str(b.email, 320).toLowerCase();
    if (route === 'POST /api/admin/approve' || route === 'POST /api/admin/resend' || route === 'POST /api/admin/reject') {
      const res2 = await tx(async (c) => {
        const u = await getUser(c, email, true);
        if (!u) return { code: 404, error: 'No such user' };
        const was = u.status;
        if (route.endsWith('resend')) { if (u.status !== 'approved') return { code: 400, error: 'Only approved users can be sent this email' }; return { u }; }
        if (route.endsWith('approve')) { u.status = 'approved'; if (was !== 'approved') u.approvedAt = Date.now(); } else u.status = 'rejected';
        await putUser(c, u);
        return { u, was };
      });
      if (res2.error) return fail(res, res2.code, res2.error);
      let r = { status: 'skipped', error: '' };
      if (!route.endsWith('reject')) { const m = mails.approved(res2.u); r = await sendMail(res2.u.email, m.subject, m.text, m.html); }
      else if (res2.was === 'pending') { const m = mails.rejected(res2.u); r = await sendMail(res2.u.email, m.subject, m.text, m.html); }
      return send(res, 200, { ok: true, mail: r.status, mailError: r.error });
    }
    return fail(res, 404, 'Not found');
  }

  /* --- signed-in, approved users --- */
  const t = bearer(req);
  let u = null;
  if (t && t.u) { const r = await q('select data from users where email = $1', [t.u]); u = r.rows[0] ? r.rows[0].data : null; }
  if (!u || u.status !== 'approved') return fail(res, 401, 'Your session ended. Please log in again.');

  if (route === 'GET /api/state') return send(res, 200, { user: publicUser(u), state: u.state });
  if (route === 'PUT /api/state') {
    const b = await readBody(req);
    const incoming = cleanState(b);
    const state = await tx(async (c) => {
      const cur = await getUser(c, u.email, true);
      cur.state = b.replace === true ? incoming : mergeState(cur.state, incoming);   // replace only for "reset progress"
      cur.updated = Date.now();
      await putUser(c, cur);
      return cur.state;
    });
    return send(res, 200, { ok: true, state });
  }

  /* --- leaderboard, friends, battles --- */
  if (route === 'GET /api/social') return send(res, 200, await socialView(u));
  if (route === 'POST /api/friends') return send(res, ...(await friendsAction(u, await readBody(req, 2048))));
  if (route === 'POST /api/battles') return send(res, ...(await battleAction(u, await readBody(req, 4096))));
  if (route === 'GET /api/battle') {
    const me = pid(u.email), r = await q('select data from battles where id = $1', [str(url.searchParams.get('id'), 40)]);
    const b = r.rows[0] ? r.rows[0].data : null;
    if (!b || (b.a !== me && b.b !== me)) return fail(res, 404, 'No such battle');
    if (refreshBattle(b)) await q('update battles set data = $2, status = $3, ended = $4 where id = $1', [b.id, b, b.status, b.end || 0]);
    return send(res, 200, { battle: await battleViewFor(b), me });
  }
  return fail(res, 404, 'Not found');
}

async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return fail(res, 400, 'Bad URL'); }
  try {
    return await api(req, res, url);
  } catch (e) {
    if (e.code === 413 || e.code === 400) return fail(res, e.code, e.message);
    if (e.code === 'CONFIG') return fail(res, 500, e.message);
    console.error(e);
    if (!res.headersSent) fail(res, 500, 'Server error');
  }
}
module.exports = { handler };
