'use strict';
/* Pure helpers shared by the online (Vercel) backend: validation and merging of saved progress. */
const crypto = require('crypto');
const num = (v, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : lo; };
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const b01 = (v) => (v ? 1 : 0);
const tag = (v, n) => str(v, n).replace(/[^A-Za-z0-9_:\-]/g, '');
/* "g" holds the newer game features: onboarding, streak freezes, daily challenges, review queue, badges, certificates.
   Every field is optional, so accounts saved before these features existed stay valid. */
function cleanG(g) {
  g = g && typeof g === 'object' ? g : {};
  const d = g.d && typeof g.d === 'object' ? g.d : {};
  const q = Math.floor(Number(d.q));
  const c = Array.isArray(d.c) ? d.c : [];
  const rv = (Array.isArray(g.rv) ? g.rv : []).filter((x) => x && typeof x === 'object' && tag(x.i, 24)).slice(0, 150)
    .map((x) => ({ i: tag(x.i, 24), b: num(x.b, 0, 5), d: num(x.d, 0, 1e6) }));
  const bd = [...new Set((Array.isArray(g.bd) ? g.bd : []).map((x) => tag(x, 20)).filter(Boolean))].slice(0, 80);
  const ce = {};
  if (g.ce && typeof g.ce === 'object') Object.keys(g.ce).slice(0, 4).forEach((k) => {
    const v = g.ce[k]; if (v && typeof v === 'object') ce[tag(k, 30)] = { t: num(v.t, 0, 9e15), id: tag(v.id, 12), n: str(v.n, 40) };
  });
  return {
    t: num(g.t, 0, 9e15), ob: b01(g.ob), pd: b01(g.pd), pl: num(g.pl, 0, 99),
    fz: num(g.fz, 0, 9), fe: num(g.fe, 0, 1e4), fu: num(g.fu, 0, 1e4), fk: str(g.fk, 40), wp: b01(g.wp),
    ms: num(g.ms, 0, 1e5), dc: num(g.dc, 0, 1e5), da: num(g.da, 0, 1e5), rc: num(g.rc, 0, 1e6), sh: num(g.sh, 0, 1e5),
    d: { day: str(d.day, 10), l: num(d.l, 0, 999), p: num(d.p, 0, 999), q: Number.isFinite(q) ? Math.min(5, Math.max(-1, q)) : -1, c: [b01(c[0]), b01(c[1]), b01(c[2])], a: b01(d.a) },
    rv, bd, ce,
    th: g.th === 'l' ? 'l' : g.th === 'd' ? 'd' : '', lg: g.lg === 'ar' ? 'ar' : g.lg === 'en' ? 'en' : '',   /* theme + language */
    cs: num(g.cs, 0, 1e7), cb: num(g.cb, 0, 1e7), iv: cleanIv(g.iv)                                                                  /* coins spent + shop items owned */
  };
}
function cleanIv(v) {
  const r = {};
  if (v && typeof v === 'object') Object.keys(v).slice(0, 60).forEach((k) => { const n = num(v[k], 0, 999); if (n && tag(k, 24)) r[tag(k, 24)] = n; });
  return r;
}
function mergeG(a, b) {
  a = cleanG(a); b = cleanG(b);
  const nw = b.t >= a.t ? b : a, od = nw === b ? a : b;
  const sameDay = a.d.day && a.d.day === b.d.day;
  const d = sameDay
    ? { day: a.d.day, l: Math.max(a.d.l, b.d.l), p: Math.max(a.d.p, b.d.p), q: Math.max(a.d.q, b.d.q), c: [0, 1, 2].map((i) => a.d.c[i] || b.d.c[i]), a: a.d.a || b.d.a }
    : nw.d;
  const ce = Object.assign({}, od.ce, nw.ce);
  return {
    t: nw.t, ob: a.ob || b.ob, pd: a.pd || b.pd, pl: nw.pl || od.pl,
    fz: nw.fz, fk: nw.fk, wp: nw.wp, rv: nw.rv,
    fe: Math.max(a.fe, b.fe), fu: Math.max(a.fu, b.fu), ms: Math.max(a.ms, b.ms), dc: Math.max(a.dc, b.dc), da: Math.max(a.da, b.da), rc: Math.max(a.rc, b.rc), sh: Math.max(a.sh, b.sh),
    d, bd: [...new Set([...a.bd, ...b.bd])].slice(0, 80), ce,
    th: nw.th || od.th, lg: nw.lg || od.lg, cs: Math.max(a.cs, b.cs), cb: Math.max(a.cb, b.cb),
    iv: (() => { const r = {}; new Set([...Object.keys(a.iv), ...Object.keys(b.iv)]).forEach((k) => { r[k] = Math.max(a.iv[k] || 0, b.iv[k] || 0); }); return r; })()
  };
}
function cleanState(s) {
  s = s && typeof s === 'object' ? s : {};
  const p = s.progress && typeof s.progress === 'object' ? s.progress : {};
  const dn = {};
  if (p.dn && typeof p.dn === 'object') {
    Object.keys(p.dn).slice(0, 12).forEach((k) => {
      if (Array.isArray(p.dn[k])) dn[str(k, 30)] = [...new Set(p.dn[k].filter((i) => Number.isInteger(i) && i >= 0 && i < 5000))].sort((a, b) => a - b);
    });
  }
  const e = s.extra && typeof s.extra === 'object' ? s.extra : {};
  const from = {};
  if (e.from && typeof e.from === 'object') Object.keys(e.from).slice(0, 12).forEach((k) => { from[str(k, 30)] = num(e.from[k], 0, 5000); });
  const ex = {};
  if (e.ex && typeof e.ex === 'object') Object.keys(e.ex).slice(0, 12).forEach((k) => {
    if (Array.isArray(e.ex[k])) ex[str(k, 30)] = [...new Set(e.ex[k].filter((v) => typeof v === 'string' && v.length <= 12))].slice(0, 400);
  });
  const pr = e.profile && typeof e.profile === 'object' ? e.profile : {};
  const gender = pr.gender === 'f' ? 'f' : pr.gender === 'm' ? 'm' : '';
  const av = {};
  if (gender && pr.av && typeof pr.av === 'object') Object.keys(pr.av).slice(0, 20).forEach((k) => { if (typeof pr.av[k] === 'string') av[str(k, 12)] = str(pr.av[k], 24); });
  return {
    progress: { xp: num(p.xp, 0, 1e9), streak: num(p.streak, 0, 1e5), last: str(p.last, 40), course: str(p.course, 30) || 'python', dn },
    extra: { from, ex, t: num(e.t, 0, 9e15), profile: { name: '', gender, av }, g: cleanG(e.g) }
  };
}
const dayVal = (s) => { const t = Date.parse(s); return Number.isNaN(t) ? 0 : t; };
function mergeEx(a, b) {
  const r = {}; a = a || {}; b = b || {};
  new Set([...Object.keys(a), ...Object.keys(b)]).forEach((k) => { r[k] = [...new Set([...(a[k] || []), ...(b[k] || [])])]; });
  return r;
}
/* newest profile wins, but an empty profile / start-unit never wipes a filled one (a fresh device has a newer timestamp but nothing to say) */
function pickExtra(ea, eb, ex, g) {
  const base = eb.t > ea.t ? eb : ea.t > eb.t ? ea : ((eb.profile.gender || !ea.profile.gender) ? eb : ea);
  const other = base === eb ? ea : eb;
  const r = Object.assign({}, base, { ex, g });
  if (!base.profile.gender && other.profile.gender) r.profile = other.profile;
  if (!Object.keys(base.from || {}).length && Object.keys(other.from || {}).length) r.from = other.from;
  return r;
}
function mergeState(a, b) {
  if (!a) return b;
  const pa = a.progress, pb = b.progress, dn = {};
  new Set([...Object.keys(pa.dn), ...Object.keys(pb.dn)]).forEach((k) => {
    dn[k] = [...new Set([...(pa.dn[k] || []), ...(pb.dn[k] || [])])].sort((x, y) => x - y);
  });
  const da = dayVal(pa.last), db_ = dayVal(pb.last);
  return {
    progress: {
      xp: Math.max(pa.xp, pb.xp), dn, course: pb.course,
      last: db_ >= da ? pb.last : pa.last,
      streak: db_ > da ? pb.streak : da > db_ ? pa.streak : Math.max(pa.streak, pb.streak)
    },
    extra: pickExtra(a.extra, b.extra, mergeEx(a.extra.ex, b.extra.ex), mergeG(a.extra.g, b.extra.g))
  };
}

const pid = (email) => crypto.createHash('sha256').update('pp:' + email).digest('hex').slice(0, 10);
const levelsDone = (u) => (u.state ? Object.values(u.state.progress.dn).reduce((n, a) => n + a.length, 0) : 0);
const xpOf = (x) => (x.state ? x.state.progress.xp : 0);
module.exports = { num, str, cleanG, mergeG, cleanState, mergeState, mergeEx, dayVal, pid, levelsDone, xpOf };
