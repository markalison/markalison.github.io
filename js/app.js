// Odds and Scoreboard views: simulation runs, live ESPN updates and rendering.
(function () {
  'use strict';
  // data.js sets CFP_DATA: teams, games, ratings and the default simulation.
  var embedded = window.CFP_DATA;
  // 40,000 seasons gives about +/-0.5 points at 50% odds in roughly a second. More adds wait for little precision.
  var SIMS = 40000;
  var D = embedded.D, results = embedded.results, simsNote = {};
  var st = { mode: 'blend', picks: {}, bkPicks: {}, sort: 'team', dir: 1, team: null, conf: '', view: 'all', q: '', live: 'pending', running: false };
  var schedCache = {}, worker = null;
  var $ = function (id) { return document.getElementById(id); };
  // Preload the scoreboard in its live order. The last live game state is cached per build, so a reload paints
  // straight into the final order (live games grouped, scores in) instead of showing the build's older state and
  // then visibly reshuffling a couple of seconds later when the ESPN refresh lands. The background refresh still
  // runs and corrects the odds in place. Cache is tied to the build version and the build's own freshness, so a
  // newer build always wins and a stale cache is ignored.
  var SB_KEY = 'cfb.live';
  function sbVer() { var s = (document.querySelector('script[src*="js/app.js"]') || {}).src || ''; return (s.split('?v=')[1] || '').replace(/[^a-z0-9]/gi, '') || String(D.asOf || ''); }
  function saveLive() {
    try {
      localStorage.setItem(SB_KEY, JSON.stringify({
        v: sbVer(), season: D.season, at: Date.now(),
        g: D.games.filter(function (g) { return g.s !== 'pre'; }).map(function (g) { return [g.id, g.s, g.hs, g.as, g.clock || '', g.d]; })
      }));
    } catch (e) {}
  }
  function loadLive() {
    try {
      var c = JSON.parse(localStorage.getItem(SB_KEY) || 'null');
      if (!c || c.v !== sbVer() || c.season !== D.season) return;
      if (D.asOf && c.at < Date.parse(D.asOf)) return;   // the build is newer than this cache
      if (Date.now() - c.at > 6 * 3600000) return;        // too old to trust a live status
      var m = {}; D.games.forEach(function (g) { m[g.id] = g; });
      c.g.forEach(function (x) { var g = m[x[0]]; if (!g) return; g.s = x[1]; g.hs = x[2]; g.as = x[3]; g.clock = x[4]; if (x[5]) g.d = x[5]; });
    } catch (e) {}
  }
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  function isDark() { return /dark/.test(getComputedStyle(document.documentElement).colorScheme); }
  // ESPN's logo CDN. If an image fails, the error listener below swaps in a team-color dot.
  function logo(t, px) {
    var color = t.color ? '#' + t.color : 'var(--muted)', size = px * 3;
    return '<img class="logo" alt="" width="' + px + '" height="' + px + '" data-color="' + esc(color) + '" src="https://a.espncdn.com/combiner/i?img=/i/teamlogos/ncaa/' + (isDark() ? '500-dark' : '500') + '/' + encodeURIComponent(t.id) + '.png&amp;h=' + size + '&amp;w=' + size + '">';
  }
  // A conference's logo, from the same CDN: ESPN's id for the conference, then its mark's width over its height.
  // The files are square with the mark in the middle, so each is cropped to its mark's shape (--r) and drawn at
  // the height its place on the page sets (--lh in styles.css), a very wide wordmark a little shorter. C-USA and
  // the Sun Belt have no version for dark backgrounds: the Sun Belt's works on both, and C-USA's navy wordmark
  // is shown in white there. Independents have no conference. A logo that fails to load is dropped.
  var CONF_LOGO = { american: [151, 0.92], acc: [1, 3.34], big12: [4, 1.68], big10: [5, 2.6], usa: [12, 4.66], midam: [15, 1.09], mwest: [17, 0.96], pac12: [9, 0.77], sec: [8, 1], belt: [37, 2.03] };
  var CONF_LOGO_LIGHT_ONLY = { usa: ' conf-logo-white', belt: '' };
  function confLogo(conf) {
    var c = CONF_LOGO[conf], only = CONF_LOGO_LIGHT_ONLY[conf], dark = isDark();
    if (!c) return '';
    return '<img class="conf-logo' + (dark && only ? only : '') + '" alt="" style="--r:' + c[1] + '" src="https://a.espncdn.com/combiner/i?img=/i/teamlogos/ncaa_conf/' + (dark && only == null ? '500-dark' : '500') + '/' + c[0] + '.png&amp;h=132&amp;w=132">';
  }
  document.addEventListener('error', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'IMG') return;
    if (el.classList.contains('conf-logo')) { el.remove(); return; }
    if (!el.classList.contains('logo')) return;
    var dot = document.createElement('span');
    dot.className = 'chip logo';
    dot.style.background = el.dataset.color;
    el.replaceWith(dot);
  }, true);

  function pct(v, sims) {
    if (v == null) return '—';
    if (v <= 0.0005) return '<0.1%';
    if (v >= 0.9995) return '>99.9%';
    return (v * 100).toFixed(v >= 0.1 && v < 0.9 ? 0 : 1) + '%';
    void sims;
  }
  var pickResults = {}, lastRes = results[st.mode], jobId = 0, pickTimer = null;
  function hasPicks() { return Object.keys(st.picks).length > 0; }
  function picksKey() {
    return st.mode + JSON.stringify(Object.keys(st.picks).sort().map(function (k) { return [k, st.picks[k]]; }));
  }
  // While a new run is in progress, the last finished results stay on screen.
  function res() {
    var r = hasPicks() ? pickResults[picksKey()] : results[st.mode];
    if (r) lastRes = r;
    return lastRes;
  }
  function schedule() {
    if (!schedCache[st.mode]) schedCache[st.mode] = CFP.nextGames(CFP.prep(D, st.mode));
    return schedCache[st.mode];
  }
  function record(i) {
    var w = 0, l = 0, cw = 0, cl = 0;
    D.games.forEach(function (g) {
      if (g.s !== 'post' || (g.h !== i && g.a !== i)) return;
      // Decide from the final score, not the winner field: a game ESPN marks final with no score (a postponed
      // or cancelled game left at 0-0) must not count as a loss.
      var mine = g.h === i ? g.hs : g.as, opp = g.h === i ? g.as : g.hs;
      if (mine == null || opp == null || mine === opp) return;
      var won = mine > opp;
      if (won) w++; else l++;
      if (g.c) { if (won) cw++; else cl++; }
    });
    return { w: w, l: l, cw: cw, cl: cl, text: w + '-' + l };
  }
  var projCache = { D: null, by: {} };
  function projected() {
    if (projCache.D !== D) projCache = { D: D, by: {} };
    if (!projCache.by[st.mode]) projCache.by[st.mode] = CFP.projectRanking(CFP.prep(D, st.mode)) || { rank: [], since: 0 };
    return projCache.by[st.mode];
  }
  function buildRows() {
    var proj = projected();
    var R = res(), sc = schedule(), rows = [];
    // Each team's place among all FBS teams in the selected model's ratings, 1 = highest.
    var order = R.rating.map(function (v, i) { return i; }).sort(function (a, b) { return R.rating[b] - R.rating[a]; });
    var modelRank = []; order.forEach(function (i, n) { modelRank[i] = n + 1; });
    for (var i = 0; i < D.fbs; i++) {
      var t = D.teams[i], r = R.teams[i], next = sc[i][0] || null;
      rows.push({ i: i, t: t, r: r, proj: proj.rank[i] || null, rec: record(i), index: CFP.ratingFor(t, st.mode, D.sources), next: next, rating: R.rating[i], modelRank: modelRank[i], base: results[st.mode] && results[st.mode].teams[i] });
    }
    return rows;
  }
  var COLS = {
    team: function (x) { return x.t.rank || 200 - x.r.cfp; }, proj: function (x) { return x.proj && x.proj <= 25 ? x.proj : 200 - x.r.cfp; }, rating: function (x) { return x.modelRank; }, next: function (x) { return x.r.pNext == null ? -1 : x.r.pNext; },
    cfp: function (x) { return x.r.cfp; }, bye: function (x) { return x.r.bye; }, champ: function (x) { return x.r.champ; },
    seed: function (x) { return x.r.seed == null ? 99 : x.r.seed; }, title: function (x) { return x.r.title; },
    rec: function (x) { var n = x.rec.w + x.rec.l; return (n ? x.rec.w / n : 0) + x.rec.w / 1000; }, index: function (x) { return x.index; }
  };
  // Notre Dame sits with the power conferences and UConn with the Group of 6.
  // Power 4 includes Notre Dame; Group of 6 is everyone else, UConn included.
  function inGroup(t, group) {
    if (!group || group === 'all') return true;
    var power = CFP.P4.indexOf(t.conf) >= 0 || t.ab === 'ND';
    return group === 'p4' ? power : !power;
  }
  function inView(t) { return inGroup(t, st.view); }
  var GROUP_NAME = { p4: 'Power 4', g5: 'Group of 6' };
  // The Conference pickers (Rankings and Scores): the team groups first, then each conference. Groups are
  // stored as "group:p4". Each picker is a button showing the choice and, when open, a list in which the
  // conferences carry their logos, which a plain <select> can't show. st.pickOpen is the id of the open one.
  function confPicker(id, selected, open) {
    var confs = {}, cur = ['', 'FBS'];
    for (var i = 0; i < D.fbs; i++) confs[D.teams[i].conf] = 1;
    function option(v, label) {
      if (v === selected) cur = [v, label];
      return '<button type="button" role="option" class="pick-opt" data-pick-value="' + v + '" aria-selected="' + (v === selected) + '"><span class="pick-logo">' + confLogo(v) + '</span>' + esc(label) + '</button>';
    }
    function group(label, options) { return '<div role="group" aria-label="' + label + '"><span class="pick-head" aria-hidden="true">' + label + '</span>' + options + '</div>'; }
    var list = group('Teams', option('', 'FBS') + option('group:p4', 'Power 4') + option('group:g5', 'Group of 6')) +
      group('Conferences', Object.keys(confs).sort(function (a, b) { return (CFP.CONF_NAME[a] || a) < (CFP.CONF_NAME[b] || b) ? -1 : 1; }).map(function (c) { return option(c, CFP.CONF_NAME[c] || c); }).join(''));
    return '<button type="button" class="pick-btn" data-picker="' + id + '" aria-haspopup="listbox" aria-expanded="' + !!open + '" aria-label="Conference: ' + esc(cur[1]) + '">' + confLogo(cur[0]) + '<span>' + esc(cur[1]) + '</span></button>' +
      '<div class="pick-list" role="listbox" aria-label="Conference"' + (open ? '' : ' hidden') + '>' + list + '</div>';
  }
  // The list opens from the button's left edge, or from its right edge when that would run off the screen (the
  // Scores page's picker sits at the right on wide screens). It is as tall as the room under the button allows,
  // and scrolls if that isn't enough for every choice.
  function drawPicker(id, selected) {
    var el = $(id), open = st.pickOpen === id;
    el.innerHTML = confPicker(id, selected, open);
    if (!open) return;
    var list = el.querySelector('.pick-list'), box = list.getBoundingClientRect();
    if (box.right > document.documentElement.clientWidth - 8) list.classList.add('pick-end');
    list.style.maxHeight = Math.max(180, window.innerHeight - box.top - 12) + 'px';
  }
  function renderScoreboardControls() { drawPicker('sb-conf', st.sbConf || ''); }
  function renderViewControls() { drawPicker('conf', st.view !== 'all' ? 'group:' + st.view : st.conf); }
  // Opening a picker closes the other one and puts the keyboard on the current choice. Closing one can hand the
  // keyboard back to its button.
  function openPicker(id) {
    st.pickOpen = id;
    renderViewControls();
    renderScoreboardControls();
    var on = $(id).querySelector('[aria-selected="true"]') || $(id).querySelector('.pick-opt');
    if (on) on.focus();
  }
  function closePicker(refocus) {
    var id = st.pickOpen;
    if (!id) return;
    st.pickOpen = null;
    renderViewControls();
    renderScoreboardControls();
    if (refocus) $(id).querySelector('.pick-btn').focus();
  }
  function visible(rows) {
    var q = st.q.trim().toLowerCase();
    var out = rows.filter(function (x) {
      if (!inView(x.t)) return false;
      if (st.conf && x.t.conf !== st.conf) return false;
      return !q || (x.t.full + ' ' + x.t.ab).toLowerCase().indexOf(q) >= 0;
    });
    // After a W/L pick the rows keep the order they had, so the team just picked doesn't jump away.
    if (st.lockOrder) {
      var pos = st.lockOrder;
      out.sort(function (a, b) { return (pos[a.t.id] == null ? 1e4 : pos[a.t.id]) - (pos[b.t.id] == null ? 1e4 : pos[b.t.id]); });
      return out;
    }
    return sortRows(out);
  }
  function sortRows(rows) {
    if (st.sort === 'conf') {
      var name = function (x) { return CFP.CONF_NAME[x.t.conf] || x.t.conf; };
      return rows.sort(function (a, b) { return st.dir * name(a).localeCompare(name(b)) || b.r.cfp - a.r.cfp; });
    }
    var f = COLS[st.sort], d = st.dir;
    return rows.sort(function (a, b) { return d * (f(a) - f(b)) || b.r.cfp - a.r.cfp; });
  }
  // Remembers the current order of every team. Cleared by sorting, changing ratings or clearing picks.
  function lockOrder() {
    if (st.lockOrder) return;
    st.lockOrder = {};
    sortRows(buildRows()).forEach(function (x, i) { st.lockOrder[x.t.id] = i; });
  }
  function head() {
    function th(key, label, cls) {
      var s = st.sort === key ? (st.dir < 0 ? 'descending' : 'ascending') : 'none';
      return '<th class="' + (cls || '') + '" aria-sort="' + s + '"><button type="button" data-sort="' + key + '">' + label + '</button>';
    }
    // Fixed column widths live on these header classes. Columns marked sec are hidden on phones.
    $('head').innerHTML =
      th('team', '<abbr title="College Football Playoff committee ranking">CFP</abbr>', 'first c-rk') + '</th>' +
      th('proj', '<abbr title="Projected CFP ranking for the next release, from every result so far">Proj.</abbr>', 'c-prk tc') + '</th>' +
      '<th class="l c-team team-col">Team</th>' +
      th('conf', 'Conf.', 'l c-cn') + '</th>' +
      th('rec', 'Rec', 'c-rec') + '</th>' +
      th('index', '<abbr title="' + esc(modeName()) + ' rating as last published">Index</abbr>', 'c-idx tc') + '</th>' +
      (weekInfo().ccg ? '<th class="pick c-pick" title="Conference championship games: pick a team to win its title game if it gets there">CCG</th>' :
        '<th class="pick c-pick" title="Each team’s game in week ' + tableWeek() + ': a pick box until it ends, then the result">Wk ' + tableWeek() + '</th>') +
      th('cfp', 'Make CFP', 'c-cfp') + '</th>' +
      th('bye', '1st rd bye', 'c-bye sec') + '</th>' +
      th('champ', 'Win conf.', 'c-conf sec') + '</th>' +
      th('title', 'Win title', 'c-title sec') + '</th>';
  }
  function nextChance(g, t) {
    var pk = st.picks[g.id];
    if (!pk) return Math.round(g.p * 100) + '% to win';
    return '<b>' + (pk === t.id ? 'picked to win' : 'picked to lose') + '</b>';
  }
  // A live game as a small scoreboard: away team and score on the left, home score and team on the right.
  // The row's own team is bold, and so is the leading score.
  var gameIndex = { D: null, byId: {} };
  function gameById(id) {
    if (gameIndex.D !== D) { gameIndex = { D: D, byId: {} }; D.games.forEach(function (g) { gameIndex.byId[g.id] = g; }); }
    return gameIndex.byId[id];
  }
  // The current week: the ESPN week of the most recent kickoff, so today's finals still count as this week.
  var weekIndex = { D: null, at: 0, wk: null, byTeam: {} };
  function weekGames() {
    var now = Date.now();
    if (weekIndex.D !== D || now - weekIndex.at > 60000) {
      var started = D.games.filter(function (g) { return g.wk != null && Date.parse(g.d) <= now; });
      var wk = started.length ? Math.max.apply(null, started.map(function (g) { return g.wk; })) : Math.min.apply(null, D.games.map(function (g) { return g.wk || 99; }));
      // Each team's games by week, and the week of its next game that hasn't kicked off.
      var byWeek = {}, nextPre = {};
      D.games.forEach(function (g) {
        if (g.wk == null) return;
        [g.h, g.a].forEach(function (i) {
          (byWeek[i] = byWeek[i] || {})[g.wk] = g;
          if (g.s === 'pre' && (nextPre[i] == null || g.wk < nextPre[i])) nextPre[i] = g.wk;
        });
      });
      weekIndex = { D: D, at: now, wk: wk, byWeek: byWeek, nextPre: nextPre };
    }
    return weekIndex;
  }
  // Each team moves on to a new week when its own game that week kicks off, so a Tuesday MAC game doesn't
  // move everyone else. Until then its week is the one before its next game (no later than the current week).
  function teamWeek(x) {
    var W = weekGames(), n = W.nextPre[x.i];
    return n == null ? W.wk : Math.min(W.wk, n - 1);
  }
  function weekGame(x, wk) { var m = weekGames().byWeek[x.i]; return (m && m[wk]) || null; }
  function thisWeek(x) { return weekGame(x, teamWeek(x)); }
  // ESPN writes the clock as '12:00 - 2nd'; show it without the hyphen, '12:00 2nd'. Halftime and the like pass through.
  function clock(g) { var m = /^\s*(\d+:\d+)\s*-\s*(.+)$/.exec(g.st || ''); return m ? m[1] + ' ' + m[2] : g.st || ''; }
  function shortDay(d) { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }); }
  // "at ND" or "vs ND" for team i's side of a game.
  function matchup(g, i) { var opp = D.teams[g.h === i ? g.a : g.h]; return (g.n || g.h === i ? 'vs ' : 'at ') + esc(opp.ab || opp.name); }
  // A stacked scoreboard: away team over home team. The team ahead (or the winner) is bold.
  function stackRows(g) {
    var played = g.s !== 'pre';
    function line(t, n, other) {
      return '<span class="ss-r' + (played && n > other ? ' lead' : '') + '"><span class="ss-t">' + esc(t.ab || t.name) + '</span><span class="ss-s">' + (played ? n : '') + '</span></span>';
    }
    return line(D.teams[g.a], g.as, g.hs) + line(D.teams[g.h], g.hs, g.as);
  }
  function scoreLabel(g) {
    var away = D.teams[g.a], home = D.teams[g.h];
    return g.s === 'pre' ? away.name + ' at ' + home.name : away.name + ' ' + g.as + ', ' + home.name + ' ' + g.hs;
  }
  // This week's game: the final score, the live score with the clock, or the matchup to come with its date.
  function nextCell(x) {
    var g = thisWeek(x);
    if (!g) return '<span class="next">Bye week</span>';
    var isNext = x.next && x.next.id === g.id;
    var info = g.s === 'post' ? '' : (g.s === 'in' ? esc(clock(g)) : shortDay(g.d)) + (isNext ? ' · ' + nextChance(x.next, x.t) : '');
    return '<span class="next"><span class="ss" role="img" aria-label="' + esc(scoreLabel(g)) + '">' + stackRows(g) + '</span>' + (info ? '<small>' + info + '</small>' : '') + '</span>';
  }

  // The headline numbers for one team. The field panel always shows them; table details show them on phones.
  function statsList(x, cls) {
    var R = x.r;
    function stat(label, value) { return '<div><dt>' + label + '</dt><dd>' + value + '</dd></div>'; }
    return '<dl class="field-stats' + (cls ? ' ' + cls : '') + '">' +
      stat('Make CFP', pct(R.cfp)) +
      stat('First-round bye', pct(R.bye)) +
      stat('Avg seed', R.seed ? R.seed.toFixed(1) : '—') +
      stat('Win conf.', x.t.conf === 'ind' ? '—' : pct(R.champ)) +
      stat('Win title', pct(R.title)) +
      stat('Rating', x.rating.toFixed(1)) +
    '</dl>';
  }
  // The table's week column: the current week until every game in it is final, then the next week with games,
  // so picks open for next week once this one is done.
  // In conference championship week it holds the title games (engine.js tableWeek decides which week it is).
  function weekInfo() { return CFP.tableWeek(D.games, D.titles, Date.now(), sbStat); }
  function tableWeek() { return weekInfo().wk; }
  // A team's conference title game entry, or null (an independent, or a conference without one).
  function titleOf(x) { return D.titles.filter(function (t) { return t.conf === x.t.conf; })[0] || null; }
  function titleOver(tg) { return tg.w >= 0 || tg.s === 'post'; }
  // Championship week in the table: once a title game is over, its two teams show W or L. Before that, each
  // team still able to reach it (it does in at least one simulated season) gets a pick box: W means it wins
  // the title game if it gets there. Once the matchup is set, the box works like any other game's.
  function ccgCell(x) {
    var tg = titleOf(x);
    if (!tg) return '';
    var set = tg.h >= 0 && tg.a >= 0, inGame = tg.h === x.i || tg.a === x.i, opp = set && inGame ? D.teams[tg.h === x.i ? tg.a : tg.h] : null;
    if (titleOver(tg)) {
      if (!inGame) return '';
      var won = tg.w === x.i, label = x.t.name + (won ? ' won' : ' lost') + ' the title game' + (opp ? (won ? ' over ' : ' to ') + opp.name : '');
      return '<div class="nx-cell" title="' + esc(label) + '"><span class="nx-res" aria-label="' + esc(label) + '"><b class="res ' + (won ? 'res-w' : 'res-l') + '">' + (won ? 'W' : 'L') + '</b></span>' + (opp ? '<span class="nx-vs" aria-hidden="true">vs ' + esc(opp.ab || opp.name) + '</span>' : '') + '</div>';
    }
    if (set ? !inGame : !(x.r.ccg > 0)) return '';
    return ccgBox(x, tg, opp);
  }
  // bare: just the box (the team page's schedule), without the table cell's caption.
  function ccgBox(x, tg, opp, bare) {
    var key = 'ccg:' + tg.conf, pk = st.picks[key], won = pk === x.t.id, lost = !!pk && !won && !!opp && pk === opp.id;
    var other = !!pk && !won && !lost ? D.teams.filter(function (t) { return t.id === pk; })[0] : null;
    var what = x.t.name + ' in the ' + (CFP.CONF_NAME[tg.conf] || tg.conf) + ' title game' + (opp ? ' vs ' + opp.name : '');
    var label = won ? what + ': picked to win. Press to ' + (opp ? 'pick a loss' : 'clear the pick') : lost ? what + ': picked to lose. Press to clear the pick' :
      (other ? other.name + ' is picked to win this conference. ' : '') + 'No pick for ' + what + '. Press to pick it to win' + (opp ? '' : ' if it gets there');
    var box = '<button type="button" class="pick-box' + (won ? ' pick-w' : lost ? ' pick-l' : '') + '" data-pick="' + esc(key) + '" data-team="' + x.t.id + '" data-opp="' + esc(opp ? opp.id : '') + '" aria-label="' + esc(label) + '" title="' + esc(label) + '">' + (won ? 'W' : lost ? 'L' : '') + '</button>';
    if (bare) return '<span class="mini">' + box + '</span>';
    return '<div class="nx-cell"><div class="mini">' + box + '</div>' +
      '<span class="nx-vs" aria-hidden="true">' + (opp ? 'vs ' + esc(opp.ab || opp.name) : '<abbr title="Chance to reach the title game">' + pct(x.r.ccg) + '</abbr>') + '</span></div>';
  }
  // Each team's game in that week: a W/L pick box until the game ends, then its result and score. A team
  // with no game that week (a bye) gets a blank cell.
  function weekCell(x) {
    var info = weekInfo();
    if (info.ccg) return ccgCell(x);
    var g = weekGame(x, info.wk);
    if (!g) return '';
    var home = g.h === x.i, opp = D.teams[home ? g.a : g.h], vs = (home || g.n ? 'vs ' : '@') + esc(opp.ab || opp.name);
    if (sbStat(g) === 'post') {
      var mine = home ? g.hs : g.as, theirs = home ? g.as : g.hs;
      if (mine == null || theirs == null || mine === theirs) return '<div class="nx-cell"><span class="nx-res">—</span><span class="nx-vs">' + vs + '</span></div>';
      var won = mine > theirs, label = x.t.name + (won ? ' beat ' : ' lost to ') + opp.name + ' ' + mine + '–' + theirs;
      return '<div class="nx-cell" title="' + esc(label) + '"><span class="nx-res" aria-label="' + esc(label) + '"><b class="res ' + (won ? 'res-w' : 'res-l') + '">' + (won ? 'W' : 'L') + '</b>' + mine + '–' + theirs + '</span><span class="nx-vs" aria-hidden="true">' + vs + '</span></div>';
    }
    return pickBox(x, g);
  }
  // The Next column: the week after This week. It names the opponent and has a W/L box for that game.
  // A team with no game that week (a bye) gets a blank cell. After the regular season's last
  // week it falls back to the team's next scheduled game (a title game), or a dash.
  function nextWeekGame(x) {
    var wk = teamWeek(x) + 1;
    if (!D.games.some(function (g) { return g.wk === wk; })) {
      var tw = thisWeek(x), g = x.next ? gameById(x.next.id) : null;
      return g && (!tw || tw.id !== g.id) ? g : null;
    }
    return weekGame(x, wk) || 'bye';
  }
  function nextWinChance(x, g) {
    if (x.next && x.next.id === g.id && x.next.p != null) return x.next.p;
    var h = pregameHome(g);
    return g.h === x.i ? h : 1 - h;
  }
  function pickCell(x) {
    var g = nextWeekGame(x);
    if (g === 'bye') return ''; // a bye week leaves Next blank
    if (!g || g.s === 'post') return '\u2014';
    return pickBox(x, g);
  }
  function pickBox(x, g) {
    var opp = D.teams[g.h === x.i ? g.a : g.h], vs = matchup(g, x.i);
    var pk = st.picks[g.id], won = pk === x.t.id, lost = !!pk && !won;
    var label = won ? x.t.name + ' ' + vs + ' picked to win. Press to pick a loss' : lost ? x.t.name + ' ' + vs + ' picked to lose. Press to clear the pick' : 'No pick for ' + x.t.name + ' ' + vs + '. Press to pick a win';
    return '<div class="nx-cell"><div class="mini"><button type="button" class="pick-box' + (won ? ' pick-w' : lost ? ' pick-l' : '') + '" data-pick="' + esc(g.id) + '" data-team="' + x.t.id + '" data-opp="' + esc(opp.id) + '" aria-label="' + esc(label) + '" title="' + esc(label) + '">' + (won ? 'W' : lost ? 'L' : '') + '</button></div>' +
      // Same form as the NFL table: "vs DUKE" at home or neutral, "@ARIZ" away.
      '<span class="nx-vs" aria-hidden="true">' + (g.h === x.i || g.n ? 'vs ' : '@') + esc(opp.ab || opp.name) + '</span>' + '</div>';
  }
  // Phones show four columns: CFP, team, pick and Make CFP (styles.css hides the rest below 900px). A full-width row must span
  // exactly the visible columns, or the fixed table layout adds empty columns and squeezes the team name.
  var WIDE = matchMedia('(min-width: 900px)');
  var TABLET = matchMedia('(min-width: 600px)');
  function visibleColumns() { return WIDE.matches || st.expanded ? 11 : TABLET.matches ? 8 : 6; }
  // The selected ratings' name, as the Ratings menu shows it.
  function modeName() { var o = $('mode') && $('mode').selectedOptions[0]; return o ? o.textContent : st.mode; }
  // ---------- Team pages ----------
  // Every FBS team has a page of its own at #team/<name>, in place of the panel that used to open under its
  // row in the table: its résumé and headline odds, its schedule and scores, its Make CFP odds over time and its
  // seed chart. The address spells the team's name in plain lowercase letters (san-jose-state); a name two
  // teams shared would get the team's id added.
  var slugIndex = { D: null, of: [], at: Object.create(null) };
  function slugs() {
    if (slugIndex.D !== D) {
      slugIndex = { D: D, of: [], at: Object.create(null) };
      for (var i = 0; i < D.fbs; i++) {
        var s = D.teams[i].name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        if (!s || slugIndex.at[s] != null) s = (s ? s + '-' : '') + D.teams[i].id;
        slugIndex.of[i] = s; slugIndex.at[s] = i;
      }
    }
    return slugIndex;
  }
  function teamHref(i) { return '#team/' + slugs().of[i]; }
  // A team's name as a link to its page. Teams outside FBS have no page, so theirs stays plain text.
  function teamLink(i, html) { return i < D.fbs ? '<a class="tlink" href="' + teamHref(i) + '">' + html + '</a>' : html; }
  function splitRow(label, make) {
    return '<tr><th scope="row">' + label + '</th><td>' + pct(make) + '</td><td>' + pct(make == null ? null : 1 - make) + '</td></tr>';
  }
  // One row of shaded tiles, as on the Scores cards. A missing number shows a dash.
  function oddsRow(label, now, win, loss) {
    var tile = function (v) { return v == null ? '<div class="lg-num">—</div>' : '<div class="lg-cfp" style="--p:' + v.toFixed(3) + '">' + pct(v) + '</div>'; };
    return '<div class="odds-row"><span class="h">' + label + '</span><span class="h">If win</span><span class="h">If loss</span>' + tile(now) + tile(win) + tile(loss) + '</div>';
  }
  // ---------- Résumé (team panel) ----------
  // For every FBS team under the selected ratings, from finals so far and the games left:
  //  - SOS played / left: average opponent rating (P.R, which moves with results), ranked 1 = toughest.
  //  - Strength of record (ESPN's idea): the chance a top-25 team (the 25th-best rating) would have this
  //    record or better against this schedule; the smaller, the better the résumé. Ranked 1 = best.
  //  - Win out: the chance to win every regular-season game left (picks count as decided), game by game.
  //  - Record against the current CFP top 25, best win and worst loss (by opponent rating).
  var resumeCache = { D: null, by: {} }, CLOSE = 4; // rating points within which wins or losses count as equally good / bad
  function resumes() {
    if (resumeCache.D !== D) resumeCache = { D: D, by: {} };
    if (resumeCache.by[st.mode]) return resumeCache.by[st.mode];
    var P = CFP.prep(D, st.mode), Rt = P.R, fbs = D.fbs, M = CFP.M, hfa = D.sources.hfa[st.mode] || 2.5;
    var total = Math.sqrt(M.gameSD * M.gameSD + 2 * M.teamSD * M.teamSD);
    var sorted = Array.prototype.slice.call(Rt.subarray(0, fbs)).sort(function (a, b) { return b - a; }), bench = sorted[24];
    var played = []; for (var i = 0; i < fbs; i++) played.push([]);
    D.games.forEach(function (g) {
      if (g.s !== 'post' || g.h < 0 || g.a < 0) return;
      [[g.h, g.a, g.n ? 0 : 1], [g.a, g.h, g.n ? 0 : -1]].forEach(function (s) { if (s[0] < fbs) played[s[0]].push({ o: s[1], site: s[2], won: g.w === s[0], g: g }); });
    });
    var sc = schedule(), out = [];
    for (i = 0; i < fbs; i++) {
      var pl = played[i], left = sc[i].filter(function (g) { return g.s !== 'post'; });
      var avg = function (list) { return list.length ? list.reduce(function (s, x) { return s + Rt[x.o]; }, 0) / list.length : null; };
      // Wins a top-25 team would get against these games: the chance of at least this many.
      var dist = [1];
      pl.forEach(function (x) {
        var p = CFP.phi((bench - Rt[x.o] + x.site * hfa) / total), next = new Array(dist.length + 1).fill(0);
        dist.forEach(function (v, k) { next[k] += v * (1 - p); next[k + 1] += v * p; });
        dist = next;
      });
      var wins = pl.filter(function (x) { return x.won; }).length, sor = 0;
      for (var k = wins; k < dist.length; k++) sor += dist[k];
      var winOut = left.reduce(function (s, g) { var pk = st.picks[g.id]; return s * (pk ? (pk === D.teams[i].id ? 1 : 0) : g.p); }, 1);
      var ranked = pl.filter(function (x) { return D.teams[x.o].rank; });
      // A win's quality is the opponent's rating with half of home field counted (a road win is worth a bit more).
      var tough = function (x) { return Rt[x.o] - x.site * hfa / 2; }, rk = function (x) { return D.teams[x.o].rank || 99; };
      // Unranked teams only count as a best win when a team has no wins over the CFP top 25.
      var wl = pl.filter(function (x) { return x.won; }), wr = wl.filter(function (x) { return rk(x) < 99; });
      wl = (wr.length ? wr : wl).sort(function (a, b) { return tough(b) - tough(a); });
      var ll = pl.filter(function (x) { return !x.won; }).sort(function (a, b) { return Rt[a.o] - Rt[b.o]; });
      out.push({ sos: avg(pl), sosLeft: avg(left), sor: pl.length ? sor : null, winOut: left.length ? winOut : null, nLeft: left.length,
        top25: ranked.filter(function (x) { return x.won; }).length + '-' + ranked.filter(function (x) { return !x.won; }).length,
        // Wins close to the toughest one, plus any over a CFP-ranked team ranked at least as high as it.
        best: wl.filter(function (e) { return tough(wl[0]) - tough(e) <= CLOSE || (rk(e) < 99 && rk(e) <= rk(wl[0])); }).slice(0, 3)
          .sort(function (a, b) { return rk(a) - rk(b) || tough(b) - tough(a); }),
        worst: ll.filter(function (e) { return Rt[e.o] - Rt[ll[0].o] <= CLOSE; }).slice(0, 3) });
    }
    // Ranks among FBS teams: toughest schedule first, best (smallest) strength of record first.
    function rankBy(key, asc) {
      var idx = out.map(function (_, i) { return i; }).filter(function (i) { return out[i][key] != null; });
      idx.sort(function (a, b) { return asc ? out[a][key] - out[b][key] : out[b][key] - out[a][key]; });
      idx.forEach(function (t, k) { out[t][key + 'Rank'] = k + 1; });
      return idx.length;
    }
    var n = { sos: rankBy('sos'), sosLeft: rankBy('sosLeft'), sor: rankBy('sor', true) };
    return (resumeCache.by[st.mode] = { teams: out, n: n });
  }
  function ordinal(n) { var v = n % 100, s = v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'; return n + s; }
  // The team's AP poll rank through the season: a line over the weeks it was ranked, a hollow dot at the
  // bottom (NR) for weeks it wasn't. Rank 1 is at the top.
  // Playoff odds over time (D.hist from the build): each point re-runs the season as it stood then, with the
  // default ratings; the last point is now.
  function histLabel(l) { return l === 'Pre' ? 'Preseason' : l === 'Now' ? 'Now' : /^\d+$/.test(l) ? 'After week ' + l : 'Through ' + l; }
  function oddsChart(i, what) {
    var H = D.hist, v = H && H.v[i];
    if (!v || !v.length) return '<p class="ap-none">No history yet.</p>';
    var n = v.length, W = 340, Hh = 150, L = 30, Rp = 8, T = 8, B = 18, dates = H.labels.some(function (l) { return /[a-z]/.test(l) && l !== 'Pre' && l !== 'Now'; });
    var px = function (k) { return L + (n === 1 ? (W - L - Rp) / 2 : k * (W - L - Rp) / (n - 1)); };
    var py = function (x) { return T + (1000 - x) * (Hh - T - B) / 1000; };
    var grid = [1000, 500, 0].map(function (y) {
      return '<line x1="' + L + '" x2="' + (W - Rp) + '" y1="' + py(y) + '" y2="' + py(y) + '" class="ap-grid"/><text x="' + (L - 5) + '" y="' + (py(y) + 3) + '" class="ap-y">' + y / 10 + '%</text>';
    }).join('');
    // A plain line with a dot on every week; each dot's hover text gives that week's number.
    var pts = [];
    v.forEach(function (x, k) { if (x != null) pts.push(px(k).toFixed(1) + ',' + py(x).toFixed(1)); });
    var line = pts.length > 1 ? '<polyline points="' + pts.join(' ') + '" class="ap-line"/>' : '';
    var dots = v.map(function (x, k) {
      return x == null ? '' : '<circle cx="' + px(k).toFixed(1) + '" cy="' + py(x).toFixed(1) + '" r="3" class="ap-dot"><title>' + histLabel(H.labels[k]) + ': ' + pct(x / 1000) + (H.src && H.src[k] === 'saved' ? ' (as the site had it then)' : H.src && (H.src[k] === 'rebuilt' || H.src[k] === 'pre') ? ' (rebuilt)' : '') + '</title></circle>';
    }).join('');
    var step = Math.max(1, Math.ceil(n / (dates ? 4 : 9)));
    var xs = H.labels.map(function (l, k) {
      if (k % step && k !== n - 1) return '';
      return '<text x="' + px(k).toFixed(1) + '" y="' + (Hh - 4) + '" class="ap-x"' + (k === n - 1 && n > 1 ? ' text-anchor="end"' : k === 0 ? ' text-anchor="start"' : '') + '>' + (l === 'Pre' ? 'P' : l) + '</text>';
    }).join('');
    var label = D.teams[i].name + ', ' + what + ' over time: ' + v.map(function (x, k) { return histLabel(H.labels[k]) + ' ' + (x == null ? 'none' : pct(x / 1000)); }).join(', ');
    return '<svg viewBox="0 0 ' + W + ' ' + Hh + '" role="img" aria-label="' + esc(label) + '">' + grid + line + dots + xs + '</svg>';
  }
  function oddsChartBlock(i, what, model) {
    var H = D.hist, v = H && H.v[i], now = v && v.length ? v[v.length - 1] : null;
    var how = what + ' after each ' + (H && H.labels.some(function (l) { return /^\d+$/.test(l); }) ? 'week' : 'week (Sunday night)') +
      '. Points marked "as the site had it" are the odds saved at the time; the others are rebuilt by re-running the season as it stood then, with ' +
      (H && H.past ? H.past : 'the ratings of that time') + '. The preseason point uses ' + (H && H.pre ? H.pre : 'preseason ratings') +
      '. The last point is now, with today\'s ' + model + ' ratings.';
    return '<div class="ap-chart">' + cardHead(what + ' over time', now != null ? '<b>' + pct(now / 1000) + '</b> now' : '', how) + oddsChart(i, what) + '</div>';
  }
  // A team-page card's heading: its name at the left and, at the right, the number it leads with.
  function cardHead(name, side, title) {
    return '<h3 class="tp-h"' + (title ? ' title="' + esc(title) + '"' : '') + '><span>' + name + '</span>' + (side ? '<span class="tp-h-side">' + side + '</span>' : '') + '</h3>';
  }

  // The résumé, in the head of the team's page, as six tiles: strength of record, schedule strength, the chance
  // to win out, the record against the top 25, best win and worst loss.
  function resumeBlock(x) {
    var all = resumes(), r = all.teams[x.i];
    // Opponents as logos side by side; each matchup is in its hover text.
    function opp(list) {
      if (!list.length) return '—';
      return '<span class="rs-teams">' + list.map(function (e) {
        var o = D.teams[e.o], what = (e.site === -1 ? 'at ' : 'vs ') + o.name + (o.rank ? ' (No. ' + o.rank + ')' : '');
        return '<span class="rs-team" title="' + esc(what) + '" aria-label="' + esc(what) + '">' + logo(o, 26) + '</span>';
      }).join('') + '</span>';
    }
    function tile(label, title, value) {
      return '<div><dt><abbr title="' + title + '">' + label + '</abbr></dt><dd>' + value + '</dd></div>';
    }
    return '<dl class="rs-tiles tp-resume">' +
      tile('SOR', 'Strength of record: how hard this record would be for a top-25 team to match against this schedule, ranked among ' + all.n.sor + ' FBS teams (1st = hardest)', r.sorRank ? ordinal(r.sorRank) : '—') +
      tile('SOS', 'Strength of schedule: average rating of opponents played, ranked among ' + all.n.sos + ' FBS teams (1st = toughest)' + (r.nLeft ? '; schedule left ranks ' + ordinal(r.sosLeftRank) : ''), r.sosRank ? ordinal(r.sosRank) : '—') +
      tile('vs top 25', 'Record against teams in the current CFP top 25', r.top25) +
      tile('Best win', 'Toughest team beaten (by the selected ratings, road wins counting a bit more); wins within ' + CLOSE + ' points of it, or over a team ranked at least as high in the CFP, show too. Wins over unranked teams count only for a team with no top-25 wins', opp(r.best)) +
      tile('Worst loss', 'Lowest-rated team lost to (by the selected ratings); losses within ' + CLOSE + ' points of it show too', opp(r.worst)) +
    '</dl>';
  }
  // A y axis for the seed chart: the top of the scale, half of it and zero, with light lines across.
  function histY(top, plot) {
    var f = function (v) { return Math.round(v * 100) + '%'; };
    return '<div class="hist-y"><div class="hist-ax" aria-hidden="true"><span style="top:0">' + f(top) + '</span><span style="top:50%">' + f(top / 2) + '</span><span style="top:100%">0</span></div><div class="hist-plot">' + plot + '</div></div>';
  }
  // The seed chart: how often the team lands on each of the 12 seeds, as a share of every simulation, so the
  // bars add up to its Make CFP odds.
  function seedChart(x) {
    var hist = x.r.hist, N = res().sims;
    var topS = [0.05, 0.1, 0.2, 0.25, 0.4, 0.5, 0.6, 0.8, 1].find(function (s) { return s >= Math.max.apply(null, hist.concat(0)) / N - 1e-9; }) || 1, maxH = topS * N;
    var bars = hist.map(function (h, i) {
      var label = 'Seed ' + (i + 1) + ': ' + (h / N * 100).toFixed(1) + '% of simulations';
      return '<div title="' + label + '" aria-label="' + label + '"><i style="height:' + (h / maxH * 100).toFixed(1) + '%"></i></div>';
    }).join('');
    var xs = hist.map(function (_, i) { return '<span>' + (i + 1) + '</span>'; }).join('');
    return histY(topS, '<div class="hist" role="img" aria-label="Chance of each playoff seed for ' + esc(x.t.name) + '">' + bars + '</div><div class="hist-x">' + xs + '</div>');
  }
  // The whole schedule, oldest game first. A game to come has its kickoff time and network under its date. The
  // column at the right is how each game went: a final's result and score, a game under way's score and clock,
  // and for any game left its win chance and the same W / L / blank pick box as the table's. Opponents in FBS
  // link to their own pages.
  function teamSchedule(x) {
    var i = x.i, left = {};
    schedule()[i].forEach(function (g) { left[g.id] = g; });
    var games = D.games.filter(function (g) { return g.h === i || g.a === i; }).sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
    if (!games.length) return '<p class="ap-none">No games scheduled.</p>';
    var rows = games.map(function (g) {
      var home = g.h === i, oi = home ? g.a : g.h, o = D.teams[oi], mine = home ? g.hs : g.as, theirs = home ? g.as : g.hs, nx = left[g.id], s = sbStat(g);
      var day = function (opt) { return new Date(g.d).toLocaleDateString('en-US', Object.assign({ timeZone: 'America/New_York' }, opt)); };
      var vs = home || g.n ? 'vs' : 'at', cell = '';
      // ESPN marks a kickoff time that hasn't been set as midnight Eastern.
      var when = s !== 'pre' ? '' : '<span class="tg-time">' + (etTime(g.d) === '12:00 AM' ? 'Time TBA' : etTime(g.d) + ' ET') + (g.tv && g.tv.length ? '<span class="net-logos tg-tv">' + tvBadges(g.tv) + '</span>' : '') + '</span>';
      // The long name shows on wide screens and the short one on phones, as does everything marked tg-wide (styles.css).
      var opp = '<span class="tg-vs">' + vs + '</span>' + logo(o, 22) +
        teamLink(oi, (o.rank ? '<small class="lg-rank">' + o.rank + '</small>' : '') + '<span class="tg-long">' + esc(o.name) + '</span><span class="tg-short">' + esc(o.ab || o.name) + '</span>');
      if (s === 'post') {
        // A final with no score, or a level one, is a game that wasn't played (ESPN leaves a cancelled game at 0-0).
        var played = mine != null && theirs != null && mine !== theirs;
        cell = played ? '<span class="tg-part"><b class="res ' + (mine > theirs ? 'res-w' : 'res-l') + '">' + (mine > theirs ? 'W' : 'L') + '</b><span class="tg-score">' + mine + '\u2013' + theirs + '</span></span>' : '<span class="tg-note">Not played</span>';
      } else {
        if (s === 'in') cell = '<span class="tg-part"><b>' + mine + '\u2013' + theirs + '</b><span class="lg-clock">' + esc(clock(g)) + '</span></span>';
        if (nx) {
          var pk = st.picks[g.id], won = pk === x.t.id, lost = !!pk && !won, what = x.t.name + ' ' + vs + ' ' + (o.ab || o.name);
          var label = won ? what + ' picked to win. Press to pick a loss' : lost ? what + ' picked to lose. Press to clear the pick' : 'No pick for ' + what + '. Press to pick a win';
          cell += '<span class="tg-part"><span class="tg-win" title="Chance to win, from the selected ratings">' + Math.round(nx.p * 100) + '%</span>' +
            '<span class="mini"><button type="button" class="pick-box' + (won ? ' pick-w' : lost ? ' pick-l' : '') + '" data-pick="' + esc(g.id) + '" data-team="' + x.t.id + '" data-opp="' + esc(o.id) + '" aria-label="' + esc(label) + '" title="' + esc(label) + '">' + (won ? 'W' : lost ? 'L' : '') + '</button></span></span>';
        }
      }
      return '<tr' + (s === 'in' ? ' class="tg-live"' : '') + '><td class="tg-date"><span class="tg-wide">' + day({ weekday: 'short' }) + ', </span>' + day({ month: 'short', day: 'numeric' }) + when + '</td>' +
        '<td><span class="tg-team">' + opp + '</span></td><td class="tg-res"><div class="tg-cell">' + cell + '</div></td></tr>';
    }).join('') + ccgRow(x);
    return '<table class="tp-table tp-games"><thead><tr><th scope="col">Date</th><th scope="col">Opponent</th><th scope="col" class="tg-res">Result</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }
  // The conference title game, after the schedule, for a team that can still reach it or played in it: its
  // chance to get there and a pick box (win if it gets there), or the result.
  function ccgRow(x) {
    var tg = titleOf(x);
    if (!tg) return '';
    var set = tg.h >= 0 && tg.a >= 0, inGame = tg.h === x.i || tg.a === x.i;
    if (titleOver(tg) ? !inGame : set ? !inGame : !(x.r.ccg > 0)) return '';
    var oi = inGame ? (tg.h === x.i ? tg.a : tg.h) : -1, o = oi >= 0 ? D.teams[oi] : null;
    var day = function (opt) { return new Date(tg.d).toLocaleDateString('en-US', Object.assign({ timeZone: 'America/New_York' }, opt)); };
    var name = esc(CFP.CONF_ABBR[tg.conf] || CFP.CONF_NAME[tg.conf] || tg.conf) + ' title game';
    var who = '<span class="tg-vs">' + (o ? 'vs' : '') + '</span>' + (o ? logo(o, 22) + teamLink(oi, '<span class="tg-long">' + esc(o.name) + '</span><span class="tg-short">' + esc(o.ab || o.name) + '</span>') + ' <small class="tg-ccg">' + name + '</small>' : '<span>' + name + '</span>');
    var cell = titleOver(tg) ? '<span class="tg-part"><b class="res ' + (tg.w === x.i ? 'res-w' : 'res-l') + '">' + (tg.w === x.i ? 'W' : 'L') + '</b></span>' :
      '<span class="tg-part">' + (set ? '' : '<span class="tg-win" title="Chance to reach the title game">' + pct(x.r.ccg) + '</span>') + ccgBox(x, tg, o, true) + '</span>';
    return '<tr class="tg-ccgrow"><td class="tg-date"><span class="tg-wide">' + day({ weekday: 'short' }) + ', </span>' + day({ month: 'short', day: 'numeric' }) + '</td>' +
      '<td><span class="tg-team">' + who + '</span></td><td class="tg-res"><div class="tg-cell">' + cell + '</div></td></tr>';
  }
  // The head of the page: who the team is (logo, full name, CFP rank, conference with its logo, and record) and
  // its résumé.
  // The name with its conference under it; across from it, large, the record, conference record and the team's
  // place in the CFP ranking and the AP and Coaches polls, each with its move since last week. The résumé runs
  // along the bottom.
  function teamHead(x) {
    var t = x.t, rec = x.rec, ind = t.conf === 'ind', conf = CFP.CONF_NAME[t.conf] || t.conf;
    function move(now, prev) {
      if (!prev) return '<small class="mv up" title="Unranked last week">new</small>';
      return prev > now ? '<small class="mv up" title="Up from No. ' + prev + '">\u25b2' + (prev - now) + '</small>' : prev < now ? '<small class="mv down" title="Down from No. ' + prev + '">\u25bc' + (now - prev) + '</small>' : '';
    }
    function poll(label, title, now, prev, has) {
      var v = now ? '<span><span class="tp-hash">#</span>' + now + '</span>' + move(now, prev) : '<span class="tp-nr" title="Not ranked">NR</span>';
      return has ? '<div><dt><abbr title="' + title + '">' + label + '</abbr></dt><dd>' + v + '</dd></div>' : '';
    }
    var stand = '<dl class="tp-standing">' +
      '<div class="tp-rec"><dt>Record</dt><dd>' + rec.text + '</dd></div>' +
      (ind ? '' : '<div><dt><abbr title="' + esc(conf) + ' record">Conf.</abbr></dt><dd>' + rec.cw + '-' + rec.cl + '</dd></div>') +
      poll('CFP', 'College Football Playoff committee ranking', t.rank, t.rankPrev || (t.rank ? t.rank : 0), D.hasCfp) +
      poll('AP', 'AP Top 25 poll', t.ap && t.ap.r, t.ap && t.ap.p, true) +
      poll('Coaches', 'AFCA Coaches Poll', t.coach && t.coach.r, t.coach && t.coach.p, true) +
    '</dl>';
    return '<div class="tp-head"' + (t.color && /^[0-9a-f]{6}$/i.test(t.color) ? ' style="--tc:#' + t.color + '"' : '') + '><div class="tp-id">' + logo(t, 64) +
      '<div class="tp-name"><h2>' + esc(t.full || t.name) + '</h2><p>' + confLogo(t.conf) + esc(conf) + '</p></div></div>' + stand + resumeBlock(x) + '</div>';
  }
  // The headline odds, as tiles shaded like the table's cells. An independent has no conference to win.
  function teamOdds(x) {
    var r = x.r, ind = x.t.conf === 'ind', rs = resumes().teams[x.i];
    function tile(label, title, v, text) {
      // A chance shades its cell green by its value, like the table's cells; a number that isn't one (Avg seed) doesn't.
      return '<div' + (v == null ? '' : ' style="--p:' + v.toFixed(3) + '"') + '><dt><abbr title="' + title + '">' + label + '</abbr></dt><dd>' + (text != null ? text : pct(v)) + '</dd></div>';
    }
    return '<dl class="rs-tiles tp-odds">' +
      tile('Make CFP', 'Chance to make the 12-team playoff', r.cfp) +
      tile('1st-round bye', 'Chance to earn a first-round bye', r.bye) +
      tile('Make conf. championship', 'Chance to play in the conference championship game', ind ? null : r.ccg, ind ? '\u2014' : null) +
      tile('Win conference', 'Chance to win the conference championship', ind ? null : r.champ, ind ? '\u2014' : null) +
      tile('Win title', 'Chance to win the national championship', r.title) +
      tile('Win out', 'Chance to win every regular-season game left (' + rs.nLeft + ')', rs.winOut, rs.winOut == null ? '\u2014' : null) +
      tile('Avg seed', 'Average playoff seed in the simulations where they make the CFP', null, r.seed ? r.seed.toFixed(1) : '\u2014') +
    '</dl>';
  }
  // The team's conference in order of conference record (then overall record, then the better chance to reach
  // the title game): each team's two records and its chances to play in the conference championship game and
  // to win it. A conference in divisions lists each division on its own. The page's own team is marked.
  function confStandings(x) {
    var conf = x.t.conf, R = res(), rows = [], divs = {};
    for (var i = 0; i < D.fbs; i++) if (D.teams[i].conf === conf) rows.push({ i: i, t: D.teams[i], r: R.teams[i], rec: record(i) });
    var share = function (w, l) { return w + l ? w / (w + l) : 0; };
    rows.sort(function (a, b) {
      return share(b.rec.cw, b.rec.cl) - share(a.rec.cw, a.rec.cl) || b.rec.cw - a.rec.cw || a.rec.cl - b.rec.cl ||
        share(b.rec.w, b.rec.l) - share(a.rec.w, a.rec.l) || b.r.ccg - a.r.ccg;
    });
    function shaded(v) { return '<td class="st-pct' + (v < 0.005 ? ' st-low' : '') + '" style="--p:' + v.toFixed(3) + '">' + pct(v) + '</td>'; }
    function line(y) {
      var me = y.i === x.i, name = (y.t.rank ? '<small class="lg-rank">' + y.t.rank + '</small>' : '') + '<span class="tg-long">' + esc(y.t.name) + '</span><span class="tg-short">' + esc(y.t.ab || y.t.name) + '</span>';
      return '<tr' + (me ? ' class="st-me"' : '') + '><td><span class="tg-team">' + logo(y.t, 22) + (me ? '<span>' + name + '</span>' : teamLink(y.i, name)) + '</span></td>' +
        '<td>' + y.rec.cw + '-' + y.rec.cl + '</td><td>' + y.rec.text + '</td>' + shaded(y.r.ccg) + shaded(y.r.champ) + '</tr>';
    }
    rows.forEach(function (y) { var d = y.t.div || ''; (divs[d] = divs[d] || []).push(y); });
    var names = Object.keys(divs).sort();
    var body = names.map(function (d) {
      return (names.length > 1 ? '<tr class="st-div"><th colspan="5" scope="rowgroup">' + esc(d.replace(/^.* - /, '')) + '</th></tr>' : '') + divs[d].map(line).join('');
    }).join('');
    return '<table class="tp-table tp-stand"><thead><tr><th scope="col">Team</th>' +
      '<th scope="col"><abbr title="Conference record">Conf</abbr></th><th scope="col"><abbr title="Overall record">Ovr</abbr></th>' +
      '<th scope="col"><abbr title="Chance to play in the conference championship game">Title game</abbr></th>' +
      '<th scope="col"><abbr title="Chance to win the conference championship">Win conf.</abbr></th></tr></thead><tbody>' + body + '</tbody></table>';
  }
  // Everything under the headline odds, in three columns on wide screens: the schedule, then Make CFP over time
  // over the seed chart, then the conference standings. An independent has no standings, so its two charts take
  // the second and third columns. Tablets fit the third column under the second; phones show one column:
  // schedule, Make CFP over time, seed chart, standings.
  function teamBody(x) {
    var ind = x.t.conf === 'ind';
    var conf = esc(CFP.CONF_NAME[x.t.conf] || x.t.conf);
    var sched = '<section class="tp-card tp-1" aria-label="Schedule and scores">' + cardHead('Schedule and scores', '<b>' + x.rec.text + '</b>' + (ind ? '' : ' · ' + x.rec.cw + '-' + x.rec.cl + ' conf.')) + teamSchedule(x) + '</section>';
    var cfp = '<section class="tp-card tp-2">' + oddsChartBlock(x.i, 'Make CFP', 'Massey + Sagarin') + '</section>';
    var seed = '<section class="tp-card tp-3">' + cardHead('Projected seed', x.r.seed ? 'avg. <b>' + x.r.seed.toFixed(1) + '</b>' : '') +
      (x.r.seed ? seedChart(x) + '<p class="tp-foot">Share of all simulations at each seed; the bars add up to the Make CFP chance.</p>' : '<p class="ap-none">Not in the field in any simulation.</p>') + '</section>';
    var stand = ind ? '' : '<section class="tp-card tp-4">' + cardHead(confLogo(x.t.conf) + conf + ' standings', '') + confStandings(x) + '</section>';
    return '<div class="tp-grid"><div class="tp-col">' + sched + '</div><div class="tp-col">' + cfp + (ind ? '' : seed) + '</div><div class="tp-col">' + (ind ? seed : stand) + '</div></div>';
  }
  // The team whose page is open, by its place in the current data (ESPN updates can reorder teams).
  function teamIndex() { for (var i = 0; i < D.fbs; i++) if (D.teams[i].id === st.team) return i; return -1; }
  function renderTeam() {
    if ($('page-team').hidden) return;
    var i = teamIndex(), R = res();
    if (i < 0) { $('team-page').innerHTML = '<p class="live-empty">That team isn\u2019t in this season\u2019s data. <a href="#rankings">See all teams</a>.</p>'; return; }
    var x = { i: i, t: D.teams[i], r: R.teams[i], rec: record(i) };
    // The History view keeps the team's header; the history itself sits below, outside this block.
    if (st.teamView === 'history') { $('team-page').innerHTML = teamHead(x); return; }
    // Picks made anywhere on the site are part of every number here, so the page says when there are any.
    var n = Object.keys(st.picks).length;
    $('team-page').innerHTML = teamHead(x) +
      (n ? '<p class="tp-picks"><span><b>' + n + (n === 1 ? ' game' : ' games') + ' picked.</b> All odds assume ' + (n === 1 ? 'that result' : 'those results') + '.</span><button class="btn" type="button" data-clearpicks="1">Clear picks</button></p>' : '') +
      teamOdds(x) + teamBody(x);
  }
  // The table heading names what's shown: a conference if one is chosen, otherwise the team group.
  var VIEW_NAME = { all: 'FBS', p4: 'Power 4', g5: 'Group of 6' };
  // What RK is, and which week's ranking it is. Shown with the table instructions.
  function rkNote() {
    var week = D.rankLabel ? D.rankLabel.replace(/^.*- /, '').replace(/^CFP Rankings /i, '') : '';
    var since = projected().since;
    return ' <b>CFP</b> is the College Football Playoff committee ranking' + (week ? ' (' + esc(week) + ')' : '') + '.' + (projOn() ? ' <b>Proj.</b> is our projection of the next ranking' + (since ? ', with the ' + since + ' games played since' : '') + '.' : '');
  }
  function renderBoardTitle(count) {
    $('board-title').innerHTML = (st.conf ? confLogo(st.conf) : '') + esc(st.conf ? (CFP.CONF_NAME[st.conf] || st.conf) : VIEW_NAME[st.view]);
    $('board-count').textContent = count + (count === 1 ? ' team' : ' teams') + (st.q.trim() ? ' matching “' + st.q.trim() + '”' : '');
  }
  // A percentage column cell, shaded by its value like Make CFP.
  function shaded(v) { return '<td class="sec pct-cell" style="--p:' + v.toFixed(3) + '">' + pct(v) + '</td>'; }
  // Projected next CFP rank, top 25 only, with the move from the current ranking.
  function projCell(x) {
    if (!x.proj || x.proj > 25) return '<td class="tc c-prk-cell"></td>';
    var cur = x.t.rank, mv = cur ? cur - x.proj : null;
    var arrow = mv == null ? '<small class="mv up" title="New in the top 25">new</small>' : mv > 0 ? '<small class="mv up">▲' + mv + '</small>' : mv < 0 ? '<small class="mv down">▼' + (-mv) + '</small>' : '';
    return '<td class="tc c-prk-cell">' + x.proj + arrow + '</td>';
  }
  // The Proj. column only matters in the run-up to a ranking release: Sunday 6 AM to Tuesday 9 PM Eastern.
  function projOn() {
    if (!D.rankDate) return false;
    var p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date())
      .forEach(function (x) { p[x.type] = x.value; });
    var h = +p.hour;
    return (p.weekday === 'Sun' && h >= 6) || p.weekday === 'Mon' || (p.weekday === 'Tue' && h < 21);
  }
  function renderTable() {
    var showProj = projOn();
    if (!showProj && st.sort === 'proj') { st.sort = 'team'; st.dir = 1; }
    document.querySelector('.odds-table').classList.toggle('no-proj', !showProj);
    head();
    var rows = visible(buildRows());
    renderBoardTitle(rows.length);
    if (!rows.length) { $('body').innerHTML = '<tr><td class="empty" colspan="' + visibleColumns() + '">No teams match. Clear the search or pick another conference.</td></tr>'; return; }
    $('body').innerHTML = rows.map(function (x) {
      var r = '<tr' + (x.next && x.next.s === 'in' ? ' class="live-row"' : '') + '><td class="first c-rk">' + (x.t.rank || '') + '</td>' + projCell(x) +
        '<td class="team-col"><div class="teamcell">' + logo(x.t, 30) +
        '<span><a class="tname" href="' + teamHref(x.i) + '" aria-label="' + esc(x.t.name) + '"><span class="tn-long">' + esc(x.t.name) + '</span><span class="tn-short" aria-hidden="true">' + esc(x.t.ab || x.t.name) + '</span></a></span></div></td>' +
        '<td class="l c-cn-cell"><span class="cn-long">' + esc(CFP.CONF_NAME[x.t.conf] || x.t.conf) + '</span><span class="cn-short" aria-hidden="true">' + esc(CFP.CONF_ABBR[x.t.conf] || CFP.CONF_NAME[x.t.conf] || x.t.conf) + '</span></td>' +
        '<td class="num rec">' + x.rec.text + '</td>' +
        '<td class="num tc">' + x.index.toFixed(1) + '</td>' +
        '<td class="pick">' + weekCell(x) + '</td>' +
        '<td class="odds-cell" style="--p:' + x.r.cfp.toFixed(3) + '"><div class="odds"><span class="v">' + pct(x.r.cfp) + '</span></div></td>' +
        shaded(x.r.bye) +
        (x.t.conf === 'ind' ? '<td class="sec">—</td>' : shaded(x.r.champ)) + shaded(x.r.title) + '</tr>';
      return r;
    }).join('');
  }
  function fieldPanel(x) {
    var conf = CFP.CONF_NAME[x.t.conf] || x.t.conf;
    return '<div class="fd-head">' +
        '<div class="field-team">' + logo(x.t, 30) + '<span><b>' + esc(x.t.name) + '</b><span class="tmeta">' + x.rec.text + ' · ' + esc(conf) + (x.t.rank ? ' · CFP No. ' + x.t.rank : '') + '</span></span></div>' +
        '<div class="field-pick">' + nextCell(x) + pickCell(x) + '</div>' +
        '<button class="btn" type="button" id="field-close">Close</button>' +
      '</div>' +
      statsList(x) + teamBody(x);
  }
  // The 12 teams most likely to make it, in order of average seed. Shared by the field and the bracket.
  // Built the way the bids work: the most likely champion of each power conference and the Group of 6 team
  // most likely to earn its automatic bid, then the best remaining odds. Taking the 12 highest odds alone can
  // leave out the Group of 6 bid when it's split among several teams, say after the favorite loses.
  function projectedField() {
    var all = buildRows().sort(function (a, b) { return b.r.cfp - a.r.cfp; });
    var field = [], used = {};
    function add(x) { if (x && !used[x.t.id] && field.length < 12) { used[x.t.id] = 1; field.push(x); } }
    function likeliestBid(teams) { return teams.sort(function (a, b) { return b.r.aq - a.r.aq || b.r.cfp - a.r.cfp; })[0]; }
    CFP.P4.forEach(function (c) { add(likeliestBid(all.filter(function (x) { return x.t.conf === c; }))); });
    add(likeliestBid(all.filter(function (x) { return CFP.G6.indexOf(x.t.conf) >= 0; })));
    all.forEach(add);
    var seedOf = function (x) { return x.r.seed == null ? 99 : x.r.seed; };
    field.sort(function (a, b) { return seedOf(a) - seedOf(b); });
    return { all: all, field: field, rest: all.filter(function (x) { return !used[x.t.id]; }) };
  }
  // The Projected field section was removed from the page; the bracket still uses projectedField().
  function renderField() {
    if (!$('seeds')) return;
    var pf = projectedField(), all = pf.all, field = pf.field;
    $('seeds').innerHTML = field.map(function (x, i) {
      var isOpen = st.fieldOpen === x.t.id;
      return '<button type="button" class="seed" data-field="' + x.t.id + '" aria-expanded="' + isOpen + '" aria-controls="field-detail" aria-label="Seed ' + (i + 1) + ', ' + esc(x.t.name) + ', ' + pct(x.r.cfp) + ' to make the playoff. ' + (isOpen ? 'Hide' : 'Show') + ' details"><span class="n">' + (i + 1) + '</span><span class="ab">' + logo(x.t, 22) + esc(x.t.ab) + '</span><span class="pc">' + pct(x.r.cfp) + '</span></button>';
    }).join('');
    // A pick can drop the open team out of the 12, so it is looked up in all teams.
    var opened = all.filter(function (x) { return x.t.id === st.fieldOpen; })[0];
    $('field-detail').hidden = !opened;
    $('field-detail').innerHTML = opened ? fieldPanel(opened) : '';
    $('out').innerHTML = '<b>Next in line:</b> ' + pf.rest.slice(0, 4).map(function (x) { return esc(x.t.name) + ' ' + pct(x.r.cfp); }).join(', ');
    $('field-note').textContent = 'The likeliest champion of each power conference and the likeliest Group of 6 bid, plus the seven best remaining odds, ordered by average seed. Select a team for details.';
  }

  // ---------- Playoff bracket ----------
  // One game's win chance from the two ratings, as the simulator plays it. Only first-round games have home field.
  function winChance(a, b, home) {
    var M = CFP.M, total = Math.sqrt(M.gameSD * M.gameSD + 2 * M.teamSD * M.teamSD);
    var hfa = home ? (D.sources.hfa[st.mode] || 2.5) : 0;
    return CFP.phi((a.rating - b.rating + hfa) / total);
  }
  // A team or a not-yet-known slot. Seeds only: later rounds show which game feeds them.
  function tbd(label) { return { tbd: label }; }
  // st.bkPicks maps a game key (r1-0 ... f) to the seed the viewer picked to win it.
  function bracketRow(key, slot, opp, cls, chance, host) {
    if (slot.tbd) {
      return '<div class="bk-team tbd" aria-label="To be decided: ' + esc(slot.tbd) + '"></div>';
    }
    var inner = '<span class="bk-seed">' + slot.seed + '</span>' + logo(slot.x.t, 22) +
      '<span class="bk-name">' + esc(slot.x.t.name) + '</span><span class="bk-p">' + (chance == null ? '' : Math.round(chance * 100) + '%') + '</span>';
    if (opp.tbd) return '<div class="bk-team' + (cls ? ' ' + cls : '') + '">' + inner + '</div>';
    var picked = st.bkPicks[key] === slot.seed, lost = st.bkPicks[key] === opp.seed;
    var label = picked ? slot.x.t.name + ' picked to win. Press to pick a loss' : lost ? slot.x.t.name + ' picked to lose. Press to clear the pick' : 'No pick for ' + slot.x.t.name + ' vs ' + opp.x.t.name + '. Press to pick a win';
    // The same box as the Rankings table: W for the team you picked, L for its opponent, empty otherwise.
    var box = '<span class="mini"><span class="pick-box' + (picked ? ' pick-w' : lost ? ' pick-l' : '') + '" aria-hidden="true">' + (picked ? 'W' : lost ? 'L' : '') + '</span></span>';
    return '<button type="button" class="bk-team picks' + (cls ? ' ' + cls : '') + '" data-bk="' + key + '" data-seed="' + slot.seed + '" data-opp="' + opp.seed + '" aria-pressed="' + picked + '" aria-label="' + esc(label) + '">' + inner + box + '</button>';
  }
  // A game is decided by the viewer's pick, or by the favorite when Simulate games is on.
  // Win chances show for every decided game. A winner carries its chance of getting this far.
  function bracketGame(key, hi, lo, home, feeds, where) {
    var known = !hi.tbd && !lo.tbd;
    var pickSeed = st.bkPicks[key], picked = known ? (pickSeed === hi.seed ? hi : pickSeed === lo.seed ? lo : null) : null;
    // A pick whose team is no longer in this game (an earlier pick changed) is dropped, so it can't return unseen.
    if (pickSeed != null && !picked) delete st.bkPicks[key];
    var p = known && (st.bkSim || picked) ? winChance(hi.x, lo.x, home) : null;
    var win = picked || (p != null ? (p >= 0.5 ? hi : lo) : null);
    var html = '<article class="bk-game">' + (where ? '<p class="bk-where">' + where + '</p>' : '') + '<div class="bk-box">' +
      bracketRow(key, hi, lo, win ? (win === hi ? 'win' : 'lose') : '', p, home) +
      bracketRow(key, lo, hi, win ? (win === lo ? 'win' : 'lose') : '', p == null ? null : 1 - p, false) +
      '</div></article>';
    if (!win) return { winner: tbd(feeds), html: html };
    var chance = win === hi ? p : 1 - p;
    return { winner: { seed: win.seed, x: win.x, path: (win.path || 1) * chance }, html: html };
  }
  // 2026-27 playoff schedule, from the CFP's broadcast schedule (times Eastern).
  // Fixed: the Fiesta Bowl quarterfinal (Dec 30), the Orange and Sugar semifinals and the title game.
  // Set on Selection Day (Dec 6): which seeds go to which quarterfinal bowl, the Jan 1 windows for the Peach,
  // Cotton and Rose bowls, and the first-round slots. Until then those are projected (see projectBowls).
  var NET = {
    ESPN: { name: 'ESPN', logo: 'https://upload.wikimedia.org/wikipedia/commons/2/2f/ESPN_wordmark.svg' },
    ABC: { name: 'ABC', logo: 'https://upload.wikimedia.org/wikipedia/commons/2/2f/ABC-2021-LOGO.svg' },
    TNT: { name: 'TNT', logo: 'https://upload.wikimedia.org/wikipedia/commons/2/24/TNT_Logo_2016.svg' },
    truTV: { name: 'truTV', logo: 'https://upload.wikimedia.org/wikipedia/commons/3/36/TruTV_logo.svg' },
    HBOMax: { name: 'HBO Max', logo: 'https://upload.wikimedia.org/wikipedia/commons/b/b3/HBO_Max_%282025%29.svg' }
  };
  var TNT_GROUP = ['TNT', 'truTV', 'HBOMax'], ABC_ESPN = ['ABC', 'ESPN'];
  var BOWLS = {
    fiesta: { short: 'Fiesta Bowl', name: 'Vrbo Fiesta Bowl', color: '#7a2a8e', site: 'Glendale, Ariz.', logo: 'https://upload.wikimedia.org/wikipedia/en/9/9d/Fiesta_Bowl_Logo.svg' },
    peach: { short: 'Peach Bowl', name: 'Chick-fil-A Peach Bowl', color: '#e35205', site: 'Atlanta', logo: 'https://upload.wikimedia.org/wikipedia/en/3/39/Peach_Bowl_logo.svg' },
    rose: { short: 'Rose Bowl', name: 'Rose Bowl Game', color: '#c8102e', site: 'Pasadena, Calif.', logo: 'https://upload.wikimedia.org/wikipedia/en/a/a3/Rose_Bowl_Game_logo.svg' },
    cotton: { short: 'Cotton Bowl', name: 'Goodyear Cotton Bowl Classic', color: '#1f3c88', site: 'Arlington, Texas', logo: 'https://upload.wikimedia.org/wikipedia/en/3/3b/Cotton_Bowl_logo.svg' },
    orange: { short: 'Orange Bowl', name: 'Capital One Orange Bowl', color: '#f47321', site: 'Miami Gardens, Fla.', logo: 'https://upload.wikimedia.org/wikipedia/en/5/51/Orange_Bowl_logo.svg', when: 'Thu, Jan 14 · 7:30 PM', tv: TNT_GROUP },
    sugar: { short: 'Sugar Bowl', name: 'Allstate Sugar Bowl', color: '#0b3d91', site: 'New Orleans', logo: 'https://upload.wikimedia.org/wikipedia/en/9/98/Sugar_Bowl_Logo.svg', when: 'Fri, Jan 15 · 7:30 PM', tv: ABC_ESPN },
    title: { short: 'Las Vegas', name: 'CFP National Championship', color: 'var(--accent)', site: 'Allegiant Stadium, Las Vegas', when: 'Mon, Jan 25 · 7:30 PM', tv: ABC_ESPN,
      logo: 'https://upload.wikimedia.org/wikipedia/commons/4/4d/College_Football_National_Championship_logo.svg' }
  };
  // Quarterfinal slots: the Fiesta's is fixed; the Jan 1 windows are projected the way they usually go
  // (the Rose Bowl in its traditional afternoon slot).
  var QF_SLOT = {
    fiesta: { when: 'Wed, Dec 30 · 7:30 PM', tv: TNT_GROUP },
    peach: { when: 'Fri, Jan 1 · 12:00 PM', tv: TNT_GROUP },
    rose: { when: 'Fri, Jan 1 · 4:00 PM', tv: ABC_ESPN },
    cotton: { when: 'Fri, Jan 1 · 8:00 PM', tv: ['ESPN'] }
  };
  // First-round slots, projected by seed: 8 vs 9 Friday night, the rest Saturday.
  var R1_SLOT = {
    '8-9': { when: 'Fri, Dec 18 · 8:00 PM', tv: ['ESPN'] },
    '5-12': { when: 'Sat, Dec 19 · 12:00 PM', tv: ABC_ESPN },
    '6-11': { when: 'Sat, Dec 19 · 3:30 PM', tv: TNT_GROUP },
    '7-10': { when: 'Sat, Dec 19 · 7:30 PM', tv: TNT_GROUP }
  };
  // The committee places the top four seeds into quarterfinal bowls, in seed order, with an eye to geography
  // and tradition. This projection does the same: each seed takes the first open bowl on its conference's list.
  var BOWL_PREF = {
    big10: ['rose', 'fiesta', 'cotton', 'peach'], pac12: ['rose', 'fiesta', 'cotton', 'peach'],
    sec: ['peach', 'cotton', 'fiesta', 'rose'], acc: ['peach', 'cotton', 'fiesta', 'rose'],
    big12: ['cotton', 'fiesta', 'peach', 'rose'], ind: ['fiesta', 'cotton', 'peach', 'rose']
  };
  function projectBowls(top4) {
    var open = ['rose', 'peach', 'cotton', 'fiesta'], out = [];
    top4.forEach(function (x) {
      var pref = BOWL_PREF[x.x.t.conf] || ['fiesta', 'cotton', 'peach', 'rose'];
      var k = pref.filter(function (p) { return open.indexOf(p) >= 0; })[0];
      open.splice(open.indexOf(k), 1);
      out.push(k);
    });
    return out;
  }
  function netLogos(keys) {
    return '<span class="net-logos">' + keys.map(function (k) { return '<img class="net-' + k.toLowerCase() + '" src="' + NET[k].logo + '" alt="' + esc(NET[k].name) + '" title="' + esc(NET[k].name) + '" loading="lazy">'; }).join('') + '</span>';
  }
  // The line above a bracket game: TV logos and time, then the bowl or site. "proj." marks a projected slot.
  function gameLine(tv, when, place) {
    // "Fri, Jan 1 · 12:00 PM" -> "Jan 1 · 12 PM ET"
    var short = when.replace(/^\w+, /, '').replace(':00 ', ' ');
    return '<span class="bk-place">' + place + '</span><span class="bk-air"><b>' + esc(short) + '<span class="bk-et"> ET</span></b>' + netLogos(tv) + '</span>';
  }
  // Header dates for each round (the rest goes to screen readers).
  var ROUND_WHEN = { 'First round': 'Dec 18–19', Quarterfinals: 'Dec 30 – Jan 1', Semifinals: 'Jan 14–15', Championship: 'Jan 25' };
  var ROUND_INFO = {
    'First round': 'Dec 18–19 · higher seed hosts',
    Quarterfinals: 'Dec 30 – Jan 1 · Fiesta, Peach, Rose, Cotton',
    Semifinals: 'Jan 14–15 · Orange, Sugar',
    Championship: 'Jan 25 · Las Vegas'
  };
  // A bowl's logo, named in its tooltip and for screen readers.
  // Bowl logo, name and site; the site shows only where the card has room (styles.css).
  function bowlChip(k) {
    var b = BOWLS[k], loc = k === 'title' ? 'Allegiant Stadium' : b.site;
    return '<img class="bk-bowl bk-bowl-' + k + '" src="' + b.logo + '" alt="" loading="lazy"><span title="' + esc(b.name + ' · ' + b.site) + '">' + esc(b.short) + '</span><span class="bk-loc">' + esc(loc) + '</span>';
  }
  // Fixed bracket, no reseeding: 1 plays the 8/9 winner, 4 plays 5/12, 2 plays 7/10, 3 plays 6/11.
  function renderBracket() {
    var field = projectedField().field, sim = !!st.bkSim;
    $('bk-sim').setAttribute('aria-pressed', sim);
    $('bk-sim').textContent = sim ? 'Show seeds only' : 'Simulate games';
    $('bracket-note').textContent = sim
      ? 'The favorite in each game advances unless you pick a team. Win chances come from the two ratings, with home field for the higher seed in the first round.'
      : 'Select a team to advance it. Each game you decide shows both teams’ chance to win, from their ratings.';
    if (field.length < 12) { $('bracket').innerHTML = ''; return; }
    var s = field.map(function (x, i) { return { seed: i + 1, x: x }; });
    // First round at the higher seed's stadium; quarterfinal bowls projected for seeds 1-4 in seed order;
    // the semifinal with the No. 1 seed's side projected to the Orange Bowl.
    var r1Line = function (key, x) { var sl = R1_SLOT[key]; return gameLine(sl.tv, sl.when, '<span>At ' + esc(x.x.t.name) + '</span>'); };
    var bySeed = projectBowls([s[0], s[1], s[2], s[3]]), bowl = [bySeed[0], bySeed[3], bySeed[1], bySeed[2]]; // seeds pick in order 1-4; the bracket lists 1, 4, 2, 3
    var qfLine = function (k) { var sl = QF_SLOT[k]; return gameLine(sl.tv, sl.when, bowlChip(k)); };
    var sfLine = function (k) { var b = BOWLS[k]; return gameLine(b.tv, b.when, bowlChip(k)); };
    var r1 = [bracketGame('r1-0', s[7], s[8], true, 'Winner of 8 vs 9', r1Line('8-9', s[7])), bracketGame('r1-1', s[4], s[11], true, 'Winner of 5 vs 12', r1Line('5-12', s[4])),
      bracketGame('r1-2', s[6], s[9], true, 'Winner of 7 vs 10', r1Line('7-10', s[6])), bracketGame('r1-3', s[5], s[10], true, 'Winner of 6 vs 11', r1Line('6-11', s[5]))];
    var qf = [bracketGame('qf-0', s[0], r1[0].winner, false, 'Winner of quarterfinal 1', qfLine(bowl[0])), bracketGame('qf-1', s[3], r1[1].winner, false, 'Winner of quarterfinal 2', qfLine(bowl[1])),
      bracketGame('qf-2', s[1], r1[2].winner, false, 'Winner of quarterfinal 3', qfLine(bowl[2])), bracketGame('qf-3', s[2], r1[3].winner, false, 'Winner of quarterfinal 4', qfLine(bowl[3]))];
    var sf = [bracketGame('sf-0', qf[0].winner, qf[1].winner, false, 'Winner of semifinal 1', sfLine('orange')), bracketGame('sf-1', qf[2].winner, qf[3].winner, false, 'Winner of semifinal 2', sfLine('sugar'))];
    var fin = bracketGame('f', sf[0].winner, sf[1].winner, false, 'Champion', gameLine(BOWLS.title.tv, BOWLS.title.when, bowlChip('title')));
    $('bk-clear').hidden = !Object.keys(st.bkPicks).length; // after the games drop stale picks
    function round(title, games) { return '<section class="bk-round" aria-label="' + esc(title + ', ' + (ROUND_INFO[title] || '')) + '">' + '<h3>' + esc(title === 'First round' ? 'First Round' : title) + '<small>' + ROUND_WHEN[title] + '</small></h3>' + '<div class="bk-games">' + games.map(function (g) { return g.html; }).join('') + '</div></section>'; }
    var champ = fin.winner.tbd ? null : fin.winner;
    var titles = s.slice().sort(function (a, b) { return b.x.r.title - a.x.r.title; }).slice(0, 6);
    var champCard = '';
    if (champ) {
      var t = champ.x.t;
      champCard = '<div class="bk-champ"><div class="bk-champ-team">' + logo(t, 40) + '<div><p class="bk-label">' + (st.bkPicks.f === champ.seed ? 'Your champion' : 'Projected champion') + '</p><p class="bk-champ-name">' + esc(t.name) + '</p></div></div>' +
        '<p><b>' + esc(t.name) + '</b> wins every game on this path ' + pct(champ.path) + ' of the time, using each game’s win chance. Across all simulations it wins the title ' + pct(champ.x.r.title) + ' of the time.</p></div>';
    }
    $('bracket').innerHTML = champCard +
      '<div class="bk-rounds" id="bk-rounds">' + round('First round', r1) + round('Quarterfinals', qf) + round('Semifinals', sf) + round('Championship', [fin]) + '</div>' +
      (sim ? '<div class="bk-titles"><h3>Title odds</h3><ol>' + titles.map(function (x) { return '<li>' + logo(x.x.t, 20) + '<span>' + esc(x.x.t.name) + '</span><b>' + pct(x.x.r.title) + '</b></li>'; }).join('') + '</ol></div>' : '');
    drawConnectors();
  }
  // Lines from each game to the one its winner plays next. Only drawn when the rounds sit side by side.
  var BK_WIDE = matchMedia('(min-width: 1000px)');
  // Shows each game site only if it fits in full on its card.
  // Logos change the room left once they load, so check again then.
  var fitTimer = null;
  document.addEventListener('load', function (e) {
    if (!e.target.closest || !e.target.closest('.bk-where')) return;
    clearTimeout(fitTimer);
    fitTimer = setTimeout(function () { var w = document.getElementById('bk-rounds'); if (w) fitLocs(w); }, 50);
  }, true);
  function fitLocs(root) {
    [].forEach.call(root.querySelectorAll('.bk-loc'), function (l) { l.classList.remove('cut'); });
    [].forEach.call(root.querySelectorAll('.bk-loc'), function (l) { if (l.scrollWidth > l.clientWidth + 1) l.classList.add('cut'); });
  }
  function drawConnectors() {
    var wrap = document.getElementById('bk-rounds');
    if (!wrap) return;
    fitLocs(wrap);
    var old = wrap.querySelector('.bk-lines');
    if (old) old.remove();
    if (!BK_WIDE.matches || !wrap.offsetWidth) return;
    var base = wrap.getBoundingClientRect();
    var rounds = [].map.call(wrap.querySelectorAll('.bk-round'), function (r) { return [].slice.call(r.querySelectorAll('.bk-game')); });
    var links = [[0, 0, 1, 0], [0, 1, 1, 1], [0, 2, 1, 2], [0, 3, 1, 3], [1, 0, 2, 0], [1, 1, 2, 0], [1, 2, 2, 1], [1, 3, 2, 1], [2, 0, 3, 0], [2, 1, 3, 0]];
    var d = links.map(function (l) {
      var a = rounds[l[0]][l[1]].getBoundingClientRect(), b = rounds[l[2]][l[3]].getBoundingClientRect();
      var x1 = a.right - base.left, y1 = a.top + a.height / 2 - base.top, x2 = b.left - base.left, y2 = b.top + b.height / 2 - base.top, mx = (x1 + x2) / 2;
      return 'M' + x1 + ' ' + y1 + 'H' + mx + 'V' + y2 + 'H' + x2;
    }).join('');
    wrap.insertAdjacentHTML('afterbegin', '<svg class="bk-lines" aria-hidden="true" width="' + base.width + '" height="' + base.height + '"><path d="' + d + '"></path></svg>');
  }
  try { new ResizeObserver(function () { drawConnectors(); }).observe($('bracket')); } catch (x) {}
  try { BK_WIDE.addEventListener('change', drawConnectors); } catch (x) {}
  function etTime(iso) { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }); }
  function etDay(when) { return new Date(when).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }
  // Both teams' gap between winning and losing this game, added together (a stand-in until it's measured).
  function gameStakesSum(g) {
    var R = res(), s = 0;
    [g.h, g.a].forEach(function (i) {
      if (i >= D.fbs) return;
      var r = R.teams[i], nx = schedule()[i][0];
      if (nx && nx.id === g.id && r.ifNext != null && r.ifLose != null) s += Math.abs(r.ifNext - r.ifLose);
    });
    return s;
  }
  function liveRow(g, i, score, other) {
    var t = D.teams[i], isFbs = i < D.fbs, r = isFbs ? res().teams[i] : null, nx = isFbs ? schedule()[i][0] : null;
    var done = g.s === 'post', win = '';
    // A shaded odds tile, or a dash when there's no number.
    function tile(v, cls) { cls = cls ? ' ' + cls : ''; return v == null ? '<div class="lg-num' + cls + '">—</div>' : '<div class="lg-cfp' + cls + '" style="--p:' + v.toFixed(3) + '">' + pct(v) + '</div>'; }
    if (!done) {
      if (st.picks[g.id]) win = st.picks[g.id] === t.id ? 'Pick' : '';
      else if (nx && nx.id === g.id) win = Math.round(nx.p * 100) + '%';
      else win = '—';
    }
    // An FBS team's name links to its team page.
    var name = '<div class="lg-team">' + logo(t, 22) + '<span>' + teamLink(i, (t.rank ? '<small class="lg-rank">' + t.rank + '</small>' : '') + esc(t.ab || t.name)) + (isFbs ? ' <small class="lg-rec">(' + record(i).text + ')</small>' : '') + '</span></div>';
    // Upcoming games: no score; Make CFP odds if this team wins or loses it. A picked game has one outcome left.
    if (g.s === 'pre') {
      var ifW = null, ifL = null;
      if (r && st.picks[g.id]) { if (st.picks[g.id] === t.id) ifW = r.cfp; else ifL = r.cfp; }
      else if (r) { ifW = r.ifNext; ifL = r.ifLose; }
      return name + '<div class="lg-num">' + win + '</div>' + tile(r ? r.cfp : null) + tile(ifW, 'lg-if') + tile(ifL, 'lg-if');
    }
    return name +
      '<div class="lg-score' + (score >= other ? ' lead' : '') + '">' + (score == null ? '' : score) + '</div>' +
      '<div class="lg-num">' + win + '</div>' +
      tile(r ? r.cfp : null) + tile(r ? r.ifNext : null, 'lg-if') + tile(r ? r.ifLose : null, 'lg-if');
  }
  // Pre-game win chance for the home team, from the selected ratings. FCS teams use their Massey rating.
  function pregameHome(g) {
    var R = res(), M = CFP.M, total = Math.sqrt(M.gameSD * M.gameSD + 2 * M.teamSD * M.teamSD);
    function rating(i) { return i < D.fbs ? R.rating[i] : (D.teams[i].r && D.teams[i].r.massey) || 0; }
    return CFP.phi((rating(g.h) - rating(g.a) + (g.n ? 0 : (D.sources.hfa[st.mode] || 2.5))) / total);
  }
  // The home team's chance right now, using the current score and clock.
  function liveHome(g) {
    var sc = schedule(), nx;
    if (g.h < D.fbs && (nx = sc[g.h][0]) && nx.id === g.id) return nx.p;
    if (g.a < D.fbs && (nx = sc[g.a][0]) && nx.id === g.id) return 1 - nx.p;
    return null;
  }
  // An upset: a team under 35% before kickoff that is now favored, or that won. Picked games aren't flagged.
  var UPSET_LINE = 0.35;
  function upset(g) {
    if (st.picks[g.id] || g.s === 'pre') return null;
    var pre = pregameHome(g), dog = pre < UPSET_LINE ? g.h : pre > 1 - UPSET_LINE ? g.a : -1;
    if (dog < 0) return null;
    var dogPre = dog === g.h ? pre : 1 - pre;
    if (g.s === 'post') return g.w === dog ? { dog: dog, pre: dogPre } : null;
    var lh = liveHome(g);
    if (lh == null) return null;
    var now = dog === g.h ? lh : 1 - lh;
    return now >= 0.5 ? { dog: dog, pre: dogPre, now: now } : null;
  }
  // A network name as a small badge in its brand color. Names come from ESPN; unknown ones get a neutral badge.
  var TV_COLORS = {
    ESPN: '#cc0000', ESPN2: '#cc0000', ESPNU: '#cc0000', ESPNEWS: '#cc0000', 'ESPN+': '#cc0000', SECN: '#003a70', 'SECN+': '#003a70', ACCN: '#013ca6', 'ACCNX': '#013ca6',
    'ESPN Unlmtd': '#cc0000', 'SEC Network': '#003a70', 'ACC Network': '#013ca6', Fox: '#0b2240', 'Disney+': '#0b3d91', 'USA Net': '#1d3f8f', 'MW+': '#3d4f6b', 'UConn+': '#0e1a3d',
    ABC: '#111111', CBS: '#0b3d91', CBSSN: '#0b3d91', FOX: '#0b2240', FS1: '#2d2d2d', FS2: '#2d2d2d', BTN: '#0088ce', NBC: '#5c2d91', Peacock: '#111111',
    TNT: '#c8102e', truTV: '#e2231a', 'HBO Max': '#5822b4', CW: '#00843d', 'The CW': '#00843d', 'Big 12 Now': '#c8102e', 'Pac-12 Network': '#004b87'
  };
  // Network logos by ESPN's network name. Networks without a freely licensed logo keep a colored name badge.
  var TV_LOGO = {
    ESPN: 'https://upload.wikimedia.org/wikipedia/commons/2/2f/ESPN_wordmark.svg', ESPN2: 'https://upload.wikimedia.org/wikipedia/commons/b/bf/ESPN2_logo.svg', ESPNU: 'https://upload.wikimedia.org/wikipedia/commons/c/ca/ESPN_U_logo.svg', ESPNEWS: 'https://upload.wikimedia.org/wikipedia/commons/1/1b/ESPNews.svg',
    ABC: 'https://upload.wikimedia.org/wikipedia/commons/2/2f/ABC-2021-LOGO.svg', CBS: 'https://upload.wikimedia.org/wikipedia/commons/4/4e/CBS_logo.svg', CBSSN: 'https://upload.wikimedia.org/wikipedia/commons/0/04/CBS_Sports_Network_2021.svg',
    FOX: 'https://upload.wikimedia.org/wikipedia/commons/c/c0/Fox_Broadcasting_Company_logo_%282019%29.svg', Fox: 'https://upload.wikimedia.org/wikipedia/commons/c/c0/Fox_Broadcasting_Company_logo_%282019%29.svg', FS1: 'https://upload.wikimedia.org/wikipedia/commons/3/37/2015_Fox_Sports_1_logo.svg',
    NBC: 'https://upload.wikimedia.org/wikipedia/commons/3/3f/NBC_logo.svg', Peacock: 'https://upload.wikimedia.org/wikipedia/commons/f/fb/NBCUniversal_Peacock_Logo_%282020%E2%80%932026%29.svg',
    'SEC Network': 'https://upload.wikimedia.org/wikipedia/commons/b/b9/SEC_Network_logo.svg', SECN: 'https://upload.wikimedia.org/wikipedia/commons/b/b9/SEC_Network_logo.svg', 'ACC Network': 'https://upload.wikimedia.org/wikipedia/commons/0/00/ACC_Network_logo_fc_db.svg', ACCN: 'https://upload.wikimedia.org/wikipedia/commons/0/00/ACC_Network_logo_fc_db.svg',
    TNT: 'https://upload.wikimedia.org/wikipedia/commons/2/24/TNT_Logo_2016.svg', truTV: 'https://upload.wikimedia.org/wikipedia/commons/3/36/TruTV_logo.svg', 'HBO Max': 'https://upload.wikimedia.org/wikipedia/commons/b/b3/HBO_Max_%282025%29.svg', 'Prime Video': 'https://upload.wikimedia.org/wikipedia/commons/9/90/Prime_Video_logo_%282024%29.svg', BTN: 'https://upload.wikimedia.org/wikipedia/en/3/39/Big_Ten_Network_Logo.svg',
    CW: 'https://upload.wikimedia.org/wikipedia/commons/b/b1/The_CW_2024.svg', 'The CW': 'https://upload.wikimedia.org/wikipedia/commons/b/b1/The_CW_2024.svg', 'USA Net': 'https://upload.wikimedia.org/wikipedia/commons/d/d7/USA_Network_logo_%282016%29.svg', 'Disney+': 'https://upload.wikimedia.org/wikipedia/commons/3/3e/Disney%2B_logo.svg'
  };
  // Major networks only (the ones with a logo); niche and streaming-only channels are left off.
  function tvBadges(names) {
    return (names || []).filter(function (n) { return TV_LOGO[n] && n !== 'Disney+'; }).map(function (n) { // Disney+ only simulcasts ESPN/ABC
      if (TV_LOGO[n]) return '<img class="net-' + n.toLowerCase().replace(/[^a-z0-9]/g, '') + '" src="' + TV_LOGO[n] + '" alt="' + esc(n) + '" title="' + esc(n) + '" loading="lazy">';
      return '<span class="tv" style="--tv:' + (TV_COLORS[n] || 'var(--muted)') + '">' + esc(n) + '</span>';
    }).join('');
  }
  function liveCard(g) {
    var isLive = sbStat(g) === 'in', isPre = g.s === 'pre';
    var u = upset(g);
    // The network matters for games still to come or under way, not for finals.
    var tv = (isLive || isPre) ? '<span class="tv-list net-logos">' + (g.tv && g.tv.length ? tvBadges(g.tv) : '<span class="tv-name tv-tba">TV TBA</span>') + '</span>' : '';
    var wd = new Date(g.d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' }); // every card names its day and date
    var top = isLive ? '<span class="lg-live"><b><span class="lg-clock">' + esc(clock(g)) + '</span></b>' + (u ? '<span class="upset-pill">UPSET ALERT</span>' : '') + '</span>' + tv :
      // Upcoming: the kickoff on the left, where "Kickoff" used to be; the network stays top right.
      isPre ? '<b class="lg-kickoff">' +
        // ESPN marks a kickoff time that hasn't been set as midnight Eastern.
        wd + ', ' + (etTime(g.d) === '12:00 AM' ? 'time TBA' : etTime(g.d) + ' ET') + '</b>' + tv : '<span class="lg-live"><span class="final-pill">FINAL</span>' + (u ? '<span class="upset-pill">UPSET</span>' : '') + '</span><span class="lg-when">' + tv + '<span>' + wd + '</span></span>';
    return '<article class="lg' + (isLive ? ' on' : '') + '">' +
      '<div class="lg-top">' + top + '</div>' +
      (isPre ? '<div class="lg-rows pre"><span></span><span class="h">Win</span><span class="h">Make CFP</span><span class="h lg-if">If win</span><span class="h lg-if">If loss</span>' :
        '<div class="lg-rows inplay"><span></span><span class="h">Score</span><span class="h">' + (isLive ? 'Win' : '') + '</span><span class="h">Make CFP</span><span class="h lg-if">If win</span><span class="h lg-if">If loss</span>') +
        liveRow(g, g.a, isPre ? '' : g.as, isPre ? '' : g.hs) + liveRow(g, g.h, isPre ? '' : g.hs, isPre ? '' : g.as) +
      '</div>' +
    '</article>';
  }
  // Playoff impact on the Scores page, measured as total swing in Make CFP odds across every team.
  // Every game of today goes back to unplayed, so live scores don't count (a pre-game view):
  //  - a final: its real result against the game left open,
  //  - a live or later game: the home team winning against the away team winning.
  // All runs share one seed and the same game list (finals become locked games), so each difference comes
  // from that one game (common random numbers). Runs in its own worker after the main odds are ready.
  var SWING_SIMS = 5000;
  var SWING_TAIL = 'self.onmessage=function(e){var m=e.data;postMessage(CFP.measureSwings(m.D,m.mode,m.seed,m.sims,m.ids));};';
  // Results are remembered per ratings model and game list, so a week that's been measured never reshuffles.
  // The build measures the default ratings' current and next week ahead of time (g.sw), so those show their
  // final order straight away.
  // A game only counts as live within 6 hours of kickoff; a stale 'in' (caught mid-start by a build) reads as final.
  function liveNow(g) { return g.s === 'in' && Date.now() - Date.parse(g.d) < 6 * 3600000; }
  function sbStat(g) { return g.s === 'in' && !liveNow(g) ? 'post' : g.s; }
  var swings = { key: null, worker: null }, swingCache = {}, impactFrozen = null;
  function gameSwings(games) {
    if (!games.length) return null;
    var key = st.mode + '|' + games.map(function (g) { return g.id + g.s.charAt(0); }).sort().join(',');
    if (swingCache[key]) return swingCache[key];
    if (st.mode === D.swMode && games.every(function (g) { return g.sw != null && g.swS === g.s; })) {
      var pre = {};
      games.forEach(function (g) { pre[g.id] = g.sw; });
      return (swingCache[key] = pre);
    }
    if (swings.key === key) return null; // being measured
    if (swings.worker) swings.worker.terminate();
    swings = { key: key, worker: null };
    var data = D, ids = games.map(function (g) { return g.id; });
    try {
      var w = new Worker(URL.createObjectURL(new Blob(['importScripts(' + JSON.stringify(ENGINE_URL) + ');\n' + SWING_TAIL], { type: 'text/javascript' })));
      w.onmessage = function (e) {
        swingCache[key] = e.data;
        if (swings.key !== key) return;
        swings.worker = null; w.terminate();
        // A measured order is used next time this week is sorted; the list on screen stays put.
      };
      w.onerror = function () { if (swings.worker === w) swings.worker = null; };
      swings.worker = w;
      w.postMessage({ D: data, mode: st.mode, seed: CFP.seedFor(st.mode), sims: SWING_SIMS, ids: ids });
    } catch (err) {}
    return null;
  }
  // The Scores page's current week: the week under way, moving on to the next one as soon as every game of it
  // is over (final, or kicked off over 5 hours ago, so a postponed game can't hold it), e.g. Sunday morning
  // after Saturday's games, rather than waiting for next week's first kickoff.
  function scoreWeek() {
    var wk = weekGames().wk, now = Date.now(), counts = function (g) { return g.h < D.fbs || g.a < D.fbs; };
    var games = D.games.filter(function (g) { return g.wk === wk && counts(g); });
    var over = games.length && games.every(function (g) { return g.s === 'post' || Date.parse(g.d) < now - 5 * 3600000; });
    var later = D.games.filter(function (g) { return g.wk > wk && counts(g); });
    return over && later.length ? Math.min.apply(null, later.map(function (g) { return g.wk; })) : wk;
  }
  // The weeks on the Scores page, with their date range, e.g. "Week 10 · Nov 3–7".
  function scoreWeeks() {
    var m = {};
    D.games.forEach(function (g) {
      if (g.wk == null || (g.h >= D.fbs && g.a >= D.fbs)) return;
      var w = m[g.wk] = m[g.wk] || { wk: g.wk, first: g.d, last: g.d };
      if (g.d < w.first) w.first = g.d;
      if (g.d > w.last) w.last = g.d;
    });
    return Object.keys(m).map(function (k) { return m[k]; }).sort(function (x, y) { return x.wk - y.wk; });
  }
  function weekLabel(w) {
    function md(d) { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }); }
    var a = md(w.first), b = md(w.last);
    if (a === b) return 'Week ' + w.wk + ' · ' + a;
    if (a.split(' ')[0] === b.split(' ')[0]) b = b.split(' ')[1];
    return 'Week ' + w.wk + ' · ' + a + '–' + b;
  }
  // Live games first, then games still to come, then finals, for the chosen week; each group by start time
  // (the default) or by playoff impact.
  // With no week chosen it follows the current week, which moves on when next week's first game kicks off.
  // The Scores picker: a strip of weeks (seven around the chosen one, arrows to step a week), each with its
  // dates and number of games. It stands in for the Week dropdown, which stays in the page but hidden.
  function renderWeekStrip(el, weeks, selWk, curWk, count) {
    var at = Math.max(0, weeks.map(function (w) { return w.wk; }).indexOf(selWk)), cells = '';
    var md = function (d) { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }); };
    var range = function (w) { var a = md(w.first), b = md(w.last); if (a === b) return a; if (a.split(' ')[0] === b.split(' ')[0]) b = b.split(' ')[1]; return a + '\u2013' + b; };
    var arrow = function (dir) {
      var w = weeks[at + dir];
      return '<button type="button" class="day-arrow"' + (w ? ' data-week="' + w.wk + '"' : ' disabled') + ' aria-label="' + (dir < 0 ? 'Previous week' : 'Next week') + '">' + (dir < 0 ? '\u2039' : '\u203a') + '</button>';
    };
    for (var k = -3; k <= 3; k++) {
      var w = weeks[at + k], cls = Math.abs(k) === 3 ? ' far' : Math.abs(k) === 2 ? ' mid' : '';
      if (!w) { cells += '<button type="button" class="day-btn' + cls + '" disabled aria-hidden="true" tabindex="-1"></button>'; continue; }
      var n = count(w.wk);
      cells += '<button type="button" class="day-btn' + cls + (w.wk === curWk ? ' today' : '') + '" data-week="' + w.wk + '" aria-pressed="' + (k === 0) + '" aria-label="' + esc('Week ' + w.wk + ', ' + range(w) + (w.wk === curWk ? ' (current)' : '')) + '">' +
        '<span class="dw">Week ' + w.wk + '</span><span class="dd">' + esc(range(w)) + '</span><span class="dc">' + n + (n === 1 ? ' game' : ' games') + '</span></button>';
    }
    el.innerHTML = arrow(-1) + '<div class="day-cells">' + cells + '</div>' + arrow(1);
  }
  function weekStripEl(before, hide) {
    var el = $('day-strip');
    if (!el) {
      el = document.createElement('div'); el.id = 'day-strip'; el.className = 'day-strip week-strip'; el.setAttribute('role', 'group'); el.setAttribute('aria-label', 'Week');
      hide.hidden = true; before.parentNode.insertBefore(el, before);
    }
    return el;
  }
  function renderLive() {
    var weeks = scoreWeeks(), current = scoreWeek();
    var sel = st.sbWeek != null && weeks.some(function (w) { return w.wk === st.sbWeek; }) ? st.sbWeek : current;
    // The week strip sits on top, with the Conference and Sort row under it and the week's games below.
    renderWeekStrip(weekStripEl(document.querySelector('#page-scoreboard .sb-bar'), $('sb-week').closest('.filters')), weeks, sel, current,
      function (wk) { return D.games.filter(function (g) { return g.wk === wk && (g.h < D.fbs || g.a < D.fbs); }).length; });
    $('sb-week').innerHTML = weeks.map(function (w) {
      return '<option value="' + w.wk + '"' + (w.wk === sel ? ' selected' : '') + '>' + esc(weekLabel(w)) + (w.wk === current ? ' (current)' : '') + '</option>';
    }).join('');
    var sbConf = st.sbConf || '';
    var sbGroup = sbConf.indexOf('group:') === 0 ? sbConf.slice(6) : '';
    var inConf = function (g) {
      if (!sbConf) return true;
      var h = D.teams[g.h], a = D.teams[g.a];
      return sbGroup ? (g.h < D.fbs && inGroup(h, sbGroup)) || (g.a < D.fbs && inGroup(a, sbGroup)) : h.conf === sbConf || a.conf === sbConf;
    };
    var inWeek = function (g) { return g.wk === sel && (g.h < D.fbs || g.a < D.fbs); };
    var counts = function (g) { return inWeek(g) && inConf(g); };
    var R = res();
    var best = function (g) { return Math.max(g.h < D.fbs ? R.teams[g.h].cfp : 0, g.a < D.fbs ? R.teams[g.a].cfp : 0); };
    var byTime = st.sbSort !== 'impact'; // Start time is the default
    [].forEach.call(document.querySelectorAll('#sb-sort button'), function (b) { b.setAttribute('aria-pressed', (b.dataset.sbsort === 'impact') !== byTime); });
    var kickoff = function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; };
    var order = function (a, b) { return kickoff(a, b) || best(b) - best(a); };
    // Playoff impact: your picks first, then the biggest swing. Worked out once and then left in that order
    // (games going live or final, new odds or picks don't reshuffle it) until the sort, week, conference or
    // ratings change.
    if (!byTime) {
      // Pre-game swing for every game that week, once measured; until then the gap between winning and losing stands in.
      var sw = gameSwings(D.games.filter(inWeek));
      // A game still to be decided counts by how likely its swing is: the win-or-lose gap times 4p(1 - p), which is
      // 1 for a toss-up and falls towards 0 as one result becomes near certain. A final keeps its real swing.
      var likely = function (g) { if (g.s === 'post') return 1; var p = pregameHome(g); return 4 * p * (1 - p); };
      // Sorted before a newly chosen model's odds were in, it sorts once more when they land; never after that.
      var fkey = sel + '|' + sbConf + '|' + st.mode, ready = !!results[st.mode];
      if (!impactFrozen || impactFrozen.key !== fkey || (!impactFrozen.ready && ready)) {
        var val = function (g) { return (st.picks[g.id] ? 10 : 0) + (sw ? sw[g.id] || 0 : gameStakesSum(g)) * likely(g); };
        impactFrozen = { key: fkey, ready: ready, pos: {} };
        D.games.filter(counts).sort(function (a, b) { return val(b) - val(a) || kickoff(a, b); }).forEach(function (g, n) { impactFrozen.pos[g.id] = n; });
      }
      var pos = impactFrozen.pos;
      order = function (a, b) { return (pos[a.id] == null ? 1e4 : pos[a.id]) - (pos[b.id] == null ? 1e4 : pos[b.id]) || kickoff(a, b); };
    }
    // Under either sort: live games first, then the games still to come and the finals, each under its day.
    var live = D.games.filter(function (g) { return sbStat(g) === 'in' && counts(g); }).sort(order);
    var later = D.games.filter(function (g) { return sbStat(g) === 'pre' && counts(g); }).sort(order);
    var done = D.games.filter(function (g) { return sbStat(g) === 'post' && counts(g); }).sort(order);
    function group(title, games, note) {
      return games.length ? '<div class="live-group">' + (title ? '<h4>' + title + '</h4>' : '') + (note ? '<p class="live-note">' + note + '</p>' : '') + '<div class="live-grid">' + games.map(liveCard).join('') + '</div></div>' : '';
    }
    var next = D.games.filter(function (g) { return g.s === 'pre' && (g.h < D.fbs || g.a < D.fbs) && inConf(g); }).sort(kickoff)[0];
    var nextText = next ? 'Next kickoff: ' + new Date(next.d).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET.' : '';
    var note = byTime ? 'Earliest kickoff first.' : '';
    var who = sbConf ? esc(sbGroup ? GROUP_NAME[sbGroup] : CFP.CONF_NAME[sbConf] || sbConf) + ' ' : '';
    // Only a failed ESPN check is worth a line here.
    $('live-head').innerHTML = st.live === 'blocked' ? '<p class="live-note"><b>Couldn’t reach ESPN.</b> Showing the saved scores.</p>' : '';
    // Upcoming and final games under a heading per day, in the chosen order within each day.
    function byDay(games, tag, note) {
      var keys = [], m = {};
      games.forEach(function (g) { var k = etDay(g.d); if (!m[k]) { m[k] = []; keys.push(k); } m[k].push(g); });
      return keys.sort().map(function (k, n) {
        var label = new Date(m[k][0].d).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
        return group(label + (tag ? ' · ' + tag : ''), m[k], n === 0 ? note : '');
      }).join('');
    }
    $('live-board').innerHTML =
      (live.length || later.length || done.length ?
        group(live.length ? 'In progress' : '', live, note) + byDay(later, '', live.length ? '' : note) + byDay(done, 'Final', live.length || later.length ? '' : note) :
        '<p class="live-empty">No ' + who + 'games this week.' + (nextText ? ' ' + nextText : '') + '</p>');
  }
  // Views: Rankings (default), Playoff and Scoreboard, chosen by the address's #. About is its own page.
  var PAGES = { rankings: 'Playoff Odds Board', playoff: 'Playoff bracket · Playoff Odds Board', scoreboard: 'Scores · Playoff Odds Board', team: 'Team · Playoff Odds Board' };
  var INTRO = {
    rankings: ['College Football Playoff odds', 'Each team’s chance of making the 12-team playoff, from simulating every remaining game, conference title game and committee ranking.'],
    playoff: ['Projected playoff', 'The most likely 12-team field in its bracket. Simulate the games to see who’s favored in each round.'],
    scoreboard: ['Scores', 'Today\u2019s games, with each team\u2019s win chance and what the result means for its playoff odds.'],
    team: ['Team', 'One team\u2019s schedule, scores and playoff odds.']
  };
  var OLD_HASH = { odds: 'rankings', live: 'scoreboard', scores: 'scoreboard', history: 'rankings' }; // names used by earlier versions of the site
  function showPage() {
    var hash = location.hash.replace('#', ''), p = OLD_HASH[hash] || hash;
    if (hash === 'about') { location.replace('about.html'); return hash; } // older links
    // A team's page: #team/<name> for this season, #team/<name>/history for its all-time history. A name that
    // isn't a team's goes to the table of all teams.
    var tm = /^team\/([^/]*)(?:\/(history))?\/?$/.exec(hash), ti = null;
    if (tm) { try { ti = slugs().at[decodeURIComponent(tm[1]).toLowerCase()]; } catch (e) {} p = ti == null ? 'rankings' : 'team'; }
    else if (!PAGES[p] || p === 'team') p = 'scoreboard'; // Scores is the landing view
    st.teamView = tm && tm[2] ? 'history' : 'season';
    var team = p === 'team' ? D.teams[ti] : null;
    if (team) st.team = team.id;
    Object.keys(PAGES).forEach(function (k) { $('page-' + k).hidden = k !== p; });
    [].forEach.call(document.querySelectorAll('.tabs a'), function (a) {
      // A team's page sits under Rankings.
      if (a.dataset.page === (team ? 'rankings' : p)) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    // Each view gets its own title and intro.
    var hist = !!team && st.teamView === 'history';
    document.title = team ? team.name + (hist ? ' history' : ' playoff odds') + ' · Playoff Odds Board' : PAGES[p];
    $('page-title').textContent = team ? team.name + (hist ? ' history' : ' playoff odds') : INTRO[p][0];
    if (team) {
      // The two views of a team, as buttons at the top of its page. The ratings menu only matters for this season.
      var href = teamHref(ti), view = function (v, label, to) { return '<a href="' + to + '"' + (st.teamView === v ? ' aria-current="page"' : '') + '>' + label + '</a>'; };
      $('tp-views').innerHTML = view('season', 'This season', href) + view('history', 'History', href + '/history');
      $('mode-team-ctl').hidden = hist;
      if (!hist) $('team-history-wrap').hidden = true;
      renderTeam();
    }
    // The History view: the team's all-time Elo history; its data loads the first time one opens.
    if (hist && window.EloHistory) {
      var ehv = (((document.querySelector('script[src*="js/app.js"]') || {}).src || '').split('?v=')[1] || D.asOf);
      EloHistory.show({ root: 'team-history', wrap: 'team-history-wrap', side: 'tp-hist-side', team: team.id, file: 'cfb-elo.json?v=' + encodeURIComponent(ehv), detail: 'elo/cfb/', ver: ehv, noun: 'FBS' });
    }
    return hash;
  }
  window.addEventListener('hashchange', function () {
    showPage();
    window.scrollTo(0, 0);
  });
  function renderStatus() {
    var as = new Date(D.asOf).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
    var left = D.games.filter(function (g) { return g.s !== 'post'; }).length, inp = D.games.filter(function (g) { return g.s === 'in'; }).length;
    var liveMsg = st.live === 'on' ? '<b>Live ESPN data</b> loaded ' + as + ' ET' :
      st.live === 'blocked' ? '<b>Couldn’t reach ESPN.</b> Showing the saved data from ' + as + ' ET' :
      st.live === 'pending' ? '<b>Checking ESPN…</b> Showing the saved data from ' + as + ' ET' :
      st.live === 'same' ? '<b>ESPN checked</b>, no new results since ' + as + ' ET' : '<b>ESPN snapshot</b> from ' + as + ' ET';
    $('status').innerHTML = '<span>' + liveMsg + '</span><span>' + left + ' games left' + (inp ? ', ' + inp + ' in progress' : '') + '</span>' +
      '<span>' + esc(D.rankLabel ? D.rankLabel.replace(/^.*- /, '') : 'CFP rankings') + '</span><span><b>' + res().sims.toLocaleString() + '</b> simulated seasons</span>';
  }
  function renderPicksBar() {
    var n = Object.keys(st.picks).length;
    $('picks-bar').innerHTML = n
      ? '<span><b>' + n + (n === 1 ? ' game' : ' games') + ' picked.</b> All odds assume ' + (n === 1 ? 'that result' : 'those results') + '.' + rkNote() + '</span><button class="btn" id="clear-picks" type="button">Clear picks</button>'
      : '<span>Press a team\u2019s box to cycle its game this week through <b>W</b>, <b>L</b> and blank. Its opponent gets the opposite result, and all odds update. Finished games show the result.' + rkNote() + '</span>';
  }
  function renderAll() { renderPicksBar(); renderStatus(); renderLive(); renderField(); renderBracket(); renderTable(); renderTeam(); }

  function renderModes() {
    function option(k, label) { return '<option value="' + k + '"' + (st.mode === k ? ' selected' : '') + '>' + esc(label) + '</option>'; }
    var groups = '<optgroup label="Averages">' + option('blend', 'Massey + Sagarin') + option('all', 'All models average') + '</optgroup>';
    ['Point-based', 'Recent form', 'Results only'].forEach(function (g) {
      groups += '<optgroup label="' + g + '">' + D.sources.models.filter(function (m) { return m.group === g; }).map(function (m) { return option(m.k, m.label); }).join('') + '</optgroup>';
    });
    [].forEach.call(document.querySelectorAll('.mode-select'), function (s) { s.innerHTML = groups; });
  }
  function setProgress(p, text) {
    // Minute-by-minute score checks update quietly, without dimming the table.
    if (p == null) st.quiet = false;
    else if (st.quiet) return;
    $('progress').hidden = p == null;
    $('top-controls').hidden = p == null;
    if (p != null) { $('fill').style.width = (p * 100).toFixed(0) + '%'; $('progress-text').textContent = text; }
    $('tw').classList.toggle('busy', p != null);
  }
  // The worker loads the same engine file this page uses.
  var ENGINE_URL = new URL(document.querySelector('script[src*="engine.js"]').getAttribute('src'), location.href).href;
  var WORKER_TAIL = 'self.onmessage=function(e){var m=e.data,P=CFP.prep(m.D,m.mode,m.picks),sim=new CFP.Sim(P,m.seed),t=CFP.emptyTally(P.n),min=800,done=0;' +
    'while(done<m.sims){var c=Math.min(1000,m.sims-done);CFP.baseBatch(sim,t,c);done+=c;if(done%4000===0)postMessage({p:done/m.sims*.8});}' +
    'var jobs=CFP.forcedJobs(P,t,min),forced={};jobs.forEach(function(j,i){forced[j.t]=CFP.forcedRun(sim,j,1000);if(i%5===0)postMessage({p:.8+.2*i/jobs.length});});' +
    'postMessage({result:{sims:m.sims,mode:m.mode,teams:CFP.summarize(P,t,forced,min),rating:Array.prototype.slice.call(P.R.subarray(0,P.fbs))}});};';
  function runJob(mode, picks, done) {
    // The same seed for every run of this model, so picks and live updates only move what they affect.
    var sims = SIMS, seed = CFP.seedFor(mode), id = ++jobId;
    if (worker) worker.terminate();
    worker = null;
    setProgress(0, 'Simulating ' + sims.toLocaleString() + ' seasons\u2026');
    var data = st.pendingD || D;
    function finish(result) {
      if (id !== jobId) return;
      // New ESPN data can reorder teams, so it replaces the old data only once its results exist.
      if (data !== D) {
        D = data; st.pendingD = null; schedCache = {}; results = {}; pickResults = {}; st.live = 'on';
        var open = {};
        D.games.forEach(function (g) { if (g.s !== 'post') open[g.id] = 1; });
        D.titles.forEach(function (t) { if (!titleOver(t)) open['ccg:' + t.conf] = 1; });
        Object.keys(st.picks).forEach(function (k) { if (!open[k]) delete st.picks[k]; }); // that game has finished
      }
      lastRes = result;
      worker = null;
      done(result);
    }
    try {
      worker = new Worker(URL.createObjectURL(new Blob(['importScripts(' + JSON.stringify(ENGINE_URL) + ');\n' + WORKER_TAIL], { type: 'text/javascript' })));
      worker.onmessage = function (e) {
        if (e.data.result) finish(e.data.result);
        else setProgress(e.data.p, 'Simulating ' + sims.toLocaleString() + ' seasons\u2026');
      };
      worker.onerror = function () { worker = null; setTimeout(function () { finish(CFP.runAll(data, mode, sims, seed, 1000, picks)); }, 30); };
      worker.postMessage({ D: data, mode: mode, sims: sims, seed: seed, picks: picks });
    } catch (err) {
      setTimeout(function () { finish(CFP.runAll(data, mode, sims, seed, 1000, picks)); }, 30);
    }
  }
  // Makes sure the baseline and any picked scenario exist for the current ratings, then draws.
  function refresh() {
    var m = st.mode;
    if (st.pendingD || !results[m]) return runJob(m, null, function (r) { results[m] = r; refresh(); });
    if (hasPicks()) {
      var key = picksKey();
      if (!pickResults[key]) return runJob(m, JSON.parse(JSON.stringify(st.picks)), function (r) { pickResults[key] = r; refresh(); });
    }
    jobId++;
    if (worker) { worker.terminate(); worker = null; }
    setProgress(null);
    renderAll();
    saveLive();
  }

  // Try ESPN directly. This works from a local copy of the file; the published viewer refuses it.
  var liveRaw = { weeks: {}, rankings: null, standings: null }, liveBusy = false;
  // auto: a minute-by-minute check. It reuses finished weeks and standings, so only active weeks are fetched.
  function tryLive(auto) {
    if (liveBusy) return;
    liveBusy = true;
    if (auto) st.quiet = true;
    var API = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';
    var get = function (u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); };
    var kept = function (val, u) { return val ? Promise.resolve(val) : get(u); };
    kept(auto && liveRaw.rankings, API + '/rankings').then(function (r) { return CFP.withCfp(r, D.season, get); }).then(function (rankings) {
      liveRaw.rankings = rankings;
      var wk = [];
      for (var w = 1; w <= 15; w++) (function (week) {
        wk.push(kept(liveRaw.weeks[week], API + '/scoreboard?groups=80&limit=400&week=' + week + '&seasontype=2&dates=' + D.season).then(function (data) {
          var ev = data.events || [];
          if (ev.length && ev.every(function (e) { return e.status && e.status.type && e.status.type.completed; })) liveRaw.weeks[week] = data;
          return data;
        }));
      })(w);
      var fpi = auto ? null : get('https://site.web.api.espn.com/apis/fitt/v3/sports/football/college-football/powerindex?season=' + D.season + '&limit=200&region=us&lang=en').catch(function () { return null; });
      return Promise.all([Promise.all(wk), kept(liveRaw.standings, 'https://site.web.api.espn.com/apis/v2/sports/football/college-football/standings?group=80&season=' + D.season + '&level=3'), fpi]).then(function (x) {
        liveRaw.standings = x[1];
        var fresh = CFP.parseEspn({ weeks: x[0], rankings: rankings, standings: x[1] });
        var byId = {}; D.teams.forEach(function (t) { byId[t.id] = t; });
        fresh.teams.forEach(function (t) {
          var old = byId[t.id];
          t.r = old ? old.r : { massey: 28, sagarin: 45, predictor: 45 };
        });
        fresh.sources = D.sources;
        fresh.ap = D.ap;
        fresh.swMode = D.swMode;
        var oldGame = {}; D.games.forEach(function (g) { oldGame[g.id] = g; });
        fresh.games.forEach(function (g) { var o = oldGame[g.id]; if (o && o.sw != null) { g.sw = o.sw; g.swS = o.swS; } });
        // Teams share their rating objects with D, so new FPI values reach both copies.
        var fpiFresh = x[2] && CFP.applyFpi(fresh, x[2]);
        if (fpiFresh) { delete results.fpi; delete results.all; pickResults = {}; }
        var count = function (d, s) { return d.games.filter(function (g) { return g.s === s; }).length; };
        var changed = count(fresh, 'post') !== count(D, 'post') || count(fresh, 'in') > 0 || count(D, 'in') > 0 || fresh.rankDate !== D.rankDate;
        if (!changed) {
          st.live = 'same';
          st.quiet = false;
          renderStatus();
          renderLive();
          saveLive();
          if (fpiFresh && (st.mode === 'fpi' || st.mode === 'all' || hasPicks())) refresh();
          return;
        }
        fresh.season = D.season; fresh.asOf = new Date().toISOString();
        // The odds-over-time history comes from the build, indexed by team: carry it over by team id.
        if (D.hist) { var histAt = {}; D.teams.forEach(function (t, k) { histAt[t.id] = k; }); fresh.hist = Object.assign({}, D.hist, { v: fresh.teams.map(function (t) { var k = histAt[t.id]; return k == null ? null : D.hist.v[k] || null; }) }); }
        st.pendingD = fresh;
        refresh();
      });
    }).catch(function () { st.live = 'blocked'; st.quiet = false; renderStatus(); renderLive(); }).then(function () { liveBusy = false; });
  }
  // Check again only when a game is on, or should have kicked off by now.
  function gamesActive() {
    var now = Date.now();
    return D.games.some(function (g) { return g.s === 'in' || (g.s === 'pre' && Date.parse(g.d) <= now); });
  }
  setInterval(function () {
    if (!document.hidden && !st.pendingD && gamesActive()) tryLive(true);
  }, 60000);
  // Coming back to the tab catches up right away instead of waiting for the next minute.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && !st.pendingD && gamesActive()) tryLive(true);
  });

  // Controls
  // A click anywhere else closes an open Conference picker. So do Escape and Tab, and the arrow keys walk its list.
  document.addEventListener('click', function (e) { if (st.pickOpen && !e.target.closest('.pick')) closePicker(false); });
  document.addEventListener('keydown', function (e) {
    if (!st.pickOpen) return;
    var opts = [].slice.call($(st.pickOpen).querySelectorAll('.pick-opt')), at = opts.indexOf(document.activeElement);
    var to = e.key === 'ArrowDown' ? Math.min(opts.length - 1, at + 1) : e.key === 'ArrowUp' ? Math.max(0, at - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? opts.length - 1 : -1;
    if (e.key === 'Escape') { closePicker(true); e.preventDefault(); }
    else if (e.key === 'Tab') closePicker(true); // the keyboard moves on from the button, as it would from a select
    else if (to >= 0) { opts[to].focus(); e.preventDefault(); }
  });
  document.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.picker) { if (st.pickOpen === b.dataset.picker) closePicker(true); else openPicker(b.dataset.picker); return; }
    if (b.dataset.pickValue != null) {
      // A choice in a Conference picker: the Rankings table's, or the Scores page's.
      var pid = b.closest('.pick').id, pv = b.dataset.pickValue;
      if (pid !== 'conf') st.sbConf = pv;
      else if (pv.indexOf('group:') === 0) { st.view = pv.slice(6); st.conf = ''; }
      else { st.view = 'all'; st.conf = pv; }
      closePicker(true);
      if (pid === 'conf') renderTable(); else renderLive();
      return;
    }
    if (b.dataset.sbsort) { st.sbSort = b.dataset.sbsort; impactFrozen = null; renderLive(); return; }
    if (b.dataset.week) { st.sbWeek = +b.dataset.week === scoreWeek() ? null : +b.dataset.week; impactFrozen = null; renderLive(); return; }
    if (b.dataset.sort) {
      var k = b.dataset.sort;
      if (st.sort === k) st.dir = -st.dir; else { st.sort = k; st.dir = k === 'seed' || k === 'team' || k === 'proj' || k === 'rating' || k === 'conf' ? 1 : -1; }
      st.lockOrder = null;
      renderTable();
    } else if (b.dataset.view) {
      st.view = b.dataset.view;
      renderViewControls();
      renderTable();
    } else if (b.dataset.pick) {
      lockOrder();
      // Each press moves this team through blank, win, loss and back to blank.
      // A conference title pick before the matchup is set has no opponent: it moves through win and blank,
      // and picking a team replaces another team's pick in that conference.
      var current = st.picks[b.dataset.pick], team = b.dataset.team, opp = b.dataset.opp;
      if (!current || (!opp && current !== team)) st.picks[b.dataset.pick] = team;
      else if (current === team && opp) st.picks[b.dataset.pick] = opp;
      else delete st.picks[b.dataset.pick];
      st.quiet = false;
      renderPicksBar();
      renderLive();
      renderField();
      renderTable();
      renderTeam();
      // A short pause lets several picks in a row share one simulation.
      setProgress(0, 'Simulating\u2026');
      clearTimeout(pickTimer);
      pickTimer = setTimeout(refresh, 250);
    } else if (b.id === 'clear-picks' || b.dataset.clearpicks) {
      st.picks = {};
      st.lockOrder = null;
      clearTimeout(pickTimer);
      refresh();
    } else if (b.dataset.bk) {
      // Like the Rankings table, each press cycles this team through W, L and blank (its opponent gets the opposite).
      var seed = +b.dataset.seed, opp = +b.dataset.opp, cur = st.bkPicks[b.dataset.bk];
      if (cur == null) st.bkPicks[b.dataset.bk] = seed; else if (cur === seed) st.bkPicks[b.dataset.bk] = opp; else delete st.bkPicks[b.dataset.bk];
      renderBracket();
    } else if (b.id === 'expand-table') {
      // Phones: switch between the compact table and every column.
      st.expanded = !st.expanded;
      b.setAttribute('aria-pressed', st.expanded);
      b.textContent = st.expanded ? 'Show fewer columns' : 'Show all columns';
      document.querySelector('.odds-table').classList.toggle('expanded', st.expanded);
      renderTable();
    } else if (b.id === 'bk-clear') {
      st.bkPicks = {};
      renderBracket();
    } else if (b.id === 'bk-sim') {
      st.bkSim = !st.bkSim;
      renderBracket();
    } else if (b.dataset.field || b.id === 'field-close') {
      var fieldId = b.dataset.field || st.fieldOpen;
      st.fieldOpen = st.fieldOpen === fieldId ? null : fieldId;
      renderField();
      // Redrawing replaces the buttons, so keyboard focus goes back to this team.
      var fieldBtn = $('seeds').querySelector('[data-field="' + fieldId + '"]');
      if (fieldBtn) fieldBtn.focus();
    }
  });
  document.addEventListener('change', function (e) {
    var id = e.target.id;
    if (id === 'sb-week') { st.sbWeek = +e.target.value === scoreWeek() ? null : +e.target.value; renderLive(); }
    else if (e.target.classList.contains('mode-select')) {
      st.mode = e.target.value;
      [].forEach.call(document.querySelectorAll('.mode-select'), function (s) { s.value = st.mode; });
      st.quiet = false;
      st.lockOrder = null;
      clearTimeout(pickTimer);
      refresh();
    }
  });

  showPage();
  renderModes();
  renderViewControls();
  renderScoreboardControls();
  loadLive();
  renderAll();
  st.quiet = true; // the first ESPN refresh + re-sim runs in the background; the preloaded odds stay on screen
  tryLive();
  // Dark and light logos differ, so redraw when the theme changes (the Conference pickers too, for theirs).
  function retheme() { renderViewControls(); renderScoreboardControls(); renderAll(); }
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', retheme); } catch (x) {}
  try { WIDE.addEventListener('change', renderTable); } catch (x) {}
  // js/theme.js sets data-theme when the button is pressed.
  new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
})();
