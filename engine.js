// CFP odds engine. Shared by build.mjs (Node), the page and its Web Worker.
// No DOM or Node APIs. Exposes one global: CFP.
var CFP = (function () {
  'use strict';

  var P4 = ['sec', 'big10', 'big12', 'acc'];
  var G6 = ['american', 'usa', 'midam', 'mwest', 'pac12', 'belt'];
  var CONF_NAME = {
    sec: 'SEC', big10: 'Big Ten', big12: 'Big 12', acc: 'ACC', american: 'American', usa: 'C-USA',
    midam: 'MAC', mwest: 'Mountain West', pac12: 'Pac-12', belt: 'Sun Belt', ind: 'Independent', fcs: 'FCS'
  };
  // Short codes for narrow screens.
  var CONF_ABBR = {
    sec: 'SEC', big10: 'B1G', big12: 'B12', acc: 'ACC', american: 'AAC', usa: 'CUSA',
    midam: 'MAC', mwest: 'MW', pac12: 'P12', belt: 'SBC', ind: 'IND', fcs: 'FCS'
  };
  var TITLE_RX = [
    [/\bSEC\b/, 'sec'], [/Big Ten/, 'big10'], [/Big 12/, 'big12'], [/\bACC\b/, 'acc'], [/American/, 'american'],
    [/Conference USA|C-USA/, 'usa'], [/\bMAC\b|Mid-American/, 'midam'], [/Mountain West/, 'mwest'],
    [/Pac-12/, 'pac12'], [/Sun Belt/, 'belt']
  ];

  // Model constants. Everything shown on the page's method section comes from here.
  var M = {
    gameSD: 14,        // points of single-game randomness around the spread
    teamSD: 3,         // per-simulation uncertainty in a team's true rating
    surprise: 3,       // rating points per unit of (result - expected) after each game
    wRating: 0.65,       // weight on the power rating itself
    wLoss: 7,          // committee points per loss
    wLoss3: 2,         // extra points per loss beyond the second
    wTitleLoss: 0.5,   // share of a loss charged for a title-game defeat
    wSos: 0.5,         // per point of average opponent rating
    wTop10: 2.5,       // per win over a final top-10 team
    wTop25: 1.25,      // per win over a final 11-25 team
    wBadLoss: 3,       // extra per loss to a team outside the top 60
    wGoodLoss: 1,      // back per loss to a top-25 team (the committee forgives these a little)
    wChampP4: 4,       // power-conference champion
    wChampG6: 2,       // other-conference champion
    wG6: -2,           // non-power schedule discount
    wAnchor: 0.6,      // how much of the current CFP ranking's opinion carries forward
    committeeSD: 2.2,  // per-simulation committee disagreement
    h2hWindow: 3       // a head-to-head winner jumps a team within this many points
  };

  // ---------- ESPN parsing ----------
  function parseEspn(raw) {
    var teams = [], byId = {};
    function addTeam(t, conf, div) {
      // The standings feed has no team colors; the scoreboard's teams do, so a later sighting fills one in.
      if (byId[t.id] != null) { var k = teams[byId[t.id]]; if (!k.color && t.color) k.color = t.color; return byId[t.id]; }
      byId[t.id] = teams.length;
      teams.push({
        id: String(t.id), ab: t.abbreviation || '', name: t.location || t.displayName || t.shortDisplayName || t.name,
        full: t.displayName || t.name, color: t.color || null, conf: conf, div: div || null, rank: null
      });
      return byId[t.id];
    }
    var confKey = { american: 'american', acc: 'acc', big12: 'big12', big10: 'big10', usa: 'usa', ind: 'ind', midam: 'midam', mwest: 'mwest', pac12: 'pac12', sec: 'sec', belt: 'belt' };
    (raw.standings.children || []).forEach(function (c) {
      var key = confKey[c.abbreviation] || String(c.abbreviation).toLowerCase();
      if (c.standings && c.standings.entries && c.standings.entries.length) {
        c.standings.entries.forEach(function (e) { addTeam(e.team, key); });
      }
      (c.children || []).forEach(function (sub) {
        ((sub.standings && sub.standings.entries) || []).forEach(function (e) { addTeam(e.team, key, sub.name); });
      });
    });
    var fbsCount = teams.length, games = [], titles = [], seen = {};
    (raw.weeks || []).forEach(function (wk) {
      (wk.events || []).forEach(function (ev) {
        if (seen[ev.id]) return;
        seen[ev.id] = 1;
        var c = ev.competitions && ev.competitions[0];
        if (!c) return;
        var st = (ev.status && ev.status.type) || (c.status && c.status.type) || {};
        if (/CANCEL|POSTPONED|FORFEIT/i.test(st.name || '')) return;
        var note = (c.notes && c.notes[0] && c.notes[0].headline) || '';
        var hc = null, ac = null;
        (c.competitors || []).forEach(function (x) { if (x.homeAway === 'home') hc = x; else ac = x; });
        if (!hc || !ac) return;
        var state = st.state === 'post' || st.completed ? 'post' : st.state === 'in' ? 'in' : 'pre';
        var titleConf = null;
        if (/Championship/i.test(note)) TITLE_RX.forEach(function (r) { if (!titleConf && r[0].test(note)) titleConf = r[1]; });
        var known = +hc.id > 0 && +ac.id > 0;
        if (titleConf) {
          var tg = { conf: titleConf, n: c.neutralSite ? 1 : 0, d: ev.date, s: state, h: -1, a: -1, w: -1 };
          if (known) {
            tg.h = addTeam(hc.team, 'fcs'); tg.a = addTeam(ac.team, 'fcs');
            if (state === 'post') tg.w = +hc.score > +ac.score ? tg.h : tg.a;
          }
          titles.push(tg);
          return;
        }
        if (!known) return;
        var h = addTeam(hc.team, 'fcs'), a = addTeam(ac.team, 'fcs');
        var g = { id: String(ev.id), d: ev.date, h: h, a: a, n: c.neutralSite ? 1 : 0, c: c.conferenceCompetition ? 1 : 0, s: state, w: -1, wk: ev.week ? ev.week.number : null };
        // TV networks, national first, e.g. ["ABC"] or ["ESPN+", "SECN+"].
        var tv = [];
        (c.broadcasts || []).slice().sort(function (x, y) { return (x.market === 'national' ? 0 : 1) - (y.market === 'national' ? 0 : 1); })
          .forEach(function (b) { (b.names || []).forEach(function (nm) { if (nm && tv.indexOf(nm) < 0) tv.push(nm); }); });
        if (tv.length) g.tv = tv.slice(0, 2);
        if (state === 'post') {
          g.hs = +hc.score; g.as = +ac.score;
          g.w = (hc.winner === true || (hc.winner !== false && g.hs > g.as)) ? h : a;
        } else if (state === 'in') {
          // Share of regulation left: 4 quarters of 900 seconds.
          // Overtime: both teams get the ball, so a lead after one possession isn't banked. Treat it as about
          // one possession of randomness left (a quarter of a game's) with half the lead counting (g.ot).
          var es = ev.status || {}, per = +es.period || 1, clk = es.clock == null ? 900 : +es.clock;
          g.hs = +hc.score || 0; g.as = +ac.score || 0;
          if (per > 4) { g.ot = 1; g.frac = 0.25; }
          else g.frac = Math.min(1, Math.max(0.003, ((4 - per) * 900 + clk) / 3600));
          g.st = st.shortDetail || st.detail || '';
        }
        games.push(g);
      });
    });
    games.sort(function (x, y) { return x.d < y.d ? -1 : x.d > y.d ? 1 : 0; });
    var rankDate = null, rankings = raw.rankings && raw.rankings.rankings;
    var cfp = rankings && rankings.filter(function (r) { return r.type === 'cfp'; })[0];
    if (cfp) {
      rankDate = cfp.date;
      cfp.ranks.forEach(function (r) { var i = byId[r.team.id]; if (i != null) { teams[i].rank = r.current; if (r.previous) teams[i].rankPrev = r.previous; } });
    }
    // The AP and Coaches polls, for the team pages: { r: this week's place, p: last week's (0 if unranked) }.
    [['ap', 'ap'], ['usa', 'coach']].forEach(function (k) {
      var poll = rankings && rankings.filter(function (r) { return r.type === k[0]; })[0];
      if (poll) poll.ranks.forEach(function (r) { var i = byId[r.team.id]; if (i != null && r.current) teams[i][k[1]] = { r: r.current, p: r.previous || 0 }; });
    });
    return { teams: teams, fbs: fbsCount, games: games, titles: titles, rankDate: rankDate, rankLabel: cfp ? cfp.headline : null, hasCfp: !!cfp };
  }

  // Ratings are aligned by the build step to ESPN team order.
  // A team a model doesn't cover, such as an FCS opponent, falls back to Massey.
  function ratingFor(team, mode, sources) {
    var r = team.r || {}, align = sources.align;
    if (mode === 'blend') return 0.5 * (r.massey + (r.predictor - align)); // Massey + Sagarin on Massey's scale
    if (mode === 'all') {
      var sum = 0;
      sources.consensus.forEach(function (k) {
        var v = r[k];
        sum += v == null ? r.massey : k === 'predictor' ? v - align : v;
      });
      return sum / sources.consensus.length;
    }
    return r[mode] == null ? r.massey : r[mode];
  }

  // Puts ESPN's FPI on Massey's scale. FPI is already in points, so only the average shifts.
  function applyFpi(D, json) {
    var byId = {}, sumF = 0, sumM = 0, n = 0, i;
    (json.teams || []).forEach(function (x) {
      var c = (x.categories || []).filter(function (k) { return k.name === 'fpi'; })[0];
      if (c && typeof c.values[0] === 'number') byId[String(x.team.id)] = c.values[0];
    });
    for (i = 0; i < D.fbs; i++) {
      var f = byId[D.teams[i].id];
      if (f != null) { sumF += f; sumM += D.teams[i].r.massey; n++; }
    }
    if (n < D.fbs - 8) return false;
    var shift = (sumM - sumF) / n;
    D.teams.forEach(function (t, idx) {
      var v = byId[t.id];
      t.r.fpi = idx < D.fbs && v != null ? Math.round((v + shift) * 100) / 100 : null;
    });
    // ESPN's update time falls after that day's games, so results run through the day before.
    var updated = Date.parse(json.lastUpdated);
    D.sources.thru.fpi = new Date((isNaN(updated) ? Date.now() : updated) - 864e5).toISOString().slice(0, 10);
    return true;
  }

  function phi(x) {
    // Normal CDF (Abramowitz & Stegun 26.2.17)
    var a = Math.abs(x), t = 1 / (1 + 0.2316419 * a);
    var p = Math.exp(-0.5 * a * a) * 0.39894228 * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x > 0 ? 1 - p : p;
  }

  var GN = null;
  function gaussTable() {
    if (GN) return GN;
    GN = new Float64Array(65536);
    for (var i = 0; i < 65536; i += 2) {
      var u = (i + 0.5) / 65536, v = ((i * 40503) % 65536 + 0.5) / 65536;
      var m = Math.sqrt(-2 * Math.log(u));
      GN[i] = m * Math.cos(6.283185307 * v);
      GN[i + 1] = m * Math.sin(6.283185307 * v);
    }
    return GN;
  }

  // ---------- CFP ranking fallback ----------
  // The site API's rankings feed only lists the newest polls. From Sunday, when the new AP and Coaches polls
  // come out, until the committee's Tuesday release, it has no CFP ranking at all. ESPN's core API keeps every
  // week's CFP ranking (ranking type 21), so the latest one is read from there and added to the feed.
  function withCfp(rankings, season, get) {
    var list = (rankings && rankings.rankings) || [];
    if (list.some(function (r) { return r.type === 'cfp'; })) return Promise.resolve(rankings);
    var https = function (u) { return String(u).replace(/^http:/, 'https:'); };
    return get('https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/' + season + '/rankings/21').then(function (idx) {
      var weeks = (idx && idx.rankings) || [];
      if (!weeks.length) return rankings;
      return get(https(weeks[weeks.length - 1].$ref)).then(function (wk) {
        if (!wk || !wk.ranks || !wk.ranks.length) return rankings;
        var cfp = { type: 'cfp', name: wk.name, headline: wk.headline, date: wk.date, ranks: wk.ranks.map(function (r) {
          var id = ((r.team && r.team.$ref) || '').match(/teams\/(\d+)/);
          return { current: r.current, team: { id: id ? id[1] : null } };
        }).filter(function (r) { return r.team.id; }) };
        return Object.assign({}, rankings, { rankings: list.concat([cfp]) });
      });
    }).catch(function () { return rankings; });
  }

  // ---------- Playoff impact of single games ----------
  // Swing in its two teams' Make CFP odds, added together, for each game in ids. All of those games go back to
  // unplayed (a pre-game view): a final compares its real result with the game left open; any other game
  // compares a home win with an away win. Every run shares one seed and one game list (finals become locked
  // games), so each difference comes from that one game.
  function measureSwings(D, mode, seed, sims, ids) {
    var set = {}, lock = {}, done = [], open = [], out = {}, pair = {};
    ids.forEach(function (id) { set[id] = 1; });
    D.games.forEach(function (g) {
      if (!set[g.id]) return;
      pair[g.id] = [g.h, g.a].filter(function (i) { return i < D.fbs; });
      if (g.s === 'post') { lock[g.id] = D.teams[g.w].id; done.push(g.id); }
      else open.push({ id: g.id, h: D.teams[g.h].id, a: D.teams[g.a].id });
    });
    var data = Object.assign({}, D, { games: D.games.map(function (g) { return set[g.id] ? Object.assign({}, g, { s: 'pre', hs: 0, as: 0, w: null }) : g; }) });
    function cfp(lk) {
      var P = prep(data, mode, lk), sim = new Sim(P, seed), t = emptyTally(P.n), r = [];
      baseBatch(sim, t, sims);
      for (var i = 0; i < P.fbs; i++) r.push(t.cfp[i] / sims);
      return r;
    }
    function diff(a, b, id) { var s = 0; pair[id].forEach(function (i) { s += Math.abs(a[i] - b[i]); }); return Math.round(s * 1e4) / 1e4; }
    function withPick(id, v) { var pk = {}; for (var k in lock) if (k !== id) pk[k] = lock[k]; if (v) pk[id] = v; return pk; }
    var base = done.length ? cfp(lock) : null;
    done.forEach(function (id) { out[id] = diff(cfp(withPick(id, null)), base, id); });
    open.forEach(function (o) { out[o.id] = diff(cfp(withPick(o.id, o.h)), cfp(withPick(o.id, o.a)), o.id); });
    return out;
  }

  // ---------- Conference title game tiebreakers ----------
  // Each conference's own published procedure for picking its two title-game teams. Sources (2026 season):
  // ACC policy as amended July 1, 2026; Big 12 tiebreaking procedures (2024, unchanged since); Big Ten 2024
  // procedures (carried forward); SEC tie-breaking process of Oct 29, 2024 (carried forward); Pac-12 release of
  // Sept 3, 2026; American 2025 handbook section 10; Conference USA football regulations; MAC championship
  // tiebreaker; Mountain West 2025 procedures; Sun Belt divisional procedures (2026 members).
  // Inputs the conferences take from outside the results (SportSource ratings, the composite of computer
  // rankings, the scoring-margin formula) are stood in for by the simulation's own numbers: ctx.metric (our
  // committee-style résumé score) and ctx.rating (team strength). Coin tosses and draws use ctx.rand.
  //
  // ctx (indices are team numbers):
  //   cw(t), cl(t)  conference wins and losses     ch(a, b)  conference wins of a over b
  //   w(t), l(t)    all wins and losses            fcsW(t)   wins over teams below FBS
  //   metric(t), rating(t)  higher is better       rank(t)   CFP rank entering the final week (0 unranked)
  //   lostFinal(t)  lost its final conference game  rand()   uniform [0, 1)
  //   div(t)        division name (Sun Belt)
  var TB = (function () {
    function pct(w, l) { return w + l ? w / (w + l) : 0; }
    function confPct(ctx, t) { return pct(ctx.cw(t), ctx.cl(t)); }
    function games(ctx, a, b) { return ctx.ch(a, b) + ctx.ch(b, a); }
    function without(list, out) { return list.filter(function (t) { return out.indexOf(t) < 0; }); }
    function vals(G, f) { return { v: G.map(f) }; }

    // ----- steps: each looks at the tied group G and returns null (no help), { v: [value per team] } (higher
    // is better), { adv: t } (t takes a berth and the rest start over) or { out: [teams] } (removed from the tie).
    // Head-to-head: the record in games among the tied teams. o.full: count it only if every tied team played
    // every other; o.beat: if not, a team that beat each of the others advances; o.lost: and one that lost to
    // each of the others is removed. o.any: use the record among the tied teams whoever played (Sun Belt).
    function h2h(o) {
      o = o || {};
      return function (G, ctx) {
        var all = true, i, j;
        for (i = 0; i < G.length; i++) for (j = i + 1; j < G.length; j++) if (!games(ctx, G[i], G[j])) all = false;
        if (all || o.any || G.length === 2) {
          return vals(G, function (a) {
            var w = 0, l = 0;
            G.forEach(function (b) { if (b !== a) { w += ctx.ch(a, b); l += ctx.ch(b, a); } });
            return w + l ? w / (w + l) : 0.5;
          });
        }
        if (o.beat) {
          for (i = 0; i < G.length; i++) {
            var a = G[i];
            if (G.every(function (b) { return b === a || (ctx.ch(a, b) > 0 && ctx.ch(b, a) === 0); })) return { adv: a };
          }
        }
        if (o.lost) {
          var out = G.filter(function (a) { return G.every(function (b) { return b === a || (ctx.ch(b, a) > 0 && ctx.ch(a, b) === 0); }); });
          if (out.length && out.length < G.length) return { out: out };
        }
        return null;
      };
    }
    // Record against the conference opponents every tied team played (the tied teams themselves left out).
    function common(o) {
      o = o || {};
      return function (G, ctx, members) {
        var pool = members.filter(function (s) {
          if (G.indexOf(s) >= 0) return false;
          if (o.nonDiv && ctx.div(s) === ctx.div(G[0])) return false;
          return G.every(function (t) { return games(ctx, t, s) > 0; });
        });
        if (!pool.length) return null;
        return vals(G, function (t) {
          var w = 0, l = 0;
          pool.forEach(function (s) { w += ctx.ch(t, s); l += ctx.ch(s, t); });
          return pct(w, l);
        });
      };
    }
    // Record against the next-best common opponent, working down the standings. Teams level in the standings
    // count as one group: each tied team's record against that group. o.all: every tied team must have played
    // every team in the group (Mountain West), otherwise the group is skipped; by default the group is narrowed
    // to the teams all the tied teams played. o.div: the divisional standings (Sun Belt).
    function ordered(o) {
      o = o || {};
      return function (G, ctx, members) {
        var rest = members.filter(function (s) { return G.indexOf(s) < 0 && (!o.div || ctx.div(s) === ctx.div(G[0])); });
        var key = function (s) { return confPct(ctx, s); };
        rest.sort(function (a, b) { return key(b) - key(a); });
        for (var i = 0; i < rest.length;) {
          var level = [rest[i]], k = key(rest[i]), j = i + 1;
          while (j < rest.length && Math.abs(key(rest[j]) - k) < 1e-9) level.push(rest[j++]);
          i = j;
          var faced = level.filter(function (s) { return G.every(function (t) { return games(ctx, t, s) > 0; }); });
          if (o.all ? faced.length < level.length : !faced.length) continue;
          var r = G.map(function (t) { var w = 0, l = 0; faced.forEach(function (s) { w += ctx.ch(t, s); l += ctx.ch(s, t); }); return pct(w, l); });
          if (r.some(function (x) { return Math.abs(x - r[0]) > 1e-9; })) return { v: r };
        }
        return null;
      };
    }
    // Strength of conference schedule. 'sum': all conference opponents' records added together, one per game
    // played; 'avg': the average of each opponent's conference winning percentage (SEC).
    function oppPct(mode) {
      return function (G, ctx, members) {
        return vals(G, function (t) {
          var w = 0, l = 0, s = 0, n = 0;
          members.forEach(function (o) {
            var g = games(ctx, t, o);
            if (!g || o === t) return;
            if (mode === 'avg') { s += confPct(ctx, o); n++; } else { w += g * ctx.cw(o); l += g * ctx.cl(o); }
          });
          return mode === 'avg' ? (n ? s / n : 0) : pct(w, l);
        });
      };
    }
    function divPct(ctx, t, members) {
      var w = 0, l = 0;
      members.forEach(function (o) { if (o !== t && ctx.div(o) === ctx.div(t)) { w += ctx.ch(t, o); l += ctx.ch(o, t); } });
      return pct(w, l);
    }
    var divRecord = function (G, ctx, members) { return vals(G, function (t) { return divPct(ctx, t, members); }); };
    var metric = function (G, ctx) { return vals(G, function (t) { return ctx.metric(t); }); };
    var rating = function (G, ctx) { return vals(G, function (t) { return ctx.rating(t); }); };
    var coin = function (G, ctx) { return vals(G, function () { return ctx.rand(); }); };
    // Total wins, counting at most one win over a team below FBS (Big 12's 12-game season).
    var totalWins = function (G, ctx) { return vals(G, function (t) { return ctx.w(t) - Math.max(0, ctx.fcsW(t) - 1); }); };
    function overall(capFcs) {
      return function (G, ctx) { return vals(G, function (t) { var w = ctx.w(t) - (capFcs ? Math.max(0, ctx.fcsW(t) - 1) : 0); return pct(w, ctx.l(t)); }); };
    }
    // CFP ranking: the highest-ranked tied team that didn't lose its final conference game advances; with no
    // such team (none ranked, or the ranked ones lost), the composite of computer rankings decides.
    var cfpThenMetric = function (G, ctx) {
      var ok = G.filter(function (t) { return ctx.rank(t) > 0 && !ctx.lostFinal(t); }).sort(function (a, b) { return ctx.rank(a) - ctx.rank(b); });
      return ok.length ? { adv: ok[0] } : metric(G, ctx);
    };
    var cfpTopOrMetric = function (G, ctx) {
      var ranked = G.filter(function (t) { return ctx.rank(t) > 0; }).sort(function (a, b) { return ctx.rank(a) - ctx.rank(b); });
      return ranked.length && !ctx.lostFinal(ranked[0]) ? { adv: ranked[0] } : metric(G, ctx);
    };
    // A plain CFP ranking comparison (Pac-12 two-team step): unranked teams are level with each other.
    var cfpRank = function (G, ctx) { return vals(G, function (t) { return ctx.rank(t) ? 100 - ctx.rank(t) : 0; }); };

    // ----- each conference's two-team and multiple-team orders
    var RULES = {
      sec: { two: [h2h(), common(), ordered(), oppPct('avg'), rating, coin],
        multi: [h2h({ beat: 1, lost: 1 }), common(), ordered(), oppPct('avg'), rating, coin] },
      big10: { two: [h2h(), common(), ordered(), oppPct('sum'), metric, coin],
        multi: [h2h({ beat: 1 }), common(), ordered(), oppPct('sum'), metric, coin] },
      big12: { two: [h2h(), common(), ordered(), oppPct('sum'), totalWins, metric, coin],
        multi: [h2h({ beat: 1 }), common(), ordered(), oppPct('sum'), totalWins, metric, coin] },
      acc: { tied: 'acc', two: [h2h(), metric, coin], multi: [h2h({ beat: 1, lost: 1 }), metric, coin] },
      pac12: { two: [h2h(), ordered(), common(), cfpRank, metric, coin],
        multi: [h2h(), common(), ordered(), oppPct('sum'), metric, coin] },
      american: { two: [h2h(), cfpThenMetric, common(), overall(false), coin],
        multi: [h2h({ beat: 1 }), cfpThenMetric, common(), overall(false), coin] },
      usa: { two: [h2h(), common(), ordered(), metric, oppPct('sum'), coin],
        multi: [h2h({ beat: 1 }), common(), ordered(), metric, oppPct('sum'), coin] },
      midam: { two: [h2h(), oppPct('sum'), metric, coin],
        multi: [h2h({ beat: 1, lost: 1 }), oppPct('sum'), metric, coin] },
      mwest: { two: [h2h(), cfpThenMetric, overall(true), ordered({ all: 1 }), common(), coin],
        multi: [h2h({ beat: 1, lost: 1 }), cfpThenMetric, overall(true), ordered({ all: 1 }), common(), coin] },
      // Sun Belt division champions: tied teams carry on down the list instead of starting over.
      belt: { divs: 1, keepGoing: 1,
        two: [h2h(), divRecord, ordered({ div: 1 }), common({ nonDiv: 1 }), cfpTopOrMetric, overall(false), coin],
        multi: [h2h({ any: 1 }), divRecord, ordered({ div: 1 }), common({ nonDiv: 1 }), cfpTopOrMetric, overall(false), coin] }
    };
    var GENERIC = { two: [h2h(), common(), ordered(), oppPct('sum'), metric, coin], multi: [h2h({ beat: 1 }), common(), ordered(), oppPct('sum'), metric, coin] };

    // The k best of the tied group G, in seed order. After a step gives one team (or two, when two berths are
    // open) the advantage, they take the berths and the rest start the procedure again (the two-team order once
    // two are left). A step that leaves a smaller group on top removes the others from the tie.
    function resolve(G, k, R, ctx, members) {
      var chosen = [], from = 0;
      G = G.slice();
      while (k > 0 && G.length) {
        if (G.length <= k) {
          var ord = G.length === 2 ? resolve(G, 1, R, ctx, members) : G;
          if (G.length === 2) ord = ord.concat(without(G, ord));
          return chosen.concat(ord);
        }
        var steps = R.keepGoing ? R.multi : G.length === 2 ? R.two : R.multi, moved = false;
        for (var s = from; s < steps.length; s++) {
          var r = steps[s](G, ctx, members);
          if (!r) continue;
          if (r.adv != null) { chosen.push(r.adv); G = without(G, [r.adv]); k--; moved = true; from = 0; break; }
          if (r.out) { G = without(G, r.out); moved = true; from = R.keepGoing ? s : 0; break; }
          var best = Math.max.apply(null, r.v), top = G.filter(function (_, i) { return r.v[i] >= best - 1e-9; });
          if (top.length === G.length) continue;
          if (top.length <= k) {
            var o2 = top.length === 2 ? resolve(top, 1, R, ctx, members) : top;
            if (top.length === 2) o2 = o2.concat(without(top, o2));
            chosen = chosen.concat(o2); G = without(G, top); k -= top.length; from = 0;
          } else { G = top; from = R.keepGoing ? s + 1 : 0; }
          moved = true; break;
        }
        // Every step left them level (only possible without a coin step): keep the given order.
        if (!moved) return chosen.concat(G.slice(0, k));
      }
      return chosen;
    }
    // The teams level at the top of the standings. ACC: a team that played a different number of conference
    // games is level with the leaders if it has as many wins or as few losses as one of them.
    function topGroup(list, ctx, R) {
      var best = Math.max.apply(null, list.map(function (t) { return confPct(ctx, t); }));
      var lead = list.filter(function (t) { return Math.abs(confPct(ctx, t) - best) < 1e-9; });
      if (R.tied !== 'acc') return lead;
      return list.filter(function (t) {
        if (lead.indexOf(t) >= 0) return true;
        var gp = ctx.cw(t) + ctx.cl(t);
        return lead.some(function (b) { return ctx.cw(b) + ctx.cl(b) !== gp && (ctx.cw(b) === ctx.cw(t) || ctx.cl(b) === ctx.cl(t)); });
      });
    }
    // The best k of a set of teams by conference record, ties broken by the conference's procedure.
    function bestOf(list, k, R, ctx, members) {
      var chosen = [], left = list.slice();
      while (chosen.length < k && left.length) {
        var grp = topGroup(left, ctx, R), need = k - chosen.length;
        if (grp.length === 1) chosen.push(grp[0]);
        else chosen = chosen.concat(resolve(grp, Math.min(need, grp.length), R, ctx, members));
        left = without(left, chosen.concat(grp.length > need ? grp : []));
      }
      return chosen;
    }
    // The two title game teams, No. 1 seed first. divs: the Sun Belt's two divisions, each sending its champion.
    // conf: a conference key, or a rules object built from the steps (tests use this for past seasons' rules).
    function top2(conf, members, ctx, divs) {
      var R = typeof conf === 'object' ? conf : RULES[conf] || GENERIC;
      if (divs && divs.length === 2) {
        var a = bestOf(divs[0], 1, R, ctx, members)[0], b = bestOf(divs[1], 1, R, ctx, members)[0];
        var pa = confPct(ctx, a), pb = confPct(ctx, b);
        return pa > pb + 1e-9 ? [a, b] : pb > pa + 1e-9 ? [b, a] : resolve([a, b], 2, R, ctx, members);
      }
      // Most seasons need no tiebreaker: a lone leader and a lone second go straight through. (Not for the ACC
      // when schedules differ in length, where its own rule can tie teams of different percentages.)
      var b1 = -1, b2 = -1, t1 = -1, t2 = -1, n1 = 0, n2 = 0, gp = -1, even = true;
      for (var i = 0; i < members.length; i++) {
        var t = members[i], w = ctx.cw(t), l = ctx.cl(t), p = w + l ? w / (w + l) : 0;
        if (gp < 0) gp = w + l; else if (w + l !== gp) even = false;
        if (p > b1 + 1e-9) { b2 = b1; t2 = t1; n2 = n1; b1 = p; t1 = t; n1 = 1; }
        else if (p > b1 - 1e-9) n1++;
        else if (p > b2 + 1e-9) { b2 = p; t2 = t; n2 = 1; }
        else if (p > b2 - 1e-9) n2++;
      }
      if (n1 === 1 && n2 === 1 && (R.tied !== 'acc' || even)) return [t1, t2];
      // Two level for a spot who met: every conference's first step, head-to-head, settles it.
      if (n1 + n2 <= 3 && (n1 === 2 || n2 === 2) && (R.tied !== 'acc' || even) && !R.divs) {
        var pair = [], lead = n1 === 1 ? t1 : -1, pv = n1 === 2 ? b1 : b2;
        for (i = 0; i < members.length; i++) { var u = members[i], wu = ctx.cw(u), lu = ctx.cl(u); if (Math.abs((wu + lu ? wu / (wu + lu) : 0) - pv) < 1e-9) pair.push(u); }
        var x = pair[0], y = pair[1], hx = ctx.ch(x, y), hy = ctx.ch(y, x);
        if (pair.length === 2 && hx !== hy) { var win = hx > hy ? x : y, lose = win === x ? y : x; return lead >= 0 ? [lead, win] : [win, lose]; }
      }
      return bestOf(members, 2, R, ctx, members);
    }
    return { top2: top2, RULES: RULES, steps: { h2h: h2h, common: common, ordered: ordered, oppPct: oppPct, divRecord: divRecord, metric: metric, rating: rating, coin: coin, totalWins: totalWins, overall: overall, cfpThenMetric: cfpThenMetric, cfpRank: cfpRank } };
  })();

  // ---------- The table's week ----------
  // Which week the rankings table's week column shows: the latest week under way until every game in it is
  // over, then the next. Conference championship week has no games in ESPN's weekly list (title games are kept
  // apart), so it gets its own place: after the last regular week before the title games, while any title game
  // is unfinished. status(g) gives a game's state ('pre', 'in', 'post'); now is a time in ms.
  // Returns { wk, ccg }: ccg is true in championship week, when wk is that week's number.
  function tableWeek(games, titles, now, status) {
    status = status || function (g) { return g.s; };
    var weeks = [], wk = null, i;
    games.forEach(function (g) { if (g.wk != null && weeks.indexOf(g.wk) < 0) weeks.push(g.wk); });
    weeks.sort(function (a, b) { return a - b; });
    if (!weeks.length) return { wk: null, ccg: false };
    games.forEach(function (g) { if (g.wk != null && Date.parse(g.d) <= now && (wk == null || g.wk > wk)) wk = g.wk; });
    if (wk == null) wk = weeks[0];
    // Championship week: one past the last week played before the first title game.
    var ccgWk = null, pending = (titles || []).filter(function (t) { return !(t.w >= 0) && t.s !== 'post'; });
    if (titles && titles.length) {
      var first = Math.min.apply(null, titles.map(function (t) { return Date.parse(t.d); })), before = null;
      games.forEach(function (g) { if (g.wk != null && Date.parse(g.d) < first && (before == null || g.wk > before)) before = g.wk; });
      if (before != null) ccgWk = before + 1;
    }
    function over(w) {
      var list = games.filter(function (g) { return g.wk === w; });
      return list.length > 0 && list.every(function (g) { return status(g) === 'post'; });
    }
    if (!over(wk)) return { wk: wk, ccg: false };
    var later = weeks.filter(function (w) { return w > wk; });
    if (ccgWk != null && wk < ccgWk && pending.length && (!later.length || later[0] >= ccgWk)) return { wk: ccgWk, ccg: true };
    for (i = 0; i < later.length; i++) if (later[i] !== ccgWk || !pending.length) return { wk: later[i], ccg: false };
    return { wk: wk, ccg: false };
  }

  // ---------- Prepare one rating mode ----------
  // picks: { gameId: ESPN id of the team picked to win }
  function prep(D, mode, picks) {
    var T = D.teams, n = T.length, fbs = D.fbs, R = new Float64Array(n), hfa = D.sources.hfa[mode] || 2.5;
    var thru = D.sources.thru, used = mode === 'blend' ? ['massey', 'predictor'] : mode === 'all' ? D.sources.consensus : [mode];
    var total = Math.sqrt(M.gameSD * M.gameSD + 2 * M.teamSD * M.teamSD), i;
    for (i = 0; i < n; i++) R[i] = ratingFor(T[i], mode, D.sources);
    // Games finished after the ratings were published still move the rating.
    // Kickoffs are UTC, so shift back 8 hours to get the US calendar day the sources use.
    D.games.forEach(function (g) {
      if (g.s !== 'post' || g.hs === g.as) return; // a final with no result (postponed/cancelled at 0-0) isn't a game
      var day = new Date(Date.parse(g.d) - 288e5).toISOString().slice(0, 10);
      // The share of the models in use that haven't seen this result yet.
      var share = used.filter(function (k) { return day > thru[k]; }).length / used.length;
      if (!share) return;
      var p = phi((R[g.h] - R[g.a] + (g.n ? 0 : hfa)) / total), res = g.w === g.h ? 1 : 0;
      R[g.h] += share * M.surprise * (res - p); R[g.a] -= share * M.surprise * (res - p);
    });
    var W0 = new Int16Array(n), L0 = new Int16Array(n), CW0 = new Int16Array(n), CL0 = new Int16Array(n);
    var H0 = new Int8Array(n * n), CH0 = new Int8Array(n * n), fcsW0 = new Int16Array(n), sosSum = new Float64Array(n), sosN = new Int16Array(n);
    // Each team's last conference game of the regular season: its index among the games left, or -1 with
    // lastLost0 saying whether it was lost.
    var lastConfK = new Int32Array(n).fill(-1), lastLost0 = new Uint8Array(n);
    // A conference game for the standings. The Pac-12's week-13 "flex" games don't count (Sept 3, 2026 release).
    function inStandings(g) { return !!g.c && !(T[g.h].conf === 'pac12' && T[g.a].conf === 'pac12' && g.wk >= 13); }
    var maxPairs = D.games.length + 40, pw = new Int16Array(maxPairs), pl = new Int16Array(maxPairs), np = 0;
    var todoH = [], todoA = [], todoS = [], todoP = [], todoC = [], todoCur = [], todoF = [], todoLive = [], todoLock = [], nextGame = new Int32Array(n).fill(-1), remainCount = new Int16Array(n), gameIdx = [];
    D.games.forEach(function (g) {
      sosSum[g.h] += R[g.a]; sosN[g.h]++; sosSum[g.a] += R[g.h]; sosN[g.a]++;
      if (g.s === 'post' && g.hs !== g.as) {
        var w = g.hs > g.as ? g.h : g.a, l = w === g.h ? g.a : g.h;
        W0[w]++; L0[l]++;
        if (l >= fbs) fcsW0[w]++;
        if (inStandings(g)) { CW0[w]++; CL0[l]++; CH0[w * n + l]++; lastConfK[w] = -1; lastConfK[l] = -1; lastLost0[w] = 0; lastLost0[l] = 1; }
        H0[w * n + l]++; pw[np] = w; pl[np] = l; np++;
      } else {
        var k = todoH.length, sp = R[g.h] - R[g.a] + (g.n ? 0 : hfa);
        todoH.push(g.h); todoA.push(g.a); todoS.push(sp); todoP.push(phi(sp / total)); todoC.push(inStandings(g) ? 1 : 0); gameIdx.push(g.id);
        if (inStandings(g)) { lastConfK[g.h] = k; lastConfK[g.a] = k; }
        var f = g.s === 'in' ? g.frac : 1, cur = g.s === 'in' ? (g.hs - g.as) * (g.ot ? 0.5 : 1) : 0;
        todoCur.push(cur); todoF.push(f);
        var pk = picks ? picks[g.id] : null;
        todoLock.push(pk == null ? -1 : T[g.h].id === pk ? g.h : T[g.a].id === pk ? g.a : -1);
        todoLive.push(phi((cur + f * sp) / Math.sqrt(f * M.gameSD * M.gameSD + f * f * 2 * M.teamSD * M.teamSD)));
        if (nextGame[g.h] < 0) nextGame[g.h] = k;
        if (nextGame[g.a] < 0) nextGame[g.a] = k;
        remainCount[g.h]++; remainCount[g.a]++;
      }
    });
    var sos = new Float64Array(n), sosAll = 0, sosCt = 0;
    for (i = 0; i < n; i++) { sos[i] = sosN[i] ? sosSum[i] / sosN[i] : 0; if (i < fbs) { sosAll += sos[i]; sosCt++; } }
    var sosMean = sosAll / sosCt;

    // Conferences and title games
    var confs = {};
    for (i = 0; i < fbs; i++) { var c = T[i].conf; (confs[c] = confs[c] || []).push(i); }
    var titles = D.titles.filter(function (t) { return confs[t.conf]; }).map(function (t) {
      var divs = null;
      if (confs[t.conf].some(function (x) { return T[x].div; })) {
        var m = {};
        confs[t.conf].forEach(function (x) { (m[T[x].div] = m[T[x].div] || []).push(x); });
        divs = Object.keys(m).map(function (k) { return m[k]; });
      }
      // Title game picks, "ccg:<conf>:<team id>": 'W' wins the title game, or 'L' loses it, whenever it plays in it.
      var say = {};
      if (picks) confs[t.conf].forEach(function (x) { var v = picks['ccg:' + t.conf + ':' + T[x].id]; if (v === 'W' || v === 'L') say[x] = v; });
      return { conf: t.conf, members: confs[t.conf], divs: divs, n: t.n, h: t.h, a: t.a, w: t.w, s: t.s, say: say };
    });
    // The CFP ranking going into a team's final week, where the tiebreakers use it: the real ranking once only
    // that week is left (or none), else the simulated one.
    var rankFinal = new Int16Array(n).fill(-1);
    if (D.hasCfp) for (i = 0; i < fbs; i++) if (remainCount[i] <= 1) rankFinal[i] = T[i].rank || 0;
    var isP4 = new Uint8Array(n), isG6 = new Uint8Array(n), ND = -1;
    for (i = 0; i < fbs; i++) {
      isP4[i] = P4.indexOf(T[i].conf) >= 0 ? 1 : 0;
      isG6[i] = G6.indexOf(T[i].conf) >= 0 ? 1 : 0;
      if (T[i].ab === 'ND') ND = i;
    }
    var P = {
      D: D, mode: mode, n: n, fbs: fbs, R: R, hfa: hfa, total: total, W0: W0, L0: L0, CW0: CW0, CL0: CL0, H0: H0, sos: sos, sosMean: sosMean,
      pw: pw, pl: pl, np: np, tH: Int16Array.from(todoH), tA: Int16Array.from(todoA), tS: Float64Array.from(todoS), tP: Float64Array.from(todoP), tC: Uint8Array.from(todoC), tCur: Float64Array.from(todoCur), tF: Float64Array.from(todoF), tRootF: Float64Array.from(todoF.map(Math.sqrt)), tLive: Float64Array.from(todoLive), tLock: Int16Array.from(todoLock), gameIdx: gameIdx,
      nextGame: nextGame, remainCount: remainCount, titles: titles, CH0: CH0, fcsW0: fcsW0, lastConfK: lastConfK, lastLost0: lastLost0, rankFinal: rankFinal, isP4: isP4, isG6: isG6, ND: ND, anchor: new Float64Array(n)
    };
    computeAnchor(P);
    return P;
  }

  // Model score from a resume. Shared by the anchor fit and each simulation.
  var SCR = {};
  function scoreInto(P, S, post, L, tL, pw, pl, np, champ) {
    var fbs = P.fbs, n = P.n, i, q = SCR.q && SCR.q.length === fbs ? SCR.q : (SCR.q = new Float64Array(fbs));
    var qv = SCR.qv && SCR.qv.length === n ? SCR.qv : (SCR.qv = new Float64Array(n));
    for (i = 0; i < fbs; i++) { qv[i] = post[i] - 4 * L[i]; q[i] = qv[i]; }
    for (i = fbs; i < n; i++) qv[i] = -1e9;
    q.sort();
    var t10 = q[fbs - 10], t25 = q[fbs - 25], t60 = q[fbs - 60];
    for (i = 0; i < fbs; i++) {
      var effL = L[i] - (1 - M.wTitleLoss) * tL[i];
      S[i] = M.wRating * post[i] - M.wLoss * effL - (effL > 2 ? M.wLoss3 * (effL - 2) : 0) + M.wSos * (P.sos[i] - P.sosMean) + (P.isP4[i] ? 0 : (P.isG6[i] ? M.wG6 : 0));
      if (champ[i]) S[i] += P.isP4[i] ? M.wChampP4 : M.wChampG6;
    }
    for (i = 0; i < np; i++) {
      var w = pw[i], l = pl[i];
      if (w < fbs) { var qq = qv[l]; if (qq >= t10) S[w] += M.wTop10; else if (qq >= t25) S[w] += M.wTop25; }
      if (l < fbs) { if (qv[w] < t60) S[l] -= M.wBadLoss; else if (qv[w] >= t25) S[l] += M.wGoodLoss; }
    }
  }

  // How the selection committee moves a team from one of its rankings to the next, fit by least squares to
  // every week-to-week change in the committee's published rankings, 2014-2024 (R^2 0.935, ~1.9 spots). The
  // inputs are the team's current committee rank, whether it sat idle / won / lost since, the opponent's
  // standing, the margin and P4-vs-G5; cfp-proj-seed.mjs refits these from CollegeFootballData.
  var PROJ = { beta: [0.8126648621416821, 21.854257697463947, 2.396111173536939, 0.5459670818040321, 3.8869730617243725, -2.368691143056802, 0.2755670361959521, -0.7946946626118145] };
  // The next CFP ranking as we expect it: start from the committee's current ranking (our ratings place the
  // unranked just outside it), then move each team by that fitted formula from the game its next ranking turns
  // on — this week's game, taken as its real result if final, else the projected one (the favourite by our
  // ratings wins). Teams off this week barely move. Returns ranks (1 = first) for FBS teams, the number of
  // finals since the last ranking, or null without a ranking.
  function projectRanking(P) {
    var D = P.D, T = D.teams, n = P.n, fbs = P.fbs, b = PROJ.beta, i;
    if (!D.rankDate) return null;
    // Each team's game in the week after the current ranking (final or still to play), the one the next ranking
    // reacts to. The window runs from the ranking to about a week on, so it catches this weekend's slate.
    var rd = Date.parse(D.rankDate), cutoff = rd + 8 * 864e5, rel = new Array(n), since = 0;
    D.games.forEach(function (g) {
      var t = Date.parse(g.d);
      if (isNaN(t) || t < rd || t >= cutoff) return;
      if (g.s === 'post' && g.hs !== g.as && (g.h < fbs || g.a < fbs)) since++;
      if (g.h < fbs && (!rel[g.h] || t > rel[g.h].t)) rel[g.h] = { t: t, g: g, home: 1, opp: g.a };
      if (g.a < fbs && (!rel[g.a] || t > rel[g.a].t)) rel[g.a] = { t: t, g: g, home: 0, opp: g.h };
    });
    // A "current rank" for everyone: the committee's for ranked teams, else just outside it by our ratings.
    var unranked = [];
    for (i = 0; i < fbs; i++) if (!T[i].rank) unranked.push(i);
    unranked.sort(function (a, c) { return P.R[c] - P.R[a]; });
    var cur = new Float64Array(n);
    for (i = 0; i < fbs; i++) cur[i] = T[i].rank || 0;
    unranked.forEach(function (t, k) { cur[t] = 26 + k; });
    var pred = new Float64Array(n);
    for (i = 0; i < fbs; i++) {
      var r = rel[i], lost = 0, idle = r ? 0 : 1, lossOpp = 0, winOpp = 0, margin = 0;
      if (r) {
        var g = r.g, oppRank = T[r.opp].rank || 26, won;
        if (g.s === 'post' && g.hs !== g.as) {
          var mine = r.home ? g.hs : g.as, them = r.home ? g.as : g.hs;
          won = mine > them; margin = Math.max(-28, Math.min(28, mine - them)) / 28;
        } else {
          // Projected result: the favourite by our ratings, with the rating gap as the expected margin.
          var em = P.R[i] - P.R[r.opp] + (g.n ? 0 : (r.home ? P.hfa : -P.hfa));
          won = em >= 0; margin = Math.max(-28, Math.min(28, em)) / 28;
        }
        if (won) winOpp = oppRank <= 25 ? (26 - oppRank) / 25 : 0; else { lost = 1; lossOpp = oppRank / 26; }
      }
      pred[i] = b[0] + b[1] * (cur[i] / 25) + b[2] * lost + b[3] * idle + b[4] * lossOpp + b[5] * winOpp + b[6] * (P.isG6[i] ? 1 : 0) + b[7] * margin;
    }
    var order = [];
    for (i = 0; i < fbs; i++) order.push(i);
    // Lower predicted number = higher rank; ties break by our rating.
    order.sort(function (a, c) { return pred[a] - pred[c] || P.R[c] - P.R[a]; });
    var rank = new Int16Array(n);
    order.forEach(function (t, k) { rank[t] = k + 1; });
    return { rank: rank, since: since };
  }

  // Compare the model with the committee's latest ranking and carry part of the difference forward.
  function computeAnchor(P) {
    var D = P.D, T = D.teams, n = P.n, fbs = P.fbs, i;
    if (!D.rankDate) return;
    var L = new Int16Array(n), tL = new Int16Array(n), champ = new Uint8Array(n), pw = new Int16Array(P.pw.length), pl = new Int16Array(P.pw.length), np = 0;
    D.games.forEach(function (g) {
      if (g.s !== 'post' || g.d >= D.rankDate) return;
      var w = g.w, l = w === g.h ? g.a : g.h;
      L[l]++; pw[np] = w; pl[np] = l; np++;
    });
    var S = new Float64Array(n);
    scoreInto(P, S, P.R, L, tL, pw, pl, np, champ);
    var sorted = Array.prototype.slice.call(S.subarray(0, fbs)).sort(function (a, b) { return b - a; });
    P.scoreNow = S;
    for (i = 0; i < fbs; i++) {
      if (T[i].rank) P.anchor[i] = sorted[T[i].rank - 1] - S[i];
      else P.anchor[i] = Math.min(0, sorted[25] - S[i]);
    }
  }

  // ---------- Simulator ----------
  function Sim(P, seed) {
    var n = P.n, fbs = P.fbs, m = P.tH.length;
    this.P = P;
    this.s = (seed >>> 0) || 88172645;
    this.G = gaussTable();
    this.eps = new Float64Array(n); this.post = new Float64Array(n); this.score = new Float64Array(n);
    this.L = new Int16Array(n); this.W = new Int16Array(n); this.CW = new Int16Array(n); this.CL = new Int16Array(n); this.tL = new Int16Array(n);
    this.H = new Int8Array(n * n); this.champ = new Uint8Array(n);
    this.pw = new Int16Array(P.pw); this.pl = new Int16Array(P.pl);
    this.res = new Int16Array(m); this.order = new Int16Array(fbs); this.seeds = new Int16Array(12);
    this.titleWin = new Int16Array(P.titles.length); this.inTitle = new Uint8Array(n);
    this.titleLoss = new Int16Array(n);
    this.orderArr = []; for (var i = 0; i < fbs; i++) this.orderArr.push(i);
    this.CH = new Int8Array(n * n); this.Wr = new Int16Array(n); this.fcsW = new Int16Array(n);
    this.npNow = 0; this.mAll = new Float64Array(fbs); this.mRun = -1; this.runNo = 0;
    var self = this;
    // What the conference tiebreakers read. metric stands in for SportSource and the computer-ranking
    // composites: the committee score's core (rating after this season's results, losses, schedule strength)
    // without the quality-win terms, so it needs no sort and costs nothing until a tie reaches it.
    function metricOf(t) {
      var L = self.L[t];
      return M.wRating * self.post[t] - M.wLoss * L - (L > 2 ? M.wLoss3 * (L - 2) : 0) + M.wSos * (P.sos[t] - P.sosMean);
    }
    this.ctx = {
      cw: function (t) { return self.CW[t]; }, cl: function (t) { return self.CL[t]; },
      ch: function (a, b) { return self.CH[a * n + b]; },
      w: function (t) { return self.Wr[t]; }, l: function (t) { return self.L[t]; }, fcsW: function (t) { return self.fcsW[t]; },
      metric: metricOf,
      rating: function (t) { return self.post[t] + self.eps[t]; },
      rank: function (t) {
        if (P.rankFinal[t] >= 0) return P.rankFinal[t];
        if (t >= fbs) return 0;
        // The simulated ranking: one plus the FBS teams with a better metric, unranked past 25.
        var all = self.mAll, k;
        if (self.mRun !== self.runNo) { for (k = 0; k < fbs; k++) all[k] = metricOf(k); self.mRun = self.runNo; }
        var m = all[t], above = 0;
        for (k = 0; k < fbs && above < 25; k++) if (all[k] > m) above++;
        return above < 25 ? above + 1 : 0;
      },
      lostFinal: function (t) { var k = P.lastConfK[t]; return k >= 0 ? self.res[k] !== t : P.lastLost0[t] === 1; },
      div: function (t) { return P.D.teams[t].div || ''; },
      rand: function () { return self.u(); }
    };
  }
  // A uniform draw in [0, 1), from the same generator.
  Sim.prototype.u = function () {
    var x = this.s; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.s = x;
    return (x >>> 0) / 4294967296;
  };
  Sim.prototype.g = function () {
    var x = this.s; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.s = x;
    return this.G[(x >>> 8) & 65535];
  };

  // Picked games always go to the picked team. forced: team that must win its next game, or -1.
  Sim.prototype.run = function (forced) {
    var P = this.P, n = P.n, fbs = P.fbs, m = P.tH.length, i, eps = this.eps, post = this.post, L = this.L, CW = this.CW, CL = this.CL, H = this.H, R = P.R;
    for (i = 0; i < n; i++) { eps[i] = P.R[i] === 0 ? 0 : this.g() * M.teamSD; post[i] = R[i]; }
    L.set(P.L0); CW.set(P.CW0); CL.set(P.CL0); H.set(P.H0);
    var CH = this.CH, Wr = this.Wr, fcsW = this.fcsW;
    // Only the pairs with conference games still to play change during a season, so only they are reset.
    if (!this.chInit) { CH.set(P.CH0); this.chInit = true; }
    else for (i = 0; i < m; i++) if (P.tC[i]) { var hh = P.tH[i], aa = P.tA[i]; CH[hh * n + aa] = P.CH0[hh * n + aa]; CH[aa * n + hh] = P.CH0[aa * n + hh]; }
    Wr.set(P.W0); fcsW.set(P.fcsW0); this.runNo++;
    this.tL.fill(0); this.champ.fill(0);
    var np = P.np, pw = this.pw, pl = this.pl, nextOfForced = forced >= 0 ? P.nextGame[forced] : -1;
    for (var k = 0; k < m; k++) {
      // Every game takes its random draw, even when a pick decides it. That keeps the rest of the season on
      // the same random numbers, so a pick only changes the seasons it affects (common random numbers).
      var h = P.tH[k], a = P.tA[k], w, z = this.g();
      if (P.tLock[k] >= 0) {
        w = P.tLock[k];
      } else if (k === nextOfForced) {
        w = forced;
      } else {
        w = P.tCur[k] + P.tF[k] * (P.tS[k] + eps[h] - eps[a]) + P.tRootF[k] * z * M.gameSD > 0 ? h : a;
      }
      var l = w === h ? a : h;
      this.res[k] = w;
      L[l]++; H[w * n + l]++; Wr[w]++;
      if (l >= fbs) fcsW[w]++;
      if (P.tC[k]) { CW[w]++; CL[l]++; CH[w * n + l]++; }
      pw[np] = w; pl[np] = l; np++;
      var sur = M.surprise * ((w === h ? 1 : 0) - P.tP[k]);
      post[h] += sur; post[a] -= sur;
    }
    // Conference title games
    var champs = this.champ, g6Champs = [], inT = this.inTitle;
    inT.fill(0);
    this.npNow = np;
    for (i = 0; i < P.titles.length; i++) {
      var tg = P.titles[i], x, y, wt;
      if (tg.h >= 0 && tg.a >= 0) { x = tg.h; y = tg.a; }
      else { var two = TB.top2(tg.conf, tg.members, this.ctx, tg.divs); x = two[0]; y = two[1]; } // x: the No. 1 seed
      inT[x] = 1; inT[y] = 1;
      if (tg.w >= 0) wt = tg.w;
      else {
        // Non-neutral title games are hosted by the No. 1 seed (the home team once the matchup is set).
        var xh = tg.n ? 0 : P.hfa;
        var spr = R[x] - R[y] + xh;
        wt = spr + eps[x] - eps[y] + this.g() * M.gameSD > 0 ? x : y;
        // A pick decides it; two picks that contradict each other (both win, or both lose) leave it to the game.
        var sx = tg.say[x], sy = tg.say[y];
        if (sx !== sy) wt = sx === 'W' || sy === 'L' ? x : y;
        var pe = phi(spr / P.total), sr = M.surprise * ((wt === x ? 1 : 0) - pe);
        post[x] += sr; post[y] -= sr;
        var lt = wt === x ? y : x;
        L[lt]++; this.tL[lt]++; H[wt * n + lt]++;
        pw[np] = wt; pl[np] = lt; np++;
      }
      champs[wt] = 1;
      this.titleWin[i] = wt;
      if (P.isG6[wt]) g6Champs.push(wt);
    }
    // Committee ranking
    var S = this.score;
    scoreInto(P, S, post, L, this.tL, pw, pl, np, champs);
    for (i = 0; i < fbs; i++) S[i] += M.wAnchor * P.anchor[i] + this.g() * M.committeeSD;
    var ord = this.orderArr;
    ord.sort(function (p, q) { return S[q] - S[p]; });
    for (i = 0; i < 18; i++) {
      var hi = ord[i], lo = ord[i + 1];
      if (H[lo * n + hi] > H[hi * n + lo] && S[hi] - S[lo] < M.h2hWindow) { ord[i] = lo; ord[i + 1] = hi; }
    }
    // Field: P4 champions, best other champion, Notre Dame if top 12, then at-large by rank. Seeds follow the ranking.
    var rankOf = this.rankOf || (this.rankOf = new Int16Array(n));
    rankOf.fill(999);
    for (i = 0; i < fbs; i++) rankOf[ord[i]] = i;
    var aq = this.aq || (this.aq = new Uint8Array(n));
    aq.fill(0);
    var nAq = 0;
    for (i = 0; i < P.titles.length; i++) {
      var ch = this.titleWin[i];
      if (P.isP4[ch] && !aq[ch]) { aq[ch] = 1; nAq++; }
    }
    if (g6Champs.length) {
      var bestG = g6Champs[0];
      for (i = 1; i < g6Champs.length; i++) if (rankOf[g6Champs[i]] < rankOf[bestG]) bestG = g6Champs[i];
      if (!aq[bestG]) { aq[bestG] = 1; nAq++; }
    }
    if (P.ND >= 0 && rankOf[P.ND] < 12 && !aq[P.ND]) { aq[P.ND] = 1; nAq++; }
    var open = 12 - nAq, sd = this.seeds, sc = 0;
    for (i = 0; i < fbs && sc < 12; i++) {
      var t = ord[i];
      if (aq[t]) sd[sc++] = t;
      else if (open > 0) { sd[sc++] = t; open--; }
    }
    this.aqFlags = aq;
    return sd;
  };

  // Plays the bracket: 5v12, 8v9, 6v11, 7v10; then 1,4,2,3 enter. No reseeding.
  Sim.prototype.bracket = function () {
    var P = this.P, sd = this.seeds, R = P.R, e = this.eps, self = this;
    function pick(a, b, home) { return R[a] - R[b] + e[a] - e[b] + (home ? P.hfa : 0) + self.g() * M.gameSD > 0 ? a : b; }
    var a512 = pick(sd[4], sd[11], 1), a89 = pick(sd[7], sd[8], 1), a611 = pick(sd[5], sd[10], 1), a710 = pick(sd[6], sd[9], 1);
    var q1 = pick(sd[0], a89, 0), q4 = pick(sd[3], a512, 0), q2 = pick(sd[1], a710, 0), q3 = pick(sd[2], a611, 0);
    return pick(pick(q1, q4, 0), pick(q2, q3, 0), 0);
  };

  // ---------- Runs ----------
  function emptyTally(n) {
    return {
      sims: 0, cfp: new Int32Array(n), bye: new Int32Array(n), host: new Int32Array(n), aq: new Int32Array(n), champ: new Int32Array(n), ccg: new Int32Array(n),
      title: new Int32Array(n), seedSum: new Float64Array(n), seedHist: new Int32Array(n * 12), nextW: new Int32Array(n), cfpNextW: new Int32Array(n)
    };
  }
  function baseBatch(sim, tally, count) {
    var P = sim.P, n = P.n, inField = sim.inField || (sim.inField = new Uint8Array(n)), res = sim.res, i, t, c;
    for (c = 0; c < count; c++) {
      var sd = sim.run(-1);
      inField.fill(0);
      tally.sims++;
      for (i = 0; i < 12; i++) {
        t = sd[i]; inField[t] = 1;
        tally.cfp[t]++; tally.seedSum[t] += i + 1; tally.seedHist[t * 12 + i]++;
        if (i < 4) tally.bye[t]++; else if (i < 8) tally.host[t]++;
        if (sim.aqFlags[t]) tally.aq[t]++;
      }
      for (i = 0; i < P.titles.length; i++) tally.champ[sim.titleWin[i]]++;
      for (t = 0; t < n; t++) {
        if (sim.inTitle[t]) tally.ccg[t]++;
        var ng = P.nextGame[t];
        if (ng >= 0 && res[ng] === t) { tally.nextW[t]++; if (inField[t]) tally.cfpNextW[t]++; }
      }
      tally.title[sim.bracket()]++;
    }
  }
  // Teams a filtered sample cannot answer get their own forced runs.
  function forcedJobs(P, tally, minSample) {
    var jobs = [], T = P.D.teams;
    for (var t = 0; t < P.fbs; t++) {
      if (P.L0[t] > (P.isG6[t] ? 5 : 4)) continue;
      var ng = P.nextGame[t];
      if (ng >= 0 && P.tLock[ng] < 0 && tally.nextW[t] < minSample) jobs.push({ t: t });
    }
    jobs.sort(function (a, b) { return (T[a.t].rank || 99) - (T[b.t].rank || 99); });
    return jobs;
  }
  function forcedRun(sim, job, count) {
    var hits = 0, c, i;
    for (c = 0; c < count; c++) {
      var sd = sim.run(job.t);
      for (i = 0; i < 12; i++) if (sd[i] === job.t) { hits++; break; }
    }
    return hits / count;
  }
  function summarize(P, tally, forced, minSample) {
    var out = [], N = tally.sims, T = P.D.teams;
    for (var t = 0; t < P.fbs; t++) {
      var ng = P.nextGame[t], nw = tally.nextW[t], f = forced[t], hist = [];
      for (var i = 0; i < 12; i++) hist.push(tally.seedHist[t * 12 + i]);
      var nl = N - nw;
      out.push({
        cfp: tally.cfp[t] / N, bye: tally.bye[t] / N, host: tally.host[t] / N, aq: tally.aq[t] / N, champ: tally.champ[t] / N, ccg: tally.ccg[t] / N, title: tally.title[t] / N,
        seed: tally.cfp[t] ? tally.seedSum[t] / tally.cfp[t] : null, hist: hist,
        pNext: ng >= 0 ? nw / N : null,
        ifNext: ng < 0 ? null : nw >= minSample ? tally.cfpNextW[t] / nw : f != null ? f : 0,
        ifLose: ng < 0 ? null : nl >= 200 ? (tally.cfp[t] - tally.cfpNextW[t]) / nl : null,
        forcedNext: nw < minSample && f != null
      });
      void T;
    }
    return out;
  }
  function nextGames(P) {
    // Per team: remaining opponents, site and win probability, in date order.
    var out = [];
    for (var t = 0; t < P.fbs; t++) out.push([]);
    for (var k = 0; k < P.tH.length; k++) {
      var h = P.tH[k], a = P.tA[k], g = P.tLive[k];
      var neutral = P.D.games.filter(function (x) { return x.id === P.gameIdx[k]; })[0];
      if (h < P.fbs) out[h].push({ o: a, home: neutral.n ? 0 : 1, p: g, id: neutral.id, s: neutral.s, d: neutral.d, us: neutral.hs, them: neutral.as, st: neutral.st });
      if (a < P.fbs) out[a].push({ o: h, home: neutral.n ? 0 : -1, p: 1 - g, id: neutral.id, s: neutral.s, d: neutral.d, us: neutral.as, them: neutral.hs, st: neutral.st });
    }
    return out;
  }
  // One fixed seed per ratings model, shared by the build and the page, so every run with the same data uses
  // the same random numbers. Picks and live updates then move only the odds they actually affect.
  function seedFor(mode) {
    var h = 2166136261;
    for (var i = 0; i < mode.length; i++) { h ^= mode.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) || 1;
  }
  function runAll(D, mode, sims, seed, forcedN, picks) {
    var P = prep(D, mode, picks), sim = new Sim(P, seed), tally = emptyTally(P.n), minSample = 800;
    baseBatch(sim, tally, sims);
    var jobs = forcedJobs(P, tally, minSample), forced = {};
    jobs.forEach(function (j) {
      forced[j.t] = forcedRun(sim, j, forcedN);
    });
    return { sims: sims, mode: mode, teams: summarize(P, tally, forced, minSample), schedule: nextGames(P), rating: Array.prototype.slice.call(P.R.subarray(0, P.fbs)) };
  }

  return {
    M: M, P4: P4, G6: G6, CONF_NAME: CONF_NAME, CONF_ABBR: CONF_ABBR, parseEspn: parseEspn, applyFpi: applyFpi, seedFor: seedFor, prep: prep, projectRanking: projectRanking, Sim: Sim, emptyTally: emptyTally, baseBatch: baseBatch,
    forcedJobs: forcedJobs, forcedRun: forcedRun, summarize: summarize, nextGames: nextGames, runAll: runAll, phi: phi, ratingFor: ratingFor, withCfp: withCfp, measureSwings: measureSwings, TB: TB, tableWeek: tableWeek
  };
})();
if (typeof module !== 'undefined') module.exports = CFP;
