'use strict';
/* Pure helpers shared by the online (Vercel) backend: validation and merging of saved progress. */
const crypto = require('crypto');
const num = (v, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : lo; };
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
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
    extra: { from, ex, t: num(e.t, 0, 9e15), profile: { name: '', gender, av } }
  };
}
const dayVal = (s) => { const t = Date.parse(s); return Number.isNaN(t) ? 0 : t; };
function mergeEx(a, b) {
  const r = {}; a = a || {}; b = b || {};
  new Set([...Object.keys(a), ...Object.keys(b)]).forEach((k) => { r[k] = [...new Set([...(a[k] || []), ...(b[k] || [])])]; });
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
    extra: Object.assign({}, b.extra.t > a.extra.t ? b.extra : a.extra.t > b.extra.t ? a.extra : ((b.extra.profile.gender || !a.extra.profile.gender) ? b.extra : a.extra), { ex: mergeEx(a.extra.ex, b.extra.ex) })
  };
}

const pid = (email) => crypto.createHash('sha256').update('pp:' + email).digest('hex').slice(0, 10);
const levelsDone = (u) => (u.state ? Object.values(u.state.progress.dn).reduce((n, a) => n + a.length, 0) : 0);
const xpOf = (x) => (x.state ? x.state.progress.xp : 0);
module.exports = { num, str, cleanState, mergeState, mergeEx, dayVal, pid, levelsDone, xpOf };
