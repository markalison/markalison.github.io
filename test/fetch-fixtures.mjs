// Saves real regular-season results for past seasons as test fixtures, so the conference tiebreakers can be
// checked against the title games that were actually played. Needs the free CollegeFootballData key in
// .cfbd-key (not committed) or CFBD_KEY. Usage: node test/fetch-fixtures.mjs 2024 2025
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const keyFile = new URL('../.cfbd-key', import.meta.url);
const KEY = process.env.CFBD_KEY || (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '');
if (!KEY) throw new Error('No CollegeFootballData key: put it in .cfbd-key or CFBD_KEY');
const API = 'https://api.collegefootballdata.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (path) => {
  for (let k = 0; k < 4; k++) {
    const r = await fetch(API + path, { headers: { authorization: 'Bearer ' + KEY, 'user-agent': 'cfp-odds-board' } });
    if (r.ok) return r.json();
    if (r.status === 401 || r.status === 403) throw new Error('key refused: ' + r.status);
    await sleep(1500 * (k + 1));
  }
  throw new Error('failed ' + path);
};

const years = process.argv.slice(2).map(Number).filter(Boolean);
mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true });
for (const year of years.length ? years : [2024, 2025]) {
  const teams = await get(`/teams/fbs?year=${year}`);
  const games = await get(`/games?year=${year}&seasonType=regular`);
  const fbs = new Set(teams.map((t) => t.school));
  const out = {
    year,
    teams: teams.map((t) => ({ name: t.school, conf: t.conference, div: t.division || null })),
    // Every completed regular-season game with an FBS team in it. Conference title games are left out.
    games: games
      .filter((g) => (fbs.has(g.homeTeam) || fbs.has(g.awayTeam)) && g.homePoints != null && g.awayPoints != null && !/championship/i.test(g.notes || ''))
      .map((g) => ({ wk: g.week, d: g.startDate, h: g.homeTeam, a: g.awayTeam, hs: g.homePoints, as: g.awayPoints, c: g.conferenceGame ? 1 : 0, n: g.neutralSite ? 1 : 0 })),
  };
  writeFileSync(new URL(`./fixtures/cfb-${year}.json`, import.meta.url), JSON.stringify(out));
  console.log(year, out.teams.length, 'teams,', out.games.length, 'games');
}
