#!/usr/bin/env node
'use strict';
/*
 * pyPath content checker.
 *   node scripts/check-content.js content/js            (a whole course)
 *   node scripts/check-content.js content/js/u03.json   (one unit)
 *   node scripts/check-content.js --python              (the built-in Python course in index.html)
 *   node scripts/check-content.js --all                 (everything)
 * Exit code is 1 when any ERROR is found. See content/SCHEMA.md for the format.
 *
 * What is really executed:
 *   js    code runs in node with the same console formatting as the in-app runner
 *   cpp   code is compiled with g++ -std=c++17 and run
 *   cs    code is only syntax-checked (tree-sitter); there is no C# compiler available here
 *   html  markup is checked with html-validate; project checks run in jsdom
 *   python  index.html's Python course is run with python3
 */
const fs = require('fs'), path = require('path'), vm = require('vm'), os = require('os'), crypto = require('crypto');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(os.tmpdir(), 'pypath-check-cache');
fs.mkdirSync(CACHE, { recursive: true });
const req = (m) => require(path.join(__dirname, 'node_modules', m));

const errors = [], warns = [];
let where = '';
const err = (m) => errors.push(where + ': ' + m);
const warn = (m) => warns.push(where + ': ' + m);

/* ---------- helpers ---------- */
const norm = (s) => String(s == null ? '' : s).replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\s+$/, '');
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const ncs = (s) => String(s).replace(/\s+/g, '').replace(/'/g, '"');   // same rule the app uses for fill-in answers
function sh(cmd, args, o) {
  return new Promise((res) => {
    const p = spawn(cmd, args, Object.assign({ stdio: ['pipe', 'pipe', 'pipe'] }, o && o.opts));
    let out = '', er = '', done = false;
    const t = setTimeout(() => { if (!done) { try { p.kill('SIGKILL'); } catch (e) { /* */ } er += '\n[timeout]'; } }, (o && o.ms) || 15000);
    p.stdout.on('data', (d) => { if (out.length < 2e5) out += d; });
    p.stderr.on('data', (d) => { if (er.length < 2e5) er += d; });
    p.on('close', (code) => { done = true; clearTimeout(t); res({ code, out, err: er }); });
    p.on('error', (e) => { done = true; clearTimeout(t); res({ code: -1, out, err: String(e) }); });
    p.stdin.on('error', () => {});
    p.stdin.end((o && o.stdin) || '');
  });
}
/* tiny concurrency limiter so g++ does not run 200 times at once */
const LIM = Math.max(2, Math.min(8, os.cpus().length));
let active = 0; const waitq = [];
async function limit(fn) {
  if (active >= LIM) await new Promise((r) => waitq.push(r));
  active++;
  try { return await fn(); } finally { active--; const n = waitq.shift(); if (n) n(); }
}
const cached = async (key, fn) => {
  const f = path.join(CACHE, sha(key) + '.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* miss */ }
  const r = await fn(); fs.writeFileSync(f, JSON.stringify(r)); return r;
};

/* ---------- JavaScript (mirrors the in-app worker in index.html) ---------- */
function fmtArgs(a) { return Array.prototype.map.call(a, (x) => { if (typeof x === 'string') return x; try { return typeof x === 'object' ? JSON.stringify(x) : String(x); } catch (_) { return String(x); } }).join(' '); }
async function runJS(code) {
  return cached('js1:' + code, async () => {
    const out = []; let pend = 0, error = null;
    const con = { log() { out.push(fmtArgs(arguments)); }, info() { out.push(fmtArgs(arguments)); }, warn() { out.push(fmtArgs(arguments)); }, error() { out.push(fmtArgs(arguments)); } };
    const sandbox = { console: con, Math, JSON, Date, Number, String, Boolean, Array, Object, Promise, Map, Set, WeakMap, WeakSet, Symbol, RegExp, Error, TypeError, RangeError, SyntaxError, parseInt, parseFloat, isNaN, isFinite, BigInt, Intl, structuredClone,
      setTimeout(f, ms) { pend++; return setTimeout(() => { try { f(); } catch (e) { error = error || e; } pend--; }, Math.min(Number(ms) || 0, 1500)); },
      setInterval() { throw new Error('setInterval is not supported in checks'); }, clearTimeout };
    sandbox.queueMicrotask = queueMicrotask;
    vm.createContext(sandbox);
    try {
      const p = vm.runInContext('(async function(){\n' + code + '\n})()', sandbox, { timeout: 3000 });
      await Promise.race([p.then(() => 0, (e) => { error = e; }), new Promise((r) => setTimeout(r, 4000))]);
      const t0 = Date.now(); while (pend > 0 && Date.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 10));
    } catch (e) { error = e; }
    return { out: out.join('\n'), err: error ? (error.name || 'Error') + ': ' + (error.message || error) : null };
  });
}
async function jsTests(code, fn, tests) {
  const sandbox = { console: { log() {} }, Math, JSON, Date, Number, String, Array, Object, Map, Set, RegExp, Error, parseInt, parseFloat, isNaN, isFinite };
  vm.createContext(sandbox);
  let f;
  try { f = vm.runInContext('(function(){' + code + '\n;return typeof ' + fn + '==="function"?' + fn + ':null})()', sandbox, { timeout: 3000 }); } catch (e) { return tests.map((t) => ({ label: t.label, ok: false, msg: e.message })); }
  if (!f) return tests.map((t) => ({ label: t.label, ok: false, msg: 'no function ' + fn }));
  return tests.map((t) => { try { const g = f.apply(null, JSON.parse(JSON.stringify(t.args))); const ok = JSON.stringify(g) === JSON.stringify(t.want); return { label: t.label, ok, msg: ok ? '' : 'got ' + JSON.stringify(g) + ' want ' + JSON.stringify(t.want) }; } catch (e) { return { label: t.label, ok: false, msg: e.message }; } });
}

/* ---------- C++ ---------- */
const CPP_HEAD = '#include <iostream>\n#include <string>\n#include <vector>\n#include <map>\n#include <set>\n#include <cmath>\n#include <algorithm>\n#include <numeric>\n#include <sstream>\n#include <iomanip>\n#include <cstdlib>\n#include <climits>\n#include <functional>\n#include <memory>\n#include <array>\n#include <cstring>\n#include <utility>\nusing namespace std;\n';
async function compileCpp(src) {
  return cached('cpp1:' + src, () => limit(async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-')), f = path.join(d, 'a.cpp'), exe = path.join(d, 'a.out');
    fs.writeFileSync(f, src);
    const c = await sh('g++', ['-std=c++17', '-w', '-o', exe, f], { ms: 40000 });
    const r = { ok: c.code === 0, msg: c.err.split('\n').filter((l) => /error/.test(l)).slice(0, 2).join(' | ') };
    if (r.ok) r.exe = exe; else fs.rmSync(d, { recursive: true, force: true });
    return r;
  }));
}
async function runCppCode(code, stdin) {
  const hasMain = /\bmain\s*\(/.test(code), hasInc = /#include/.test(code);
  const tries = [];
  if (hasMain) tries.push(hasInc ? code : CPP_HEAD + code);
  else { tries.push(CPP_HEAD + 'int main(){\n' + code + '\nreturn 0;}\n'); tries.push(CPP_HEAD + code + '\nint main(){}\n'); }
  let last = null;
  for (const src of tries) {
    const key = 'cppRun:' + src + '\u0000' + (stdin || '');
    const r = await cached(key, () => limit(async () => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-')), f = path.join(d, 'a.cpp'), exe = path.join(d, 'a.out');
      fs.writeFileSync(f, src);
      const c = await sh('g++', ['-std=c++17', '-w', '-o', exe, f], { ms: 40000 });
      if (c.code !== 0) { fs.rmSync(d, { recursive: true, force: true }); return { compiled: false, msg: c.err.split('\n').filter((l) => /error/.test(l)).slice(0, 2).join(' | ') }; }
      const r2 = await sh(exe, [], { stdin: stdin || '', ms: 5000 });
      fs.rmSync(d, { recursive: true, force: true });
      return { compiled: true, out: r2.out, code: r2.code, err: r2.err };
    }));
    last = r; if (r.compiled) return r;
  }
  return last;
}

/* ---------- C# (syntax only) ---------- */
let CSP = null;
async function csParser() {
  if (CSP) return CSP;
  const TS = req('web-tree-sitter'); await TS.init();
  const lang = await TS.Language.load(path.join(__dirname, 'node_modules/tree-sitter-wasms/out/tree-sitter-c_sharp.wasm'));
  const p = new TS(); p.setLanguage(lang); CSP = p; return p;
}
async function csSyntax(code) {
  const p = await csParser();
  const t = p.parse(code);
  if (!t.rootNode.hasError()) return { ok: true };
  let first = null; (function walk(n) { if (first) return; if (n.isMissing() || n.type === 'ERROR') { first = n; return; } for (let i = 0; i < n.childCount; i++) walk(n.child(i)); })(t.rootNode);
  return { ok: false, msg: first ? 'near line ' + (first.startPosition.row + 1) + ': ' + (first.isMissing() ? 'missing ' + first.type : 'unexpected ' + JSON.stringify(first.text.slice(0, 30))) : 'syntax error' };
}

/* ---------- HTML ---------- */
let HV = null;
async function htmlValidate(markup) {
  if (!HV) { const { HtmlValidate } = req('html-validate'); HV = new HtmlValidate({ extends: ['html-validate:recommended'], rules: { 'no-trailing-whitespace': 'off', 'no-inline-style': 'off', 'void-style': 'off', 'attribute-boolean-style': 'off', 'attribute-empty-style': 'off', 'prefer-native-element': 'off', 'no-implicit-close': 'error', 'doctype-style': 'off', 'element-permitted-content': 'off', 'no-redundant-role': 'off', 'wcag/h30': 'off', 'wcag/h32': 'off', 'wcag/h36': 'off', 'wcag/h37': 'off', 'wcag/h67': 'off', 'wcag/h71': 'off', 'no-missing-references': 'error', 'require-sri': 'off', 'tel-non-breaking': 'off', 'long-title': 'off', 'prefer-tbody': 'off', 'heading-level': 'off', 'no-raw-characters': 'off', 'valid-id': 'off', 'no-dup-id': 'error', 'element-required-attributes': 'error', 'attribute-allowed-values': 'error', 'no-deprecated-attr': 'error', 'deprecated': 'error', 'unrecognized-char-ref': 'off', 'input-missing-label': 'off', 'form-dup-name': 'off', 'no-unknown-elements': 'error', 'close-order': 'error', 'close-attr': 'error', 'no-dup-attr': 'error', 'attr-quotes': 'off', 'attr-case': 'off', 'element-case': 'off', 'no-self-closing': 'off', 'script-type': 'off', 'missing-doctype': 'off', 'require-csp-nonce': 'off', 'element-name': 'off', 'no-conditional-comment': 'off', 'area-alt': 'off', 'meta-refresh': 'off', 'text-content': 'off', 'hidden-focusable': 'off', 'unique-landmark': 'off', 'multiple-labeled-controls': 'off', 'empty-heading': 'off', 'empty-title': 'off', 'no-autoplay': 'off', 'no-utf8-bom': 'off', 'prefer-button': 'off', 'prefer-tbody2': 'off', 'no-abstract-role': 'off', 'aria-label-misuse': 'off', 'allowed-links': 'off', 'wcag/h63': 'off', 'no-implicit-input-type': 'off', 'button-type': 'off', 'input-attributes': 'error', 'map-dup-name': 'off', 'map-id-name': 'off', 'no-implicit-button-type': 'off' } }); }
  const wrapped = /<html[\s>]|<!doctype/i.test(markup) ? markup : '<!doctype html><html lang="en"><head><title>t</title></head><body>\n' + markup + '\n</body></html>';
  const rep = await HV.validateString(wrapped);
  const msgs = [];
  rep.results.forEach((r) => r.messages.forEach((m) => { if (m.severity === 2) msgs.push(m.ruleId + ': ' + m.message); }));
  return msgs;
}
function htmlDom(markup) { const { JSDOM } = req('jsdom'); return new JSDOM(markup); }

/* ---------- schema checks ---------- */
const bad = (s) => typeof s !== 'string' || !s.trim();
const FORBID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u2028\u2029]/;
function textOk(s, label) { if (bad(s)) err(label + ' is empty or not text'); else if (FORBID.test(s)) err(label + ' has a control character'); else if (/(^|[^\\])\\u[0-9a-f]{4}/i.test(s) && false) err(label); }

const QTYPES = ['out', 'mc', 'fill', 'order'];
function checkQ(q, lang, label, o) {
  if (!q || typeof q !== 'object') return err(label + ' is not an object');
  if (!QTYPES.includes(q.type)) return err(label + ' has bad type ' + q.type);
  if (q.type === 'out' || q.type === 'mc') {
    const ans = q.type === 'out' ? q.answer : q.ans;
    textOk(ans, label + ' answer');
    if (!Array.isArray(q.wrong) || q.wrong.length !== 3) err(label + ' needs exactly 3 wrong options');
    else {
      const all = [ans].concat(q.wrong).map((x) => String(x));
      if (new Set(all.map((x) => x.trim())).size !== 4) err(label + ' options are not 4 different answers');
      all.forEach((x) => { if (x.length > 90) err(label + ' option too long (' + x.length + '): ' + x.slice(0, 30)); if (!x.trim()) err(label + ' has an empty option'); });
    }
    if (q.type === 'out' && bad(q.code)) err(label + ' (out) needs code');
    if (q.type === 'mc') { textOk(q.q, label + ' question'); if (q.code != null && bad(q.code)) err(label + ' code must be text or null'); }
  }
  if (q.type === 'fill') {
    if (bad(q.code) || !/___/.test(q.code)) err(label + ' (fill) code needs a ___ blank');
    if ((q.code || '').split('___').length > 2) err(label + ' (fill) must have exactly one blank');
    if (!Array.isArray(q.ans) || !q.ans.length || q.ans.some(bad)) err(label + ' (fill) needs ans: [accepted answers]');
  }
  if (q.type === 'order') {
    if (!Array.isArray(q.lines) || q.lines.length < 3 || q.lines.length > 8) err(label + ' (order) needs 3-8 lines');
    else if (new Set(q.lines.map((l) => l.trim())).size !== q.lines.length) err(label + ' (order) has duplicate lines (ambiguous order)');
    else if (q.lines.some((l) => l.length > 60)) err(label + ' (order) has a line longer than 60 characters');
  }
  textOk(q.why, label + ' why');
  if (q.why && q.why.length > 400) warn(label + ' why is long');
}
/* executes a question when the language allows it; returns a promise */
async function runQ(q, lang, label) {
  if (q.noexec) { noexec++; return; }
  if (lang === 'js') {
    if (q.type === 'out') { const r = await runJS(q.code); if (r.err) err(label + ' code throws: ' + r.err); else if (norm(r.out) !== norm(q.answer)) err(label + ' answer "' + q.answer + '" but the code prints "' + norm(r.out) + '"'); }
    else if (q.type === 'fill') {
      const outs = [];
      for (const a of q.ans) { const r = await runJS(q.code.replace('___', a)); if (r.err) err(label + ' (fill) answer "' + a + '" makes the code throw: ' + r.err); outs.push(norm(r.out)); }
      if (new Set(outs).size > 1) err(label + ' (fill) accepted answers give different output');
    } else if (q.type === 'order') { const r = await runJS(q.lines.join('\n')); if (r.err) err(label + ' (order) correct order throws: ' + r.err); }
  } else if (lang === 'cpp') {
    if (q.type === 'out') { const r = await runCppCode(q.code, ''); if (!r.compiled) err(label + ' does not compile: ' + r.msg); else if (norm(r.out) !== norm(q.answer)) err(label + ' answer "' + q.answer + '" but the program prints "' + norm(r.out) + '"'); }
    else if (q.type === 'fill') {
      const outs = [];
      for (const a of q.ans) { const r = await runCppCode(q.code.replace('___', a), ''); if (!r.compiled) err(label + ' (fill) answer "' + a + '" does not compile: ' + r.msg); else outs.push(norm(r.out)); }
      if (new Set(outs).size > 1) err(label + ' (fill) accepted answers give different output');
    } else if (q.type === 'order') { const r = await runCppCode(q.lines.join('\n'), ''); if (!r.compiled) err(label + ' (order) correct order does not compile: ' + r.msg); }
  } else if (lang === 'cs') {
    const code = q.type === 'fill' ? q.code.replace('___', q.ans[0]) : q.type === 'order' ? q.lines.join('\n') : q.code;
    if (code) { const r = await csSyntax(code); if (!r.ok) err(label + ' C# syntax: ' + r.msg); }
  } else if (lang === 'html') {
    const code = q.type === 'fill' ? q.code.replace('___', q.ans[0]) : q.type === 'order' ? q.lines.join('\n') : null;
    if (code && /<\w/.test(code)) { const m = await htmlValidate(code); if (m.length) warn(label + ' html: ' + m.slice(0, 2).join('; ')); }
  }
}
let noexec = 0;

async function checkBugItem(it, lang, label) {
  ['code', 'fixed', 'symptom', 'why'].forEach((k) => textOk(it[k], label + ' ' + k));
  if (bad(it.code) || bad(it.fixed)) return;
  const a = it.code.split('\n'), b = it.fixed.split('\n');
  if (!Number.isInteger(it.line) || it.line < 0 || it.line >= a.length) return err(label + ' line must be a 0-based index into code');
  if (a.length !== b.length) return err(label + ' code and fixed must have the same number of lines');
  const diff = a.map((l, i) => (l !== b[i] ? i : -1)).filter((i) => i >= 0);
  if (diff.length !== 1 || diff[0] !== it.line) err(label + ' code and fixed must differ on exactly one line, and it must be line ' + it.line + ' (they differ on: ' + JSON.stringify(diff) + ')');
  if (it.noexec) { noexec++; return; }
  if (lang === 'js') {
    const f = await runJS(it.fixed), c = await runJS(it.code);
    if (f.err) err(label + ' fixed code throws: ' + f.err);
    if (!c.err && !f.err && norm(c.out) === norm(f.out)) err(label + ' the bug changes nothing: both versions print the same');
    if (c.err && /SyntaxError|ReferenceError|TypeError|RangeError/.test(c.err) === false && !c.err) err(label + ' ?');
  } else if (lang === 'cpp') {
    const f = await runCppCode(it.fixed, ''), c = await runCppCode(it.code, '');
    if (!f.compiled) err(label + ' fixed code does not compile: ' + f.msg);
    else if (c.compiled && norm(c.out) === norm(f.out) && c.code === f.code) err(label + ' the bug changes nothing: same output and exit code');
    if (f.compiled && !/main\s*\(/.test(it.fixed)) err(label + ' bug code must be a complete program with main()');
  } else if (lang === 'cs') {
    const f = await csSyntax(it.fixed); if (!f.ok) err(label + ' fixed C# syntax: ' + f.msg);
  } else if (lang === 'html') {
    const f = await htmlValidate(it.fixed); if (f.length) err(label + ' fixed html is not valid: ' + f.slice(0, 2).join('; '));
    const c = await htmlValidate(it.code); if (!c.length && !it.semantic) err(label + ' the buggy html passes validation; if the bug is not a markup error set "semantic": true');
  }
}

async function checkProject(p, lang, label) {
  ['title', 'brief', 'starter'].forEach((k) => textOk(p[k], label + ' ' + k));
  if (!Array.isArray(p.tests) || p.tests.length < 4) return err(label + ' needs at least 4 tests');
  if (bad(p.solution)) err(label + ' needs a reference "solution"');
  if (p.tests.some((t) => bad(t.label))) err(label + ' every test needs a label');
  if (new Set(p.tests.map((t) => t.label)).size !== p.tests.length) err(label + ' test labels must be unique');
  if (bad(p.solution)) return;
  if (lang === 'js') {
    if (bad(p.fn)) return err(label + ' needs "fn" (the function name)');
    p.tests.forEach((t) => { if (!Array.isArray(t.args) || !('want' in t)) err(label + ' test "' + t.label + '" needs args[] and want'); });
    const sol = await jsTests(p.solution, p.fn, p.tests);
    sol.filter((x) => !x.ok).forEach((x) => err(label + ' reference solution fails "' + x.label + '": ' + x.msg));
    const st = await jsTests(p.starter, p.fn, p.tests);
    if (st.every((x) => x.ok)) err(label + ' the starter already passes every test');
    const r = await runJS(p.starter); if (r.err && !/not defined|is not a function/.test(r.err)) warn(label + ' starter throws on load: ' + r.err);
  } else if (lang === 'html') {
    p.tests.forEach((t) => { if (bad(t.expr)) err(label + ' test "' + t.label + '" needs expr'); });
    const m = await htmlValidate(p.solution); if (m.length) err(label + ' solution html is not valid: ' + m.slice(0, 3).join('; '));
    const dsol = htmlDom(p.solution).window, dst = htmlDom(p.starter).window;
    const evalT = (win, t) => { try { return !!new win.Function('document', 'window', 'return (' + t.expr + ')')(win.document, win); } catch (e) { return false; } };
    p.tests.forEach((t) => { if (!evalT(dsol, t)) err(label + ' reference solution fails "' + t.label + '"'); });
    if (p.tests.every((t) => evalT(dst, t))) err(label + ' the starter already passes every test');
    if (!p.tests.some((t) => !evalT(dst, t))) err(label + ' no test fails on the starter');
  } else if (lang === 'cpp' || lang === 'cs') {
    p.tests.forEach((t) => { if (!Array.isArray(t.must) || !t.must.length) err(label + ' test "' + t.label + '" needs must:[regex]'); (t.must || []).concat(t.mustNot || []).forEach((r) => { try { new RegExp(r); } catch (e) { err(label + ' bad regex ' + r); } }); });
    const clean = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
    const pass = (code, t) => (t.must || []).every((r) => new RegExp(r).test(clean(code))) && (t.mustNot || []).every((r) => !new RegExp(r).test(clean(code)));
    p.tests.forEach((t) => { if (!pass(p.solution, t)) err(label + ' reference solution fails check "' + t.label + '"'); });
    if (p.tests.every((t) => pass(p.starter, t))) err(label + ' the starter already passes every check');
    const failing = p.tests.filter((t) => !pass(p.starter, t)).length; if (failing < Math.ceil(p.tests.length / 2)) warn(label + ' starter passes ' + (p.tests.length - failing) + ' of ' + p.tests.length + ' checks already');
    if (!Array.isArray(p.samples) || !p.samples.length) err(label + ' needs samples:[{stdin,out}] (what the finished program prints)');
    else if (lang === 'cpp') {
      for (const s of p.samples) { const r = await runCppCode(p.solution, s.stdin || ''); if (!r.compiled) { err(label + ' solution does not compile: ' + r.msg); break; } if (norm(r.out) !== norm(s.out)) err(label + ' sample for stdin ' + JSON.stringify(s.stdin) + ' expected ' + JSON.stringify(s.out) + ' but the solution prints ' + JSON.stringify(norm(r.out))); }
      const st = await runCppCode(p.starter, ''); if (!st.compiled) warn(label + ' the starter does not compile (fine if it has TODO gaps): ' + st.msg);
    } else { const s = await csSyntax(p.solution); if (!s.ok) err(label + ' solution C# syntax: ' + s.msg); const s2 = await csSyntax(p.starter); if (!s2.ok) warn(label + ' starter C# syntax: ' + s2.msg); }
  }
}

function checkLessons(u, lang) {
  if (!Array.isArray(u.lessons) || u.lessons.length < 2 || u.lessons.length > 4) return err('unit needs 2-4 lessons');
  u.lessons.forEach((l, li) => {
    textOk(l.t, 'lesson ' + (li + 1) + ' title');
    if (!Array.isArray(l.pages) || l.pages.length < 3 || l.pages.length > 6) return err('lesson ' + (li + 1) + ' needs 3-6 pages');
    l.pages.forEach((pg, pi) => {
      const lb = 'lesson ' + (li + 1) + ' page ' + (pi + 1);
      textOk(pg.h, lb + ' heading'); textOk(pg.p, lb + ' text');
      if (pg.p && pg.p.length > 900) warn(lb + ' text is long (' + pg.p.length + ')');
      if (pg.c != null && bad(pg.c)) err(lb + ' code must be text');
      if (pg.o != null && typeof pg.o !== 'string') err(lb + ' output must be text');
      if (pg.o != null && pg.c == null) err(lb + ' has output but no code');
      if (pg.c && pg.c.split('\n').length > 18) warn(lb + ' code is longer than 18 lines');
    });
  });
}
async function runLessonCode(u, lang) {
  for (let li = 0; li < u.lessons.length; li++) for (let pi = 0; pi < u.lessons[li].pages.length; pi++) {
    const pg = u.lessons[li].pages[pi], lb = 'lesson ' + (li + 1) + ' page ' + (pi + 1);
    if (!pg.c) continue;
    if (pg.noexec) { noexec++; continue; }
    if (lang === 'js') { const r = await runJS(pg.c); if (r.err && pg.o == null) warn(lb + ' code throws: ' + r.err); else if (pg.o != null && !(r.err && /error/i.test(pg.o))) { if (norm(r.out + (r.err ? '\n' + r.err : '')) !== norm(pg.o)) err(lb + ' shows output "' + norm(pg.o).slice(0, 60) + '" but the code gives "' + norm(r.out + (r.err ? '\n' + r.err : '')).slice(0, 60) + '"'); } }
    else if (lang === 'cpp') { const r = await runCppCode(pg.c, ''); if (!r.compiled) { if (pg.o != null) err(lb + ' code does not compile: ' + r.msg); else warn(lb + ' snippet does not compile alone: ' + r.msg); } else if (pg.o != null && norm(r.out) !== norm(pg.o)) err(lb + ' shows output "' + norm(pg.o).slice(0, 60) + '" but the program prints "' + norm(r.out).slice(0, 60) + '"'); }
    else if (lang === 'cs') { const r = await csSyntax(pg.c); if (!r.ok) err(lb + ' C# syntax: ' + r.msg); }
    else if (lang === 'html') { if (/<\w/.test(pg.c)) { const m = await htmlValidate(pg.c); if (m.length && !pg.invalid) warn(lb + ' html: ' + m.slice(0, 2).join('; ') + ' (set "invalid": true on pages that show broken HTML on purpose)'); } }
  }
}

async function checkUnit(u, lang, file) {
  where = file;
  ['t', 'e'].forEach((k) => textOk(u[k], 'unit ' + k));
  checkLessons(u, lang);
  if (!Array.isArray(u.hand) || u.hand.length !== 14) err('hand needs exactly 14 questions (has ' + (u.hand && u.hand.length) + ')');
  if (!Array.isArray(u.hard) || u.hard.length !== 10) err('hard needs exactly 10 questions (has ' + (u.hard && u.hard.length) + ')');
  if (!Array.isArray(u.bugs) || u.bugs.length !== 2 || u.bugs.some((b) => !b || !Array.isArray(b.items) || b.items.length !== 3)) err('bugs needs 2 hunts with exactly 3 items each');
  if (!u.project) err('project is missing');
  (u.hand || []).forEach((q, i) => checkQ(q, lang, 'hand ' + (i + 1)));
  (u.hard || []).forEach((q, i) => checkQ(q, lang, 'hard ' + (i + 1)));
  /* variety: a unit should not be all one question type */
  const types = (a) => (a || []).reduce((m, q) => { m[q.type] = (m[q.type] || 0) + 1; return m; }, {});
  const th = types(u.hand); if (!th.fill || !th.order) warn('hand should include at least one fill and one order question');
  const dupQ = new Set(); (u.hand || []).concat(u.hard || []).forEach((q) => { const k = ncs((q.q || '') + (q.code || '') + (q.lines || []).join('')); if (dupQ.has(k)) err('duplicate question: ' + (q.q || q.code || '').slice(0, 40)); dupQ.add(k); });
  /* answer position / length bias: the right answer should not always be the longest */
  const mc = (u.hand || []).concat(u.hard || []).filter((q) => q.type === 'mc' || q.type === 'out');
  const longest = mc.filter((q) => { const a = String(q.type === 'out' ? q.answer : q.ans).length; return q.wrong.every((w) => String(w).length < a); }).length;
  if (mc.length > 8 && longest / mc.length > 0.5) warn('the correct answer is the longest option in ' + longest + ' of ' + mc.length + ' questions: make wrong answers as detailed as the right one');
  await runLessonCode(u, lang);
  const jobs = [];
  (u.hand || []).forEach((q, i) => jobs.push(runQ(q, lang, 'hand ' + (i + 1)).catch((e) => err('hand ' + (i + 1) + ' crashed the checker: ' + e.message))));
  (u.hard || []).forEach((q, i) => jobs.push(runQ(q, lang, 'hard ' + (i + 1)).catch((e) => err('hard ' + (i + 1) + ' crashed the checker: ' + e.message))));
  await Promise.all(jobs);
  for (let b = 0; b < (u.bugs || []).length; b++) for (let i = 0; i < ((u.bugs[b] || {}).items || []).length; i++) await checkBugItem(u.bugs[b].items[i], lang, 'bug hunt ' + (b + 1) + ' item ' + (i + 1));
  if (u.project) await checkProject(u.project, lang, 'project');
}

/* ---------- Python course in index.html ---------- */
async function checkPython() {
  const lines = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim() === '<script>') + 1, end = lines.findIndex((l) => l.startsWith('function build(c)'));
  const ctx = { console, Math, shuffle: (a) => a.slice() }; vm.createContext(ctx);
  vm.runInContext(lines.slice(start, end).join('\n') + ';this.PYUNITS=PYUNITS;this.COURSES=COURSES;', ctx);
  const pyx = lines.find((l) => l.startsWith('var PYX='));
  const PYX = JSON.parse(pyx.slice(pyx.indexOf('=') + 1).replace(/;\s*$/, ''));
  const py = async (code, stdin) => cached('py1:' + code + '\u0000' + stdin, async () => {
    const r = await limit(() => sh('python3', ['-I', '-c', 'import sys,io\nsrc=sys.stdin.read()\nsys.stdin=io.StringIO(' + JSON.stringify(stdin || '') + ')\nexec(compile(src,"main.py","exec"),{"__name__":"__main__"})'], { stdin: code, ms: 10000 }));
    return { out: r.out, err: r.code ? r.err.trim().split('\n').slice(-1)[0] : null };
  });
  const units = ctx.PYUNITS;
  where = 'python';
  if (units.length !== PYX.length) err('PYUNITS has ' + units.length + ' units but PYX has ' + PYX.length);
  /* answers for multi-line output are often written as a description ("0, 1, 2 (one per line)"): accept when every printed line appears, in order */
  const sameOut = (out, ans) => { if (norm(out) === norm(ans)) return true; const ls = norm(out).split('\n'); if (ls.length < 2) return false; let at = 0; for (const l of ls) { const i = String(ans).indexOf(l.trim(), at); if (i < 0) return false; at = i + l.trim().length; } return /line|then|,|and/i.test(ans); };
  const STDIN = '4\n4\n4\n4\n4\n4\n';
  const outQ = (q, label) => { /* "What does this print?" */ return py(q.c || q.code, '').then((r) => { const ans = q.type === 'out' ? q.answer : q.o[q.a]; if (r.err) { if (!/Error/.test(String(ans))) err(label + ' code raises ' + r.err + ' but the answer is "' + ans + '"'); } else if (!sameOut(r.out, ans)) err(label + ' answer "' + ans + '" but python prints "' + norm(r.out) + '"'); }); };
  for (let ui = 0; ui < units.length; ui++) {
    const u = units[ui]; where = 'python unit ' + (ui + 1) + ' (' + u.t + ')';
    const jobs = [];
    u.lessons.forEach((l, li) => l.pages.forEach((pg, pi) => { if (pg.c && pg.o != null) jobs.push(py(pg.c, '').then((r) => { const got = norm(r.out + (r.err ? '\n' + r.err : '')); if (got !== norm(pg.o) && !(r.err && /Error/.test(pg.o))) { if (!/input\(/.test(pg.c)) err('lesson ' + (li + 1) + ' page ' + (pi + 1) + ' shows "' + norm(pg.o).slice(0, 50) + '" but python gives "' + got.slice(0, 50) + '"'); } })); }));
    u.hand.forEach((q, i) => {
      const lb = 'hand ' + (i + 1);
      if (q.k === 'mc') { if (!Array.isArray(q.o) || new Set(q.o.map((v) => String(v).trim())).size !== q.o.length) err(lb + ' has duplicate options'); if (q.a !== 0) err(lb + ' answer index'); if (q.c && /print|=/.test(q.c) && /What does this (print|output)/i.test(q.q)) jobs.push(outQ(q, lb)); }
      if (q.k === 'fill' && q.c && /___/.test(q.c)) q.a.forEach((a) => jobs.push(py(q.c.replace('___', a), 'x\n5\n').then((r) => { if (r.err && !/EOF|input|ValueError|NameError/.test(r.err)) err(lb + ' fill answer "' + a + '" makes the code fail: ' + r.err); })));
      if (q.k === 'ord') jobs.push(py(q.l.join('\n'), 'x\n5\n').then((r) => { if (r.err && !/EOF|input|NameError|ValueError/.test(r.err)) err(lb + ' order: correct order fails: ' + r.err); }));
    });
    const x = PYX[ui];
    x.hard.forEach((q, i) => { const lb = 'hard ' + (i + 1); if (q.type === 'out' || q.type === 'mc') { const all = [q.type === 'out' ? q.answer : q.ans].concat(q.wrong).map((v) => String(v).trim()); if (new Set(all).size !== all.length) err(lb + ' has duplicate options'); } if (q.type === 'ord' && (!q.lines || q.lines.length < 3)) err(lb + ' order needs lines'); if (q.type === 'out') jobs.push(outQ(q, lb)); if (q.type === 'fill') q.ans.forEach((a) => jobs.push(py(q.code.replace('___', a), 'x\n5\n').then((r) => { if (r.err && !/EOF|input|ValueError/.test(r.err)) err(lb + ' fill "' + a + '" fails: ' + r.err); }))); if (q.type === 'ord') jobs.push(py(q.lines.join('\n'), 'x\n5\n').then((r) => { if (r.err && !/EOF|input|ValueError/.test(r.err)) err(lb + ' order fails: ' + r.err); })); });
    x.bugs.forEach((b, bi) => b.items.forEach((it, ii) => { const lb = 'bug hunt ' + (bi + 1) + ' item ' + (ii + 1); const a = it.code.split('\n'), f = it.fixed.split('\n'); const d = a.map((l, i) => (l !== f[i] ? i : -1)).filter((i) => i >= 0); if (a.length !== f.length || d.length !== 1 || d[0] !== it.line) err(lb + ' differs on lines ' + JSON.stringify(d) + ' but line=' + it.line); jobs.push(py(it.fixed, STDIN).then((r) => { if (r.err) err(lb + ' fixed code fails: ' + r.err); })); }));
    const pj = x.project; if (pj.tests.length < 3) err('project has too few tests');
    await Promise.all(jobs);
  }
  /* generated questions: run the generator many times and check each answer */
  where = 'python generators';
  const gens = [];
  ctx.COURSES[0] && Object.keys(ctx.COURSES[0].gens).forEach((ui) => ctx.COURSES[0].gens[ui].forEach((g, gi) => gens.push([ui, gi, g])));
  for (const [ui, gi, g] of gens) {
    const seen = new Set();
    for (let k = 0; k < 40; k++) {
      let q; try { q = g(Math.random() * 0.9 + 0.05); } catch (e) { err('generator unit ' + (+ui + 1) + ' #' + (gi + 1) + ' throws: ' + e.message); break; }
      if (!q || q.k !== 'mc' || !q.c || seen.has(q.c)) continue; seen.add(q.c);
      if (new Set(q.o.map(String)).size !== q.o.length) err('generator unit ' + (+ui + 1) + ' #' + (gi + 1) + ' made duplicate options for: ' + q.c.slice(0, 60));
      if (/What does this print/.test(q.q)) { const r = await py(q.c, ''); const ans = q.o[q.a]; if (r.err) { if (!/Error/.test(String(ans))) err('generator unit ' + (+ui + 1) + ' #' + (gi + 1) + ' code raises ' + r.err); } else if (!sameOut(r.out, ans)) err('generator unit ' + (+ui + 1) + ' #' + (gi + 1) + ' answer "' + ans + '" but python prints "' + norm(r.out) + '"\n' + q.c); }
    }
  }
}

/* ---------- main ---------- */
async function checkCourseDir(dir) {
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'course.json'), 'utf8'));
  where = dir; ['id', 't', 'e', 'd', 'lang'].forEach((k) => textOk(man[k], 'course.json ' + k));
  if (!['js', 'cpp', 'cs', 'html'].includes(man.lang)) err('course.json lang must be js, cpp, cs or html');
  if (!Array.isArray(man.units) || !man.units.length) err('course.json units must list the unit files');
  for (const f of man.units || []) {
    const fp = path.join(dir, f + '.json');
    if (!fs.existsSync(fp)) { where = fp; err('missing file'); continue; }
    let u; try { u = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { where = fp; err('invalid JSON: ' + e.message); continue; }
    await checkUnit(u, man.lang, path.relative(ROOT, fp));
  }
}
async function main() {
  const args = process.argv.slice(2);
  if (!args.length) { console.log('usage: check-content.js <content/course | unit.json | --python | --all>'); process.exit(2); }
  for (const a of args) {
    if (a === '--python') await checkPython();
    else if (a === '--all') { await checkPython(); for (const d of fs.readdirSync(path.join(ROOT, 'content'))) if (fs.existsSync(path.join(ROOT, 'content', d, 'course.json'))) await checkCourseDir(path.join(ROOT, 'content', d)); }
    else if (fs.statSync(a).isDirectory()) await checkCourseDir(a);
    else {
      const m = /content\/(\w+)\//.exec(path.resolve(a).replace(/\\/g, '/') + '/'); const id = m && m[1];
      const man = JSON.parse(fs.readFileSync(path.join(path.dirname(path.resolve(a)), 'course.json'), 'utf8'));
      await checkUnit(JSON.parse(fs.readFileSync(a, 'utf8')), man.lang, path.relative(ROOT, path.resolve(a)));
    }
  }
  warns.forEach((w) => console.log('WARN  ' + w));
  errors.forEach((e) => console.log('ERROR ' + e));
  console.log('\n' + errors.length + ' error(s), ' + warns.length + ' warning(s), ' + noexec + ' check(s) skipped with "noexec"');
  process.exit(errors.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
