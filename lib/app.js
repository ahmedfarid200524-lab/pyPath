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
  const feedUsers = [u, ...friendUsers.filter((x) => fr[pid(x.email)] === 'friend')];
  return { me: { id: me, name: u.name, rank: rk.rows[0].c + 1, xp: xpOf(u) }, feed: feedOf(feedUsers, cards), lb, friends: pick('friend'), incoming: pick('in'), outgoing: pick('out'), battles: list.map((b) => battleView(b, cardOf)) };
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


/* ---------- community posts ---------- */
const POST_KINDS = ['project', 'question', 'tip'];
const HIDE_AFTER_REPORTS = 3;
const cleanText = (v, n) => str(v, n * 2).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n').trim().slice(0, n);
const newId = () => crypto.randomBytes(8).toString('hex');
async function friendIds(u) { const fr = u.friends || {}; return Object.keys(fr).filter((k) => fr[k] === 'friend'); }

/* Turn rows of the posts table into what the app shows (reposts show the original post with who reposted it). */
async function postsOut(rows, me) {
  const origIds = [...new Set(rows.map((r) => r.ref || r.id))];
  const oR = origIds.length ? await q('select id, author, created, kind, body, code, del from posts where id = any($1)', [origIds]) : { rows: [] };
  const orig = {}; oR.rows.forEach((r) => { orig[r.id] = r; });
  const grp = async (sql) => { const m = {}; if (origIds.length) (await q(sql, [origIds])).rows.forEach((r) => { m[r.k] = r.n; }); return m; };
  const likes = await grp('select post as k, count(*)::int as n from post_likes where post = any($1) group by post');
  const coms = await grp('select post as k, count(*)::int as n from post_comments where post = any($1) and not del group by post');
  const reps = await grp("select ref as k, count(*)::int as n from posts where ref = any($1) and not del group by ref");
  const reports = await grp('select post as k, count(*)::int as n from post_reports where post = any($1) group by post');
  const mineL = new Set(), mineR = new Set();
  if (origIds.length) {
    (await q('select post from post_likes where post = any($1) and pid = $2', [origIds, me])).rows.forEach((r) => mineL.add(r.post));
    (await q('select ref from posts where ref = any($1) and author = $2 and not del', [origIds, me])).rows.forEach((r) => mineR.add(r.ref));
  }
  const people = [...new Set(rows.map((r) => r.author).concat(Object.values(orig).map((o) => o.author)))];
  const cards = {}; (await usersByPids(people)).forEach((x) => { const c = card(x); cards[c.id] = c; });
  const out = [], seen = new Set();
  rows.forEach((r) => {
    const o = orig[r.ref || r.id];
    if (o && seen.has(o.id)) return;   // a post and its repost show once (the newest entry)
    if (!o || o.del || (reports[o.id] || 0) >= HIDE_AFTER_REPORTS || !cards[o.author]) return;
    if (r.ref && !cards[r.author]) return;
    seen.add(o.id);
    out.push({ id: o.id, t: r.created, postedAt: o.created, kind: o.kind, body: o.body, code: o.code, by: r.ref ? cards[r.author] : null, author: cards[o.author],
      likes: likes[o.id] || 0, comments: coms[o.id] || 0, reposts: reps[o.id] || 0, liked: mineL.has(o.id), reposted: mineR.has(o.id), mine: o.author === me });
  });
  return out;
}
async function postsList(u, url) {
  const me = pid(u.email), scope = str(url.searchParams.get('scope'), 8), before = num(url.searchParams.get('before'), 0, 9e15) || 9e15;
  let authors = null;
  if (scope === 'friends') authors = [me, ...(await friendIds(u))];
  else if (scope === 'user') authors = [str(url.searchParams.get('uid'), 20) || me];
  const r = await q('select id, author, created, ref from posts where not del and created < $1' + (authors ? ' and author = any($2)' : '') + ' order by created desc limit 21', authors ? [before, authors] : [before]);
  const more = r.rows.length > 20;
  return { posts: await postsOut(r.rows.slice(0, 20), me), more, next: more ? r.rows[19].created : 0 };
}
async function postGet(u, url) {
  const me = pid(u.email), id = str(url.searchParams.get('id'), 20);
  const r = await q('select id, author, created, ref from posts where id = $1 and not del', [id]);
  const posts = r.rows.length ? await postsOut(r.rows, me) : [];
  if (!posts.length) return [404, { error: 'This post is not available any more' }];
  const cr = await q('select id, author, created, body from post_comments where post = $1 and not del order by created asc limit 100', [posts[0].id]);
  const cards = {}; (await usersByPids([...new Set(cr.rows.map((c) => c.author))])).forEach((x) => { const c = card(x); cards[c.id] = c; });
  return [200, { post: posts[0], comments: cr.rows.filter((c) => cards[c.author]).map((c) => ({ id: c.id, t: c.created, body: c.body, author: cards[c.author], mine: c.author === me })) }];
}
async function postAction(u, b) {
  const me = pid(u.email), act = str(b.action, 12), id = str(b.id, 20);
  const rootOf = async (pidv) => { const r = await q('select id, author, ref, del from posts where id = $1', [pidv]); const x = r.rows[0]; if (!x || x.del) return null; if (x.ref) { const o = await q('select id, author, ref, del from posts where id = $1', [x.ref]); return o.rows[0] && !o.rows[0].del ? o.rows[0] : null; } return x; };
  if (act === 'create') {
    if (await limited('post:' + me, 12, 3600e3)) return [429, { error: 'You are posting a lot. Please try again in a little while.' }];
    const kind = str(b.kind, 10), body = cleanText(b.body, 280), code = cleanText(b.code, 600);
    if (!POST_KINDS.includes(kind)) return [400, { error: 'Choose what kind of post this is' }];
    if (body.length < 3) return [400, { error: 'Write a little more' }];
    const n = (await q('select count(*)::int as n from posts where author = $1 and not del and ref = $2 and body = $3 and created > $4', [me, '', body, Date.now() - 864e5])).rows[0].n;
    if (n) return [409, { error: 'You already posted that' }];
    const post = { id: newId(), t: Date.now() };
    await q('insert into posts (id, author, created, kind, body, code) values ($1,$2,$3,$4,$5,$6)', [post.id, me, post.t, kind, body, code]);
    return [200, { ok: true, id: post.id }];
  }
  if (await limited('pact:' + me, 150, 600e3)) return [429, { error: 'Slow down a little' }];
  if (act === 'delete') {
    const r = await q('update posts set del = true where id = $1 and author = $2 and not del', [id, me]);
    return r.rowCount ? [200, { ok: true }] : [404, { error: 'Post not found' }];
  }
  if (act === 'delcomment') {
    const r = await q('update post_comments set del = true where id = $1 and author = $2 and not del', [id, me]);
    return r.rowCount ? [200, { ok: true }] : [404, { error: 'Comment not found' }];
  }
  const o = await rootOf(id);
  if (!o) return [404, { error: 'This post is not available any more' }];
  if (act === 'like') {
    const del = await q('delete from post_likes where post = $1 and pid = $2', [o.id, me]);
    if (!del.rowCount) await q('insert into post_likes (post, pid) values ($1,$2) on conflict do nothing', [o.id, me]);
    return [200, { ok: true, liked: !del.rowCount }];
  }
  if (act === 'repost') {
    if (o.author === me) return [400, { error: 'You cannot repost your own post' }];
    const del = await q('update posts set del = true where ref = $1 and author = $2 and not del', [o.id, me]);
    if (!del.rowCount) await q("insert into posts (id, author, created, kind, body, ref) values ($1,$2,$3,'repost','',$4)", [newId(), me, Date.now(), o.id]);
    return [200, { ok: true, reposted: !del.rowCount }];
  }
  if (act === 'comment') {
    if (await limited('com:' + me, 30, 600e3)) return [429, { error: 'Slow down a little' }];
    const body = cleanText(b.body, 280);
    if (body.length < 1) return [400, { error: 'Write something first' }];
    await q('insert into post_comments (id, post, author, created, body) values ($1,$2,$3,$4,$5)', [newId(), o.id, me, Date.now(), body]);
    return [200, { ok: true }];
  }
  if (act === 'report') {
    if (o.author === me) return [400, { error: 'This is your own post' }];
    await q('insert into post_reports (post, pid) values ($1,$2) on conflict do nothing', [o.id, me]);
    return [200, { ok: true }];
  }
  return [400, { error: 'Unknown action' }];
}
async function profileView(u) {
  const me = pid(u.email), fr = await friendIds(u);
  const rk = await q("select count(*)::int as c from users where status = 'approved' and (xp > $1 or (xp = $1 and name < $2))", [xpOf(u), u.name]);
  const tot = await q("select count(*)::int as c from users where status = 'approved'");
  const above = await q("select name, xp from users where status = 'approved' and (xp > $1 or (xp = $1 and name < $2)) order by xp asc, name desc limit 1", [xpOf(u), u.name]);
  const pc = await q('select count(*)::int as c from posts where author = $1 and not del and ref = $2', [me, '']);
  const friends = (await usersByPids(fr)).map((x) => card(x)).sort((a, b) => b.xp - a.xp);
  return { me: card(u), rank: rk.rows[0].c + 1, total: tot.rows[0].c, ahead: above.rows[0] ? { name: above.rows[0].name, gap: Math.max(1, above.rows[0].xp - xpOf(u) + 1) } : null, posts: pc.rows[0].c, friends };
}

/* ---------- friend activity feed ---------- */
const FEED_KINDS = ['unit', 'streak', 'badge', 'cert', 'daily', 'battle', 'level'];
async function feedPost(u0, b) {
  const me = pid(u0.email);
  if (await limited('feed:' + me, 40, 600e3)) return [429, { error: 'Slow down a little' }];
  const kind = str(b.kind, 12), text = str(b.text, 90).trim().replace(/\s+/g, ' ');
  if (!FEED_KINDS.includes(kind) || text.length < 2) return [400, { error: 'Nothing to share' }];
  await tx(async (c) => {
    const u = await getUser(c, u0.email, true);
    u.feed = [{ t: Date.now(), k: kind, x: text }, ...(u.feed || [])].slice(0, 15);
    await putUser(c, u);
  });
  return [200, { ok: true }];
}
function feedOf(users, cards) {
  const out = [];
  users.forEach((x) => (x.feed || []).forEach((f) => { const c = cards[pid(x.email)] || card(x); out.push({ t: f.t, k: f.k, x: f.x, id: c.id, name: c.name, g: c.g, av: c.av }); }));
  return out.sort((p, q) => q.t - p.t).slice(0, 30);
}

/* ---------- study groups / classes ---------- */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(6), (x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
function progressOf(x, withDetail) {
  const c = card(x), p = x.state ? x.state.progress : { dn: {}, last: '' }, g = x.state && x.state.extra && x.state.extra.g ? x.state.extra.g : {};
  const o = Object.assign({}, c, { last: p.last || '', upd: x.updated || 0, dc: g.dc || 0, bd: (g.bd || []).length });
  if (withDetail) o.dn = p.dn || {};
  return o;
}
async function groupsView(u) {
  const me = pid(u.email);
  const r = await q("select id, code, owner, name, created, data from groups where data->'members' ? $1 order by created desc limit 30", [me]);
  const allIds = [...new Set(r.rows.flatMap((g) => Object.keys(g.data.members)))];
  const users = await usersByPids(allIds), byPid = {};
  users.forEach((x) => { byPid[pid(x.email)] = x; });
  return {
    groups: r.rows.map((g) => {
      const mine = g.data.members[me], owner = mine && mine.role === 'owner';
      const members = Object.keys(g.data.members).filter((id) => byPid[id]).map((id) => Object.assign({ role: g.data.members[id].role, joined: g.data.members[id].t }, progressOf(byPid[id], owner)))
        .sort((p, q) => q.xp - p.xp);
      return { id: g.id, name: g.name, role: owner ? 'owner' : 'member', code: owner ? g.code : '', created: Number(g.created), members };
    })
  };
}
async function groupAction(u, b) {
  const me = pid(u.email), act = str(b.action, 10);
  if (act === 'create') {
    if (await limited('gc:' + me, 10, 3600e3)) return [429, { error: 'Too many groups created. Try again later.' }];
    const name = str(b.name, 40).trim().replace(/\s+/g, ' ');
    if (name.length < 2) return [400, { error: 'Give the group a name' }];
    const own = await q("select count(*)::int as c from groups where owner = $1", [me]);
    if (own.rows[0].c >= 5) return [400, { error: 'You can run up to 5 groups' }];
    for (let i = 0; i < 6; i++) {
      const id = crypto.randomBytes(8).toString('base64url'), code = newCode(), now = Date.now();
      const ins = await q('insert into groups (id, code, owner, name, created, data) values ($1,$2,$3,$4,$5,$6) on conflict do nothing', [id, code, me, name, now, { members: { [me]: { role: 'owner', t: now } } }]);
      if (ins.rowCount) return [200, { ok: true, id, code }];
    }
    return [500, { error: 'Could not make a code. Try again.' }];
  }
  if (act === 'join') {
    if (await limited('gj:' + me, 15, 600e3)) return [429, { error: 'Too many tries. Please wait a few minutes.' }];
    const code = str(b.code, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) return [400, { error: 'Enter the group code' }];
    return tx(async (c) => {
      const r = await c.query('select id, data from groups where code = $1 for update', [code]);
      if (!r.rows[0]) return [404, { error: 'No group with that code' }];
      const g = r.rows[0].data;
      if (g.members[me]) return [200, { ok: true, id: r.rows[0].id }];
      if (Object.keys(g.members).length >= 100) return [400, { error: 'This group is full' }];
      const mine = await c.query("select count(*)::int as c from groups where data->'members' ? $1", [me]);
      if (mine.rows[0].c >= 20) return [400, { error: 'You are in too many groups' }];
      g.members[me] = { role: 'member', t: Date.now() };
      await c.query('update groups set data = $2 where id = $1', [r.rows[0].id, g]);
      return [200, { ok: true, id: r.rows[0].id }];
    });
  }
  return tx(async (c) => {
    const r = await c.query('select id, owner, data from groups where id = $1 for update', [str(b.id, 20)]);
    const row = r.rows[0];
    if (!row || !row.data.members[me]) return [404, { error: 'No such group' }];
    const owner = row.owner === me;
    if (act === 'leave') {
      if (owner) return [400, { error: 'You started this group. Delete it instead.' }];
      delete row.data.members[me];
      await c.query('update groups set data = $2 where id = $1', [row.id, row.data]);
    } else if (act === 'remove') {
      const t = str(b.pid, 20);
      if (!owner || t === me || !row.data.members[t]) return [400, { error: 'Cannot remove that person' }];
      delete row.data.members[t];
      await c.query('update groups set data = $2 where id = $1', [row.id, row.data]);
    } else if (act === 'delete') {
      if (!owner) return [403, { error: 'Only the group owner can delete it' }];
      await c.query('delete from groups where id = $1', [row.id]);
    } else if (act === 'rename') {
      const name = str(b.name, 40).trim().replace(/\s+/g, ' ');
      if (!owner || name.length < 2) return [400, { error: 'Cannot rename' }];
      await c.query('update groups set name = $2 where id = $1', [row.id, name]);
    } else return [400, { error: 'Unknown action' }];
    return [200, { ok: true }];
  });
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
    if (oldR.rows[0]) return fail(res, 409, 'This email is already registered. Try logging in.');
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(pw, salt);
    const now = Date.now();
    const u = { email, name, age, college, salt: salt.toString('base64'), hash: hash.toString('base64'), status: 'approved', created: now, approvedAt: now, state: null, updated: 0 };
    const ins = await q('insert into users (email, pid, status, xp, name, created, data) values ($1,$2,$3,0,$4,$5,$6) on conflict (email) do nothing', [email, pid(email), 'approved', name, u.created, u]);
    if (!ins.rowCount) return fail(res, 409, 'This email is already registered. Try logging in.');
    return send(res, 201, { ok: true, status: 'approved', token: sign({ u: email }, TOKEN_DAYS), user: publicUser(u) });
  }

  if (route === 'POST /api/login') {
    if (await limited('login:' + ipOf(req), 10, 900e3)) return fail(res, 429, 'Too many attempts. Please wait a few minutes.');
    const b = await readBody(req, 4096);
    const email = str(b.email, 320).trim().toLowerCase(), pw = typeof b.password === 'string' ? b.password : '';
    const r = await q('select data from users where email = $1', [email]);
    const u = r.rows[0] ? r.rows[0].data : null;
    const hash = await scrypt(pw, u ? Buffer.from(u.salt, 'base64') : crypto.randomBytes(16)); // same work either way
    if (!u || !crypto.timingSafeEqual(hash, Buffer.from(u.hash, 'base64'))) return fail(res, 401, 'Wrong email or password');
    if (u.status === 'pending') {          /* accounts made before approval was removed: let them in */
      u.status = 'approved'; u.approvedAt = Date.now();
      await tx(async (c) => { const cur = await getUser(c, u.email, true); if (cur && cur.status === 'pending') { cur.status = 'approved'; cur.approvedAt = u.approvedAt; await putUser(c, cur); } });
    }
    if (u.status === 'rejected') return fail(res, 403, 'This account has been blocked.', { status: 'rejected' });
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
  if (route === 'POST /api/feed') return send(res, ...(await feedPost(u, await readBody(req, 2048))));
  if (route === 'GET /api/posts') return send(res, 200, await postsList(u, url));
  if (route === 'GET /api/post') return send(res, ...(await postGet(u, url)));
  if (route === 'POST /api/posts') return send(res, ...(await postAction(u, await readBody(req, 4096))));
  if (route === 'GET /api/profile') return send(res, 200, await profileView(u));
  if (route === 'GET /api/groups') return send(res, 200, await groupsView(u));
  if (route === 'POST /api/groups') return send(res, ...(await groupAction(u, await readBody(req, 2048))));
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
