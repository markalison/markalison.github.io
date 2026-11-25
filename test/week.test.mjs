// The rankings table's week column (engine.js tableWeek) through the end of a season, and the engine side of
// conference title picks. Uses this season's real schedule from data.json. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const CFP = createRequire(import.meta.url)('../engine.js');
const { D } = JSON.parse(readFileSync(new URL('../data.json', import.meta.url)));

const at = (s) => Date.parse(s);
// The season as it would look at time now: games that kicked off over 4 hours earlier are final, games under
// way are live, the rest to come. done(g) can force a game final (true) or unfinished (false).
function asOf(now, done = () => null) {
  const games = D.games.map((g) => {
    const t = Date.parse(g.d), f = done(g);
    const s = f === true ? 'post' : f === false ? (t <= now ? 'in' : 'pre') : t + 4 * 3600e3 <= now ? 'post' : t <= now ? 'in' : 'pre';
    return { ...g, s };
  });
  const titles = D.titles.map((t) => ({ ...t, s: Date.parse(t.d) + 4 * 3600e3 <= now ? 'post' : 'pre', w: Date.parse(t.d) + 4 * 3600e3 <= now ? 0 : -1 }));
  return { games, titles };
}
const week = (now, done) => { const { games, titles } = asOf(now, done); return CFP.tableWeek(games, titles, now); };
const wkOf = (n) => D.games.filter((g) => g.wk === n).map((g) => g.d).sort();

test('the schedule has what these tests assume', () => {
  assert.ok(wkOf(12).length && wkOf(13).length, 'weeks 12 and 13');
  assert.ok(D.titles.length >= 8, 'title games');
  assert.ok(Math.max(...D.games.filter((g) => Date.parse(g.d) < Date.parse(D.titles[0].d)).map((g) => g.wk)) === 13);
});

test('preseason: the first week', () => {
  assert.deepEqual(week(at('2026-08-01T12:00Z')), { wk: 1, ccg: false });
});

test('midweek, with this week\'s first games played and the weekend to come: this week', () => {
  // Wednesday of week 12 (its Tuesday game is over).
  assert.deepEqual(week(at('2026-11-18T18:00Z')), { wk: 12, ccg: false });
});

test('Saturday with games under way: still this week', () => {
  assert.deepEqual(week(at('2026-11-21T20:00Z')), { wk: 12, ccg: false });
});

test('once every game of the week is final: next week, before any of its games start', () => {
  assert.deepEqual(week(at('2026-11-22T15:00Z')), { wk: 13, ccg: false });
  // Monday and Tuesday too.
  assert.deepEqual(week(at('2026-11-24T15:00Z')), { wk: 13, ccg: false });
});

test('one game of the week still unfinished keeps the week', () => {
  const late = D.games.filter((g) => g.wk === 12).sort((a, b) => (a.d < b.d ? 1 : -1))[0];
  assert.deepEqual(week(at('2026-11-22T15:00Z'), (g) => (g.id === late.id ? false : null)), { wk: 12, ccg: false });
  // A game left "in progress" by a stale feed counts as over when the page says so (its status function).
  const { games, titles } = asOf(at('2026-11-22T15:00Z'), (g) => (g.id === late.id ? false : null));
  const stale = (g) => (g.id === late.id ? 'post' : g.s);
  assert.deepEqual(CFP.tableWeek(games, titles, at('2026-11-22T15:00Z'), stale), { wk: 13, ccg: false });
});

test('a postponed game (final with no score) does not hold the week', () => {
  const { games, titles } = asOf(at('2026-11-22T15:00Z'));
  const g = games.find((x) => x.wk === 12);
  g.s = 'post'; g.hs = 0; g.as = 0;
  assert.deepEqual(CFP.tableWeek(games, titles, at('2026-11-22T15:00Z')), { wk: 13, ccg: false });
});

test('the last regular week, under way: that week', () => {
  assert.deepEqual(week(at('2026-11-28T20:00Z')), { wk: 13, ccg: false });
});

test('after the last regular week: conference championship week, not the next numbered week', () => {
  assert.deepEqual(week(at('2026-11-30T15:00Z')), { wk: 14, ccg: true });
  assert.deepEqual(week(at('2026-12-03T15:00Z')), { wk: 14, ccg: true });
});

test('championship week stays while any title game is unfinished', () => {
  const now = at('2026-12-05T23:00Z'); // some title games over, the evening ones not
  const w = week(now);
  assert.deepEqual(w, { wk: 14, ccg: true });
});

test('after every title game: the next week with games (Army-Navy)', () => {
  assert.deepEqual(week(at('2026-12-07T15:00Z')), { wk: 15, ccg: false });
  assert.deepEqual(week(at('2026-12-14T15:00Z')), { wk: 15, ccg: false });
});

test('without title games in the data, the weeks simply run on', () => {
  const { games } = asOf(at('2026-11-30T15:00Z'));
  assert.deepEqual(CFP.tableWeek(games, [], at('2026-11-30T15:00Z')), { wk: 15, ccg: false });
});

// ---- title games from ESPN's feed
function espn(titleEv) {
  const conf = { abbreviation: 'SEC', name: 'Southeastern Conference', shortName: 'SEC', id: '8', standings: { entries: ['Georgia', 'Texas', 'Alabama'].map((t, k) => ({ team: { id: String(61 + k), location: t, displayName: t + ' Team', abbreviation: t.slice(0, 3) } })) } };
  return CFP.parseEspn({ standings: { children: [conf] }, rankings: { rankings: [] }, weeks: [{ events: [titleEv] }] });
}
const titleEv = (home, away, state = 'pre', extra = {}) => ({ id: '9', date: '2026-12-05T21:00Z', week: { number: 14 }, status: { period: extra.period, clock: extra.clock, type: { state, name: 'X', shortDetail: 'x' } },
  competitions: [{ neutralSite: true, notes: [{ headline: 'SEC Championship' }], competitors: [['home', home, extra.hs], ['away', away, extra.as]].map(([homeAway, t, score]) => ({ homeAway, id: t[0], score, team: { id: t[0], location: t[1], displayName: t[1], abbreviation: 'X' } })) }] });
test('a clinched team is read from ESPN by id, or by name when its id is a placeholder; TBD is nobody', () => {
  const P = (a, b) => { const r = espn(titleEv(a, b)); return r.titles[0].clinch.map((i) => r.teams[i].name); };
  if (!espn(titleEv(['-1', 'TBD'], ['-2', 'TBD'])).fbs) return assert.fail('fixture conference not recognised');
  assert.deepEqual(P(['-1', 'TBD'], ['-2', 'TBD']), []);
  assert.deepEqual(P(['61', 'Georgia'], ['-2', 'TBD']), ['Georgia']);
  assert.deepEqual(P(['-1', 'Texas'], ['-2', 'TBD']), ['Texas']);
  const r = espn(titleEv(['-1', 'Texas'], ['61', 'Georgia']));
  assert.ok(r.titles[0].h >= 0 && r.titles[0].a >= 0);
});
const withTitle = (conf, f) => ({ ...D, titles: D.titles.map((t) => (t.conf === conf ? { ...t, ...f } : t)) });
test('a clinched team is in its title game in every simulated season', () => {
  const uga = D.teams.findIndex((t) => t.ab === 'UGA'), ala = D.teams.findIndex((t) => t.ab === 'ALA');
  for (const i of [uga, ala]) assert.equal(CFP.runAll(withTitle('sec', { h: -1, a: -1, clinch: [i] }), 'blend', 1500, 3, 50).teams[i].ccg, 1);
});
test('a finished title game counts as a loss for the loser, and a live lead counts', () => {
  const uga = D.teams.findIndex((t) => t.ab === 'UGA'), tex = D.teams.findIndex((t) => t.ab === 'TEX');
  const base = { h: uga, a: tex, clinch: [uga, tex] };
  const lost = CFP.runAll(withTitle('sec', { ...base, s: 'post', hs: 10, as: 20, w: tex }), 'blend', 3000, 3, 50).teams;
  const won = CFP.runAll(withTitle('sec', { ...base, s: 'post', hs: 20, as: 10, w: uga }), 'blend', 3000, 3, 50).teams;
  assert.equal(lost[tex].champ, 1); assert.equal(won[uga].champ, 1);
  assert.ok(lost[tex].cfp > won[tex].cfp && won[uga].seed < lost[uga].seed);
  // The loser's résumé takes the loss: the same as a simulated loss (a pick) gives, within noise.
  const pick = CFP.runAll(withTitle('sec', base), 'blend', 3000, 3, 50, { ['ccg:sec:' + D.teams[uga].id]: 'L' }).teams;
  assert.ok(Math.abs(pick[uga].cfp - lost[uga].cfp) < 0.05, pick[uga].cfp + ' v ' + lost[uga].cfp);
  const live = CFP.runAll(withTitle('sec', { ...base, s: 'in', hs: 0, as: 21, frac: 0.1 }), 'blend', 2000, 3, 50).teams;
  assert.ok(live[tex].champ > 0.95, String(live[tex].champ));
});

// ---- conference title picks in the simulation
test('a "Win conf." pick: the team wins its conference exactly when it reaches the title game', () => {
  const uga = D.teams.findIndex((t) => t.ab === 'UGA'), ttu = D.teams.findIndex((t) => t.ab === 'TTU');
  const picks = { ['ccg:sec:' + D.teams[uga].id]: 'W', ['ccg:big12:' + D.teams[ttu].id]: 'W' };
  const r = CFP.runAll(D, 'blend', 4000, 7, 200, picks).teams;
  assert.equal(r[uga].champ, r[uga].ccg);
  assert.equal(r[ttu].champ, r[ttu].ccg);
  // Every simulated season still crowns exactly one champion per conference.
  const sec = D.teams.map((t, i) => i).filter((i) => i < D.fbs && D.teams[i].conf === 'sec');
  assert.ok(Math.abs(sec.reduce((s, i) => s + r[i].champ, 0) - 1) < 1e-9);
  const none = CFP.runAll(D, 'blend', 4000, 7, 200).teams;
  assert.ok(none[uga].champ < none[uga].ccg, 'without a pick it can lose the title game');
});

test('a title game loss pick: the team never wins its conference, and still reaches the game as often', () => {
  const uga = D.teams.findIndex((t) => t.ab === 'UGA'), key = 'ccg:sec:' + D.teams[uga].id;
  const base = CFP.runAll(D, 'blend', 3000, 7, 200).teams, r = CFP.runAll(D, 'blend', 3000, 7, 200, { [key]: 'L' }).teams;
  assert.ok(base[uga].champ > 0);
  assert.equal(r[uga].champ, 0);
  assert.ok(Math.abs(r[uga].ccg - base[uga].ccg) < 0.03);
  // Every SEC team picked to lose: the picks contradict each other, so the games decide and there is still one champion.
  const sec = D.teams.map((t, i) => i).filter((i) => i < D.fbs && D.teams[i].conf === 'sec');
  const all = CFP.runAll(D, 'blend', 1000, 7, 50, Object.fromEntries(sec.map((i) => ['ccg:sec:' + D.teams[i].id, 'L']))).teams;
  assert.ok(Math.abs(sec.reduce((t, i) => t + all[i].champ, 0) - 1) < 1e-9);
});

test('a pick for a team that cannot reach the title game changes nothing for the others', () => {
  const sec = D.teams.map((t, i) => i).filter((i) => i < D.fbs && D.teams[i].conf === 'sec');
  const base = CFP.runAll(D, 'blend', 3000, 11, 200).teams;
  const out = sec.find((i) => base[i].ccg === 0);
  if (out == null) return; // every SEC team still alive
  const r = CFP.runAll(D, 'blend', 3000, 11, 200, { ['ccg:sec:' + D.teams[out].id]: 'W' }).teams;
  sec.forEach((i) => assert.equal(r[i].champ, base[i].champ));
});

test('Pac-12 week-13 flex games stay out of the conference standings', () => {
  const pac = D.teams.map((t, i) => i).filter((i) => D.teams[i].conf === 'pac12');
  const [a, b] = pac;
  const flex = { id: 'flex-test', d: '2026-11-28T20:00Z', h: a, a: b, n: 0, c: 1, s: 'post', hs: 30, as: 10, w: a, wk: 13 };
  const P0 = CFP.prep(D, 'blend'), P1 = CFP.prep({ ...D, games: D.games.concat([flex]) }, 'blend');
  assert.equal(P1.CW0[a], P0.CW0[a]);
  assert.equal(P1.CL0[b], P0.CL0[b]);
  assert.equal(P1.W0[a], P0.W0[a] + 1, 'it still counts as a win overall');
});
