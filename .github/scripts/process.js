'use strict';
/* Yamato Desktop leaderboard: checks the results that the game sends as issues titled "LB" and keeps leaderboard.json up to date.
   node process.js apply  - reads the open "LB" issues, checks them, updates leaderboard.json (and remembers which issues to close)
   node process.js close  - closes the issues that were handled
   The game sends: {"id":"<secret id>","n":"<nickname>","a":1 if the nickname is automatic,"p":prestiges,"t":turns of all time,"c":coins now,"v":"3.39"}.
   The table only keeps a hash of the id, so reading leaderboard.json does not reveal who is who. */
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');

const LIM = {
  tps: 5000,          // most turns per second that anybody can really make (turns of all time may grow by this per second between two results)
  slack: 20000,       // plus this many turns of tolerance per result
  gapSec: 30,         // a player's results closer than this are ignored (the newer one comes later anyway)
  presNeed: 100000,   // the cheapest prestige costs this many turns (so turns of all time can never be below prestiges x this)
  maxP: 1000, maxT: 1e18, maxC: 1e15,
  maxPlayers: 5000    // when the table is full the player who has been silent the longest is dropped
};
const NICK_RX = /^[A-Za-z0-9_-]{3,16}$/, AUTO_RX = /^player\d+$/i, ID_RX = /^\d{1,16}-\d{1,16}$/;
const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);

function parse(issue) {
  if (!issue || issue.title !== 'LB' || issue.pull_request) return null;
  const b = String(issue.body || '');
  if (b.length > 1000) return {err: 'too long'};
  let d; try { d = JSON.parse(b); } catch (_) { return {err: 'not JSON'}; }
  if (!d || typeof d !== 'object') return {err: 'not an object'};
  if (typeof d.id !== 'string' || !ID_RX.test(d.id)) return {err: 'bad id'};
  if (typeof d.n !== 'string') return {err: 'bad nickname'};
  const p = d.p, t = d.t, c = d.c;
  if (!Number.isInteger(p) || p < 0 || p > LIM.maxP) return {err: 'bad prestige'};
  if (!Number.isFinite(t) || t < 0 || t > LIM.maxT) return {err: 'bad turns'};
  if (!Number.isFinite(c) || c < 0 || c > LIM.maxC) return {err: 'bad coins'};
  return {d: {id: d.id, n: d.n, a: d.a === 1 || d.a === true ? 1 : 0, p, t: Math.floor(t), c: Math.floor(c)}};
}

/* applies one result to db ({players:[...]}); returns {ok, reason, note}. rnd() -> number in [0,1) */
function apply(db, banned, issue, rnd) {
  rnd = rnd || Math.random;
  const pr = parse(issue);
  if (!pr) return {ok: false, reason: 'not a result'};
  if (pr.err) return {ok: false, reason: pr.err};
  const d = pr.d, h = sha(d.id), created = Date.parse(issue.created_at) || Date.now();
  if ((banned.hashes || []).includes(h)) return {ok: false, reason: 'banned'};
  const words = (banned.words || []).map(w => String(w).toLowerCase()).filter(Boolean);
  const dirty = n => words.some(w => n.toLowerCase().includes(w));
  if (d.t < d.p * LIM.presNeed) return {ok: false, reason: 'turns are fewer than the prestiges need'};
  const ex = db.players.find(r => r.h === h) || null;
  if (ex) {
    const dt = (created - Date.parse(ex.u)) / 1000;
    if (dt < LIM.gapSec) return {ok: false, reason: 'too soon'};
    if (d.p < ex.p) return {ok: false, reason: 'prestige went down'};
    if (d.t > ex.t + dt * LIM.tps + LIM.slack) return {ok: false, reason: 'turns grew too fast'};
    if (d.p - ex.p > Math.floor(Math.max(0, d.t - ex.t) / LIM.presNeed) + 1) return {ok: false, reason: 'too many prestiges at once'};
  }
  const taken = n => db.players.some(r => r.h !== h && r.n.toLowerCase() === n.toLowerCase());
  const okCustom = n => NICK_RX.test(n) && !AUTO_RX.test(n) && !dirty(n);
  let nick, note = '';
  if (ex) {
    nick = ex.n;
    if (!d.a && d.n.toLowerCase() !== ex.n.toLowerCase()) {
      if (okCustom(d.n) && !taken(d.n)) nick = d.n; else note = 'nickname refused';
    }
  } else if (!d.a && okCustom(d.n) && !taken(d.n)) nick = d.n;
  else if (d.a && AUTO_RX.test(d.n) && NICK_RX.test(d.n) && !taken(d.n)) nick = d.n;
  else {
    note = d.a ? 'automatic nickname was taken' : 'nickname refused';
    for (let i = 0; i < 200 && !nick; i++) { const n = 'player' + (10000 + Math.floor(rnd() * 90000)); if (!taken(n)) nick = n; }
    if (!nick) return {ok: false, reason: 'no free nickname'};
  }
  const row = {h, n: nick, p: d.p, t: ex ? Math.max(d.t, ex.t) : d.t, c: d.c, u: new Date(created).toISOString()};
  if (ex) Object.assign(ex, row);
  else {
    if (db.players.length >= LIM.maxPlayers) { let k = 0; db.players.forEach((r, i) => { if (r.u < db.players[k].u) k = i; }); db.players.splice(k, 1); }
    db.players.push(row);
  }
  return {ok: true, note};
}

function serialize(db) {
  return '{"v":1,"updated":' + JSON.stringify(db.updated || '') + ',"players":[\n' + db.players.map(r => JSON.stringify(r)).join(',\n') + '\n]}\n';
}

/* ---------- the GitHub side ---------- */
const CLOSING = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'lb-closing.json');
async function gh(method, url, body) {
  const r = await fetch('https://api.github.com' + url, {method, headers: {Authorization: 'Bearer ' + process.env.GITHUB_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', 'User-Agent': 'yamato-leaderboard'}, body: body ? JSON.stringify(body) : undefined});
  if (!r.ok) throw new Error(method + ' ' + url + ' -> ' + r.status);
  return r.status === 204 ? null : r.json();
}
async function main(mode) {
  const repo = process.env.REPO || process.env.GITHUB_REPOSITORY;
  if (mode === 'close') {
    if (!fs.existsSync(CLOSING)) return;
    for (const x of JSON.parse(fs.readFileSync(CLOSING, 'utf8'))) {
      try { await gh('PATCH', '/repos/' + repo + '/issues/' + x.n, {state: 'closed', state_reason: x.ok ? 'completed' : 'not_planned'}); } catch (e) { console.log('could not close #' + x.n + ': ' + e.message); }
    }
    fs.rmSync(CLOSING, {force: true});
    return;
  }
  const db = JSON.parse(fs.readFileSync('leaderboard.json', 'utf8')); if (!Array.isArray(db.players)) db.players = [];
  let banned = {hashes: [], words: []}; try { banned = JSON.parse(fs.readFileSync('banned.json', 'utf8')); } catch (_) {}
  let issues = [];
  for (let page = 1; page <= 5; page++) {
    const list = await gh('GET', '/repos/' + repo + '/issues?state=open&sort=created&direction=asc&per_page=100&page=' + page);
    issues = issues.concat(list.filter(i => i.title === 'LB' && !i.pull_request));
    if (list.length < 100) break;
  }
  console.log('open results: ' + issues.length);
  const done = []; let changed = false;
  for (const i of issues) {
    const r = apply(db, banned, i);
    console.log('#' + i.number + ' ' + (r.ok ? 'ok' + (r.note ? ' (' + r.note + ')' : '') : 'rejected: ' + r.reason));
    if (r.ok) changed = true;
    done.push({n: i.number, ok: r.ok});
  }
  if (changed) { db.updated = new Date().toISOString(); fs.writeFileSync('leaderboard.json', serialize(db)); }
  fs.writeFileSync(CLOSING, JSON.stringify(done));
}
if (require.main === module) main(process.argv[2] || 'apply').catch(e => { console.error(e); process.exit(1); });
module.exports = {apply, parse, serialize, sha, LIM};
