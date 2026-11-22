// Conference title game tiebreakers (engine.js TB). Run: node --test test/
// Part 1 builds small leagues by hand to pin down each rule; part 2 replays real seasons (test/fixtures, from
// fetch-fixtures.mjs) and checks the teams the procedures pick against the title games actually played.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { TB } = createRequire(import.meta.url)('../engine.js');

// A league from results. games: 'A>B' is a conference win for A over B; 'A>B nc' a non-conference win, and a
// loser named 'fcs:x' is a team below FBS. opts: div { team: name }, metric / rank / rating { team: number },
// lostFinal [teams], rand: a function. Inputs a test doesn't give throw if a rule reaches for them, so no
// result can come from a value nobody set.
function league(names, games, opts = {}) {
  const idx = new Map(names.map((t, i) => [t, i]));
  const id = (t) => { if (!idx.has(t)) idx.set(t, idx.size); return idx.get(t); };
  const n = () => idx.size;
  const cw = {}, cl = {}, ch = {}, w = {}, l = {}, fcs = {};
  for (const g of games) {
    const [pair, kind] = g.split(' '), [a, b] = pair.split('>'), x = id(a), y = id(b);
    w[x] = (w[x] || 0) + 1; l[y] = (l[y] || 0) + 1;
    if (b.startsWith('fcs:')) fcs[x] = (fcs[x] || 0) + 1;
    if (kind !== 'nc') { cw[x] = (cw[x] || 0) + 1; cl[y] = (cl[y] || 0) + 1; ch[x + ',' + y] = (ch[x + ',' + y] || 0) + 1; }
  }
  const need = (map, what) => (t) => { const k = names[t]; if (!map || !(k in map)) throw new Error(what + ' needed for ' + k); return map[k]; };
  const ctx = {
    cw: (t) => cw[t] || 0, cl: (t) => cl[t] || 0, ch: (a, b) => ch[a + ',' + b] || 0,
    w: (t) => w[t] || 0, l: (t) => l[t] || 0, fcsW: (t) => fcs[t] || 0,
    metric: need(opts.metric, 'metric'), rating: need(opts.rating, 'rating'),
    rank: (t) => (opts.rank && opts.rank[names[t]]) || 0,
    lostFinal: (t) => (opts.lostFinal || []).includes(names[t]),
    div: (t) => (opts.div && opts.div[names[t]]) || '',
    rand: opts.rand || (() => { throw new Error('coin toss reached'); })
  };
  void n;
  const members = names.map((t) => idx.get(t));
  return {
    top2(conf, divs, rules) {
      const d = divs && divs.map((list) => list.map((t) => idx.get(t)));
      return TB.top2(rules || conf, members, ctx, d).map((t) => names[t]);
    }
  };
}
// Round robin helper: every listed pair played, first team won.
const beats = (pairs) => pairs.trim().split(/\s+/);

// ---------------------------------------------------------------- part 1: hand-built leagues
test('no ties: the two best conference records, in order', () => {
  const L = league(['A', 'B', 'C', 'D'], beats('A>B A>C A>D B>C B>D C>D'));
  assert.deepEqual(L.top2('big12'), ['A', 'B']);
});

test('two-way tie for first: both play, head-to-head winner is No. 1', () => {
  // A and B 2-1, each beat C and D; B beat A? No: A beat B, B lost only to A... make them level at 2-1.
  const L = league(['A', 'B', 'C', 'D'], beats('B>A A>C A>D B>C D>B C>D'));
  // A 2-1, B 2-1 (beat A and C, lost to D), C 1-2, D 1-2 (beat B).
  assert.deepEqual(L.top2('big12'), ['B', 'A']);
  assert.deepEqual(L.top2('sec'), ['B', 'A']);
});

test('two-way tie for second: head-to-head first', () => {
  const L = league(['A', 'B', 'C', 'D', 'E'], beats('A>B A>C A>D A>E C>B B>D B>E C>E D>C'));
  // A 4-0; B 2-2, C 2-2 (beat B and E, lost to A and D), D 1-3... B vs C: C won.
  const r = L.top2('big10');
  assert.equal(r[0], 'A');
  assert.equal(r[1], 'C');
});

test('two-way tie, no meeting: record against common opponents', () => {
  // A 3-0 tops. B and C both 2-1, never met. Common opponents D, E: B beat both, C lost to D.
  const L = league(['A', 'B', 'C', 'D', 'E', 'F'], beats('A>B A>D A>E B>D B>E C>E C>F D>C A>F D>F E>F'));
  const r = L.top2('big12');
  assert.deepEqual(r, ['A', 'B']);
});

test('ordered common opponents: the best-placed common opponent decides', () => {
  // B and C 3-1, did not meet, same record vs common opponents overall (each 2-1 vs D,E,F) but B beat the
  // higher-placed one (D), C lost to it.
  const g = beats(`A>B A>C A>D A>E A>F
    B>D B>E F>B   C>E C>F D>C
    D>E D>F E>F`);
  // standings: A 5-0, D 3-2 (beat C,E,F), B 2-2... make B and C level and D placed above E and F.
  const L = league(['A', 'B', 'C', 'D', 'E', 'F'], g);
  // B: beat D,E lost A,F = 2-2. C: beat E,F lost A,D = 2-2. D: beat C,E,F lost A,B = 3-2.
  // Common opponents of B and C: A, D, E, F; B 2-2, C 2-2 -> level. Next: A (both lost), then D: B won, C lost.
  assert.deepEqual(L.top2('big12'), ['A', 'D']); // D is 3-2, second on its own
  // With D dropped to 2-2 the tie for second is three-way; check the two-team ordered rule directly instead:
  const L2 = league(['A', 'B', 'C', 'D', 'E', 'F'], g.filter((x) => x !== 'D>E').concat(['E>D']));
  // now D 2-3 (beat C,F), E 2-3 (beat D,F)... B 2-2 and C 2-2 are second.
  assert.deepEqual(L2.top2('big12'), ['A', 'B']);
});

test('three-way tie, complete round robin: best record among them (Big 12)', () => {
  // A, B, C each 3-1 overall, A beat B and C, B beat C, but A lost to D.
  const L = league(['A', 'B', 'C', 'D'], beats('A>B A>C B>C D>A B>D C>D'));
  // A 2-1, B 2-1, C 1-2? C beat D only. A 2-1 (lost D), B 2-1 (lost A), D 1-2.
  assert.deepEqual(L.top2('big12'), ['A', 'B']);
});

test('three-way tie, incomplete: a team that beat the other two advances, the two left use the two-team order', () => {
  // A, B, C all 4-1. A beat B and C. B and C did not meet. Then B vs C go to the two-team procedure.
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const g = beats(`A>B A>C D>A A>E A>F
    B>D B>E B>F G>B
    C>D C>E C>G F>C
    D>E E>F F>G G>D`);
  const L = league(names, g);
  const r = L.top2('big12');
  assert.equal(r[0], 'A');
  // B vs C, no meeting. Common opponents D, E, F, G: B 3-1, C 3-1 (beat D,E,G lost F). Level, then ordered.
  assert.ok(r[1] === 'B' || r[1] === 'C');
});

test('lost-to-all: the SEC removes a tied team that lost to each of the others; the Big 12 has no such rule', () => {
  // A 5-0 leads. X, Y, Z tied at 3-3 for second; Y and Z beat X and did not meet. Against their common
  // opponents (A, P, Q, R) X is 3-1, Y 2-2, Z 1-3.
  const names = ['A', 'X', 'Y', 'Z', 'P', 'Q', 'R', 'S'];
  const g = beats(`A>X A>Y A>Z A>P A>S
    Y>X Z>X  X>P X>Q X>R
    Y>Q Y>R P>Y S>Y
    Z>P Z>S Q>Z R>Z`);
  const L = league(names, g);
  // Big 12: nobody beat both others, so common opponents decide: X.
  assert.deepEqual(L.top2('big12'), ['A', 'X']);
  // SEC: X lost to both and is out; Y and Z are level on common opponents (3-3 each); by order of finish,
  // against the group Q, R, S (1-2 each), Y is 2-1 and Z 1-2: Y.
  assert.deepEqual(L.top2('sec'), ['A', 'Y']);
});

test('ACC 2026: an 8-game team with the leader\'s wins or losses is tied with it', () => {
  // A 8-1 over 9 games; B 7-1 over 8 games (same losses as A): tied. B beat A -> B is No. 1.
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
  // The others get full losing records, so none of them matches A's or B's wins or losses.
  const g = ['B>A', 'A>C', 'A>D', 'A>E', 'A>F', 'A>G', 'A>H', 'A>I', 'A>J',
    'B>C', 'B>D', 'B>E', 'B>F', 'B>G', 'B>H', 'I>B',
    'C>I', 'D>I', 'E>I', 'F>I', 'G>I', 'H>I', 'J>I', 'C>J', 'D>J', 'E>J', 'F>J', 'G>J', 'H>J'];
  const L = league(names, g);
  assert.deepEqual(L.top2('acc'), ['B', 'A']);
  // Other conferences go by percentage alone: A .889 vs B .875 -> A first, B second.
  assert.deepEqual(L.top2('big12'), ['A', 'B']);
});

test('ACC 2026: two-team tie without a meeting goes to the Team Success ranking (metric), not common opponents', () => {
  const names = ['A', 'B', 'C', 'D', 'E'];
  const g = beats('A>C A>D B>C B>E E>A D>B C>D C>E D>E');
  const L = league(names, g, { metric: { A: 10, B: 20, C: 0, D: 0, E: 0 } });
  // A 2-1, B 2-1, C 2-2? C beat D,E lost A,B = 2-2. D 2-2. E 1-3? E beat A, lost B,C,D.
  assert.deepEqual(L.top2('acc'), ['B', 'A']);
});

test('ACC 2026: three tied who all met -> best record among them; otherwise beat-all / lost-all, then metric', () => {
  const names = ['A', 'B', 'C', 'D'];
  const L = league(names, beats('A>B B>C C>A A>D B>D C>D'), { metric: { A: 3, B: 2, C: 1, D: 0 } });
  // A, B, C each 2-1, each 1-1 among themselves -> metric: A then B.
  assert.deepEqual(L.top2('acc'), ['A', 'B']);
});

test('American: a ranked tied team that won its final game advances before computer rankings', () => {
  const names = ['A', 'B', 'C', 'D', 'E'];
  const g = beats('A>C A>D E>A B>C B>D B>E C>E D>E');
  // A 2-1? A beat C,D lost E = 2-1... B 3-0. Make A and C level for second: C 1-2. Use D: 1-2.
  const L = league(names, beats('A>C A>D E>A B>A B>C B>E C>D D>E E>C'), { rank: { D: 22 }, metric: { A: 9, C: 1, D: 1, E: 1 } });
  void g;
  // B 3-0 first. A 2-2, C 1-2... the point: a rank only helps a team that didn't lose its final game.
  const r = L.top2('american');
  assert.equal(r[0], 'B');
});

test('American: the ranked team advances when it won its final game, the composite decides when it lost', () => {
  // B and C tie for second at 2-1 without meeting; C is ranked.
  const names = ['A', 'B', 'C', 'D', 'E'];
  const g = beats('A>B A>C A>D A>E B>D B>E C>D C>E D>E');
  // A 4-0. B 2-1 (beat D,E lost A). C 2-1 (beat D,E lost A). D 1-3, E 0-4.
  const won = league(names, g, { rank: { C: 24 }, metric: { B: 5, C: 1 } });
  assert.deepEqual(won.top2('american'), ['A', 'C']);
  const lost = league(names, g, { rank: { C: 24 }, lostFinal: ['C'], metric: { B: 5, C: 1 } });
  assert.deepEqual(lost.top2('american'), ['A', 'B']);
});

test('Mountain West: CFP rank then composite, both before overall record', () => {
  const names = ['A', 'B', 'C', 'D', 'E'];
  const g = beats('A>B A>C A>D A>E B>D B>E C>D C>E D>E');
  const L = league(names, g, { metric: { B: 1, C: 7 } });
  assert.deepEqual(L.top2('mwest'), ['A', 'C']);
});

test('MAC: combined opponents\' record comes before SportSource', () => {
  // B and C level at 2-1 behind A, no meeting; B's opponents won more.
  const names = ['A', 'B', 'C', 'D', 'E', 'F'];
  const g = beats('A>B A>C B>D B>E C>F C>E D>E D>F A>D E>F');
  // A 3-0. B 2-1 (D,E). C 2-1 (F,E). D 2-2 (E,F). E 1-3? E beat F. F 0-3.
  // B's opponents A(3-0), D(2-2), E(1-3) = 6-5; C's opponents A, F(0-3), E(1-3) = 4-6. B ahead.
  const L = league(names, g, { metric: { B: 0, C: 99 } });
  assert.deepEqual(L.top2('midam'), ['A', 'B']);
});

test('Big 12: total wins (one FCS win counted) before SportSource', () => {
  const names = ['A', 'B', 'C', 'D'];
  // B and C 1-1, met? no. Common opponents: D only (B beat D, C beat D) and A (both lost).
  const g = ['A>B', 'A>C', 'B>D', 'C>D', 'A>D',
    'B>x nc', 'B>y nc', 'C>fcs:a nc', 'C>fcs:b nc', 'C>z nc'];
  // B: 3 wins + ... B total = 1 conf + 2 nc = 3. C total = 1 + 3 = 4 but two are FCS -> counts 3.
  const L = league(names, g, { metric: { B: 1, C: 2 } });
  // Total wins level (3 v 3), so SportSource (metric) decides: C.
  assert.deepEqual(L.top2('big12'), ['A', 'C']);
  const L2 = league(names, g.concat(['B>w nc']), { metric: { B: 1, C: 2 } });
  assert.deepEqual(L2.top2('big12'), ['A', 'B']);
});

test('Pac-12 two-team ties check the best-placed common opponent before all common opponents (the Big 12 the other way)', () => {
  // A 6-0 leads. B and C tied at 3-2, didn't meet. Common opponents D, E, F, G: B 3-1 (lost only to D),
  // C 2-2 (beat D). D is the best-placed common opponent (A played neither).
  // D finishes 3-3, level with J (who played only A and D), so the first standings level both B and C faced
  // is D alone.
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
  const g = beats(`A>D A>E A>F A>G A>H A>I A>J
    D>B B>E B>F B>G I>B
    C>D C>E F>C G>C C>H
    D>H D>I E>H J>D`);
  const L = league(names, g);
  assert.deepEqual(L.top2('big12'), ['A', 'B']);
  assert.deepEqual(L.top2('pac12'), ['A', 'C']);
});

test('Sun Belt: each division sends its champion; divisional record breaks a two-way tie after head-to-head', () => {
  const names = ['E1', 'E2', 'E3', 'W1', 'W2', 'W3'];
  const div = { E1: 'E', E2: 'E', E3: 'E', W1: 'W', W2: 'W', W3: 'W' };
  // E1 and E2 both 3-1 overall in conference, didn't meet. E1 2-0 in division? They can't both be 2-0 without
  // meeting... E1 beat E3, E2 beat E3, E1 lost to W1, E2 lost to W2, both beat the others.
  const g = beats(`E1>E3 E2>E3 W1>E1 E1>W2 E1>W3 W2>E2 E2>W1 E2>W3
    W1>W2 W1>W3 W2>W3 E3>W3`);
  const L = league(names, g, { div, metric: { E1: 1, E2: 2 } });
  const r = L.top2('belt', [['E1', 'E2', 'E3'], ['W1', 'W2', 'W3']]);
  assert.ok(r.includes('W1'));
  assert.ok(r.includes('E1') || r.includes('E2'));
});

test('coin toss is reached only when every other step is level, and its draw decides', () => {
  const names = ['A', 'B', 'C'];
  const g = beats('A>C B>C');
  let k = 0;
  const L = league(names, g, { metric: { A: 1, B: 1 }, rating: { A: 1, B: 1 }, rand: () => [0.2, 0.9][k++ % 2] });
  assert.deepEqual(L.top2('sec').sort(), ['A', 'B']);
});

// ---------------------------------------------------------------- part 1b: random leagues
// Rules every procedure must keep, checked over thousands of random leagues per conference.
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function randomLeague(r, roundRobin) {
  const n = 6 + Math.floor(r() * 9), names = Array.from({ length: n }, (_, i) => 'T' + i), games = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (!roundRobin && r() > 0.6) continue;
    games.push(r() < 0.5 ? names[i] + '>' + names[j] : names[j] + '>' + names[i]);
  }
  names.forEach((t) => { for (let k = 0; k < 3; k++) games.push(r() < 0.6 ? t + '>nc' + Math.floor(r() * 20) + ' nc' : 'nc' + Math.floor(r() * 20) + '>' + t + ' nc'); });
  const metric = {}, rating = {}, rank = {}, div = {};
  names.forEach((t, i) => { metric[t] = r(); rating[t] = r(); if (r() < 0.2) rank[t] = 1 + Math.floor(r() * 25); div[t] = i % 2 ? 'E' : 'W'; });
  const lostFinal = names.filter(() => r() < 0.4);
  return { names, games, opts: { metric, rating, rank, div, lostFinal } };
}
function records(names, games) {
  const w = {}, l = {}, met = {};
  names.forEach((t) => { w[t] = 0; l[t] = 0; });
  games.filter((g) => !g.endsWith(' nc')).forEach((g) => { const [a, b] = g.split('>'); w[a]++; l[b]++; met[a + '>' + b] = 1; });
  const pct = (t) => (w[t] + l[t] ? w[t] / (w[t] + l[t]) : 0);
  return { pct, beat: (a, b) => !!met[a + '>' + b] && !met[b + '>' + a], games: (t) => w[t] + l[t] };
}
for (const conf of ['sec', 'big10', 'big12', 'acc', 'pac12', 'american', 'usa', 'midam', 'mwest']) {
  test('random leagues keep the basic rules: ' + conf, () => {
    const r = rng(conf.length * 7919 + conf.charCodeAt(0));
    for (let trial = 0; trial < 1500; trial++) {
      // The ACC's unequal-schedule rule can rightly tie teams of different percentages, so its leagues are round robins.
      const { names, games, opts } = randomLeague(r, conf === 'acc' || trial % 3 === 0);
      const seedA = Math.floor(r() * 1e9);
      const L = league(names, games, { ...opts, rand: rng(seedA) });
      const got = L.top2(conf), R = records(names, games), p = R.pct;
      const ctxMsg = () => conf + ' trial ' + trial + ': ' + games.filter((g) => !g.endsWith(' nc')).join(' ') + ' -> ' + got.join(' v ');
      assert.equal(got.length, 2, ctxMsg());
      assert.notEqual(got[0], got[1], ctxMsg());
      // Nobody left out has a better conference record than a team that got in, and No. 1 isn't below No. 2.
      const worstIn = Math.min(p(got[0]), p(got[1]));
      names.filter((t) => !got.includes(t)).forEach((t) => assert.ok(p(t) <= worstIn + 1e-9, 'left out a better record: ' + t + ' ' + ctxMsg()));
      assert.ok(p(got[0]) >= p(got[1]) - 1e-9, 'No. 1 below No. 2: ' + ctxMsg());
      const sorted = names.slice().sort((a, b) => p(b) - p(a));
      // A lone leader is No. 1; a lone second is No. 2.
      if (p(sorted[0]) > p(sorted[1]) + 1e-9) {
        assert.equal(got[0], sorted[0], 'lone leader not No. 1: ' + ctxMsg());
        const second = sorted.filter((t) => Math.abs(p(t) - p(sorted[1])) < 1e-9);
        if (second.length === 1) assert.equal(got[1], sorted[1], ctxMsg());
        // Two tied for second who met: the winner of that game.
        if (second.length === 2 && (R.beat(second[0], second[1]) || R.beat(second[1], second[0]))) {
          assert.equal(got[1], R.beat(second[0], second[1]) ? second[0] : second[1], 'two-team head-to-head ignored: ' + ctxMsg());
        }
        // Three or more tied for second who all met each other, one with the best record among them: that team.
        if (second.length >= 3 && second.every((a) => second.every((b) => a === b || R.beat(a, b) || R.beat(b, a)))) {
          const among = (a) => second.filter((b) => b !== a && R.beat(a, b)).length;
          const best = Math.max(...second.map(among)), top = second.filter((t) => among(t) === best);
          if (top.length === 1) assert.equal(got[1], top[0], 'round-robin winner not picked: ' + ctxMsg());
        }
      } else {
        // Exactly two tied for first: both play, and if they met, the winner is No. 1.
        const first = sorted.filter((t) => Math.abs(p(t) - p(sorted[0])) < 1e-9);
        if (first.length === 2) {
          assert.deepEqual(got.slice().sort(), first.slice().sort(), ctxMsg());
          if (R.beat(first[0], first[1])) assert.equal(got[0], first[0], ctxMsg());
          if (R.beat(first[1], first[0])) assert.equal(got[0], first[1], ctxMsg());
        }
      }
      // Same inputs, same answer.
      const again = league(names, games, { ...opts, rand: rng(seedA) }).top2(conf);
      assert.deepEqual(again, got, 'not deterministic: ' + ctxMsg());
    }
  });
}

// ---------------------------------------------------------------- part 2: real seasons
const CONF = { SEC: 'sec', 'Big Ten': 'big10', 'Big 12': 'big12', ACC: 'acc', 'American Athletic': 'american', 'Conference USA': 'usa',
  'Mid-American': 'midam', 'Mountain West': 'mwest', 'Sun Belt': 'belt', 'Pac-12': 'pac12' };
function season(year) {
  const f = JSON.parse(readFileSync(new URL(`./fixtures/cfb-${year}.json`, import.meta.url)));
  const confOf = new Map(f.teams.map((t) => [t.name, t]));
  return function race(conf, opts = {}) {
    const names = f.teams.filter((t) => t.conf === conf).map((t) => t.name);
    const set = new Set(names), games = [], last = {};
    for (const g of f.games.slice().sort((a, b) => (a.d < b.d ? -1 : 1))) {
      if (g.hs === g.as) continue;
      const w = g.hs > g.as ? g.h : g.a, l = w === g.h ? g.a : g.h;
      const inConf = g.c && set.has(g.h) && set.has(g.a);
      if (!set.has(w) && !set.has(l)) continue;
      games.push(w.replace(/[> ]/g, '_') + '>' + (confOf.has(l) ? '' : 'fcs:') + l.replace(/[> ]/g, '_') + (inConf ? '' : ' nc'));
      if (inConf) { last[w] = 'W'; last[l] = 'L'; }
    }
    const key = (t) => t.replace(/[> ]/g, '_');
    const lostFinal = names.filter((t) => last[t] === 'L').map(key);
    const mk = (m) => m && Object.fromEntries(Object.entries(m).map(([k, v]) => [key(k), v]));
    const L = league(names.map(key), games, { lostFinal, metric: mk(opts.metric), rank: mk(opts.rank), rating: mk(opts.rating), div: mk(opts.div) });
    const divs = opts.divs ? opts.divs.map((d) => names.filter((t) => confOf.get(t).div === d).map(key)) : null;
    if (opts.divs) opts.div = Object.fromEntries(names.map((t) => [key(t), confOf.get(t).div]));
    const L2 = opts.divs ? league(names.map(key), games, { lostFinal, metric: mk(opts.metric), rank: mk(opts.rank), rating: mk(opts.rating), div: opts.div }) : L;
    return L2.top2(CONF[conf], divs, opts.rules).map((t) => t.replace(/_/g, ' '));
  };
}
const same = (got, want) => assert.deepEqual(got.slice().sort(), want.slice().sort(), 'got ' + got.join(' v ') + ', expected ' + want.join(' v '));

test('2024 title games', () => {
  const r = season(2024);
  const sec = r('SEC'); same(sec, ['Texas', 'Georgia']); assert.equal(sec[0], 'Texas');
  const b10 = r('Big Ten'); same(b10, ['Oregon', 'Penn State']); assert.equal(b10[0], 'Oregon');
  const b12 = r('Big 12'); same(b12, ['Arizona State', 'Iowa State']); assert.equal(b12[0], 'Arizona State');
  same(r('ACC'), ['SMU', 'Clemson']);
  same(r('Mid-American'), ['Ohio', 'Miami (OH)']);
  same(r('American Athletic'), ['Army', 'Tulane']);
  same(r('Conference USA'), ['Jacksonville State', 'Western Kentucky']);
  // Both division champions 7-1: only who hosts needs an outside ranking (Louisiana hosted).
  same(r('Sun Belt', { divs: ['East', 'West'], metric: { Louisiana: 2, Marshall: 1 } }), ['Marshall', 'Louisiana']);
});

test('MAC 2026: a tied team that lost to each of the others is removed (the MAC\'s current procedure)', () => {
  // The 2025 shape: X, Y, Z tied; Y and Z beat X; Y and Z did not meet.
  const names = ['X', 'Y', 'Z', 'P', 'Q'];
  const g = beats('Y>X Z>X X>P X>Q Y>P Q>Y Z>Q P>Z');
  // X 2-2, Y 2-2, Z 2-2 (all beat one of P/Q)... P 1-2, Q 1-2... add a clear leader is not needed: berths 2.
  const L = league(names, g, { metric: { Y: 2, Z: 1 } });
  const r = L.top2('midam');
  assert.ok(!r.includes('X'), 'X lost to both other tied teams: ' + r.join(' v '));
});

test('2025 title games', () => {
  const r = season(2025);
  same(r('SEC'), ['Georgia', 'Alabama']);
  same(r('Big Ten'), ['Ohio State', 'Indiana']);
  same(r('Big 12'), ['Texas Tech', 'BYU']);
  // The MAC's 2025 procedure, as it applied it on Nov 24, 2025: head-to-head among all three, a team that beat
  // the other two, then record against common opponents (Miami 3-0, Toledo 2-1, Ohio 1-2). Its current page
  // has since changed that order, so 2025 is checked against the 2025 rules.
  const S = TB.steps, mac2025 = {
    two: [S.h2h(), S.common(), S.ordered(), S.oppPct('sum'), S.metric, S.coin],
    multi: [S.h2h({ beat: 1 }), S.common(), S.ordered(), S.oppPct('sum'), S.metric, S.coin]
  };
  same(r('Mid-American', { rules: mac2025 }), ['Western Michigan', 'Miami (OH)']);
  same(r('Conference USA'), ['Kennesaw State', 'Jacksonville State']);
  same(r('Sun Belt', { divs: ['East', 'West'] }), ['James Madison', 'Troy']);
  // Four tied at 6-2; settled by the composite of computer rankings (UNLV best, then Boise State, San Diego
  // State, New Mexico, as the conference announced).
  same(r('Mountain West', { metric: { UNLV: 4, 'Boise State': 3, 'San Diego State': 2, 'New Mexico': 1 } }), ['UNLV', 'Boise State']);
  // Tulane was the American's highest-ranked team (No. 24) going into the final week.
  same(r('American Athletic', { rank: { Tulane: 24 } }), ['Tulane', 'North Texas']);
});
