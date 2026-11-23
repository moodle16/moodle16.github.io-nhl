// Stiahne tabuľku NHL a pre každý tím všetky zápasy sezóny so skóre 1. tretiny + najbližší zápas.
//
// Zdroje (api-web.nhle.com/v1):
//   /standings/now                     – tabuľka, poradie v konferencii
//   /club-schedule-season/{TÍM}/now    – všetky zápasy tímu, konečné skóre, typ konca (REG/OT/SO)
//   /gamecenter/{id}/right-rail        – linescore.byPeriod = góly po tretinách (hlavný zdroj)
//   /gamecenter/{id}/landing           – summary.scoring = zoznam gólov (druhá, nezávislá kontrola)
//
// Kontroly pri každom zápase (ak čokoľvek nesedí, zápas je "neoverený"):
//   1. súčet gólov po tretinách (vrátane predĺženia, bez nájazdov) = konečné skóre
//      (pri nájazdoch: tretiny+OT musia byť nerozhodne a víťaz má v konečnom skóre +1)
//   2. 1. tretina z right-rail = počet gólov v 1. tretine zo zoznamu gólov (landing)
//
// Už odohraté a overené zápasy sa berú z existujúceho data.json, sťahujú sa len nové.

import { readFile, writeFile } from 'node:fs/promises';

const API = 'https://api-web.nhle.com/v1';
const OUT = new URL('../data.json', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inActions = !!process.env.GITHUB_ACTIONS;

async function getJson(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'nhl-1-tretina/2.0' } });
      if (res.ok) return await res.json();
      if (res.status === 404) return null;
      console.warn(`HTTP ${res.status} pre ${url}`);
    } catch (e) {
      console.warn(`Chyba ${e.message} pre ${url}`);
    }
    await sleep(1500 * i);
  }
  return null;
}

function warn(msg) {
  // V GitHub Actions sa varovanie zobrazí aj v súhrne behu.
  console.warn(inActions ? `::warning::${msg}` : `VAROVANIE: ${msg}`);
}

const abbr = (x) => (typeof x === 'string' ? x : x?.default);

// ---------- 1. tabuľka ----------
const standingsRaw = await getJson(`${API}/standings/now`);
if (!standingsRaw?.standings?.length) {
  console.error('Nepodarilo sa stiahnuť tabuľku, data.json sa nemení.');
  process.exit(1);
}

const standings = standingsRaw.standings
  .map((t) => ({
    abbrev: abbr(t.teamAbbrev),
    name: abbr(t.teamName),
    short: abbr(t.teamCommonName),
    conference: t.conferenceName,
    division: t.divisionName,
    confRank: t.conferenceSequence,
    leagueRank: t.leagueSequence,
  }))
  .filter((t) => t.abbrev)
  .sort((a, b) => a.leagueRank - b.leagueRank);

// ---------- 2. predchádzajúce dáta (cache) ----------
let old = {};
try {
  old = JSON.parse(await readFile(OUT, 'utf8'));
} catch {
  console.log('Predchádzajúci data.json nenájdený alebo v starom formáte – sťahujem všetko.');
}
const oldGames = old.version === 2 && old.games ? old.games : {};
const oldTeams = old.version === 2 && old.teams ? old.teams : {};

// ---------- 3. rozpisy tímov ----------
const PLAYED = new Set(['OFF', 'FINAL']);
const schedById = new Map(); // id -> záznam z rozpisu
const schedByTeam = {}; // abbrev -> [id...]
for (const t of standings) {
  const sched = await getJson(`${API}/club-schedule-season/${t.abbrev}/now`);
  if (!sched?.games) {
    warn(`Rozpis pre ${t.abbrev} chýba – použijem staré dáta tímu.`);
    continue;
  }
  const games = sched.games.filter((g) => g.gameType === 2 || g.gameType === 3);
  schedByTeam[t.abbrev] = games.map((g) => g.id);
  for (const g of games) schedById.set(g.id, g);
  await sleep(100);
}

// ---------- 4. skóre po tretinách ----------
function goalsByPeriodFromLanding(landing, home, away) {
  // { číslo tretiny: [domáci, hostia] } – bez nájazdov
  const scoring = landing?.summary?.scoring;
  if (!Array.isArray(scoring)) return null;
  const out = {};
  for (const p of scoring) {
    const pd = p.periodDescriptor ?? {};
    if (pd.periodType === 'SO') continue;
    let h = 0;
    let a = 0;
    for (const g of p.goals ?? []) {
      const ab = abbr(g.teamAbbrev);
      if (ab === home) h++;
      else if (ab === away) a++;
    }
    out[pd.number] = [h, a];
  }
  return out;
}

async function analyzeGame(g) {
  const home = g.homeTeam?.abbrev;
  const away = g.awayTeam?.abbrev;
  const [rr, landing] = [
    await getJson(`${API}/gamecenter/${g.id}/right-rail`),
    await getJson(`${API}/gamecenter/${g.id}/landing`),
  ];
  const notes = [];

  // góly po tretinách z right-rail (bez nájazdov)
  let periods = null;
  const byPeriod = rr?.linescore?.byPeriod;
  if (Array.isArray(byPeriod) && byPeriod.length) {
    periods = byPeriod
      .filter((p) => p.periodDescriptor?.periodType !== 'SO')
      .map((p) => ({ n: p.periodDescriptor?.number, h: Number(p.home), a: Number(p.away) }));
  }
  const fromLanding = goalsByPeriodFromLanding(landing, home, away);
  if (!periods && fromLanding) {
    notes.push('right-rail bez linescore, použitý zoznam gólov');
    periods = Object.entries(fromLanding).map(([n, [h, a]]) => ({ n: Number(n), h, a }));
  }

  const end = g.gameOutcome?.lastPeriodType ?? landing?.periodDescriptor?.periodType ?? null;
  const finH = g.homeTeam?.score ?? rr?.linescore?.totals?.home;
  const finA = g.awayTeam?.score ?? rr?.linescore?.totals?.away;

  const p1 = periods?.find((p) => p.n === 1);
  let ok = !!p1 && Number.isFinite(p1.h) && Number.isFinite(p1.a);
  if (!p1) notes.push('chýba 1. tretina');

  if (ok) {
    // kontrola 1: súčet tretín (+OT) vs. konečné skóre
    const sumH = periods.reduce((s, p) => s + p.h, 0);
    const sumA = periods.reduce((s, p) => s + p.a, 0);
    if (finH == null || finA == null) {
      ok = false;
      notes.push('chýba konečné skóre');
    } else if (end === 'SO') {
      const winH = finH > finA;
      const good = sumH === sumA && (winH ? finH === sumH + 1 && finA === sumA : finA === sumA + 1 && finH === sumH);
      if (!good) {
        ok = false;
        notes.push(`nájazdy: súčet tretín ${sumH}:${sumA} nesedí s konečným ${finH}:${finA}`);
      }
    } else if (sumH !== finH || sumA !== finA) {
      ok = false;
      notes.push(`súčet tretín ${sumH}:${sumA} ≠ konečné skóre ${finH}:${finA}`);
    }
    // kontrola 2: 1. tretina z linescore vs. zoznam gólov
    const l1 = fromLanding?.[1];
    if (!l1) {
      ok = false;
      notes.push('zoznam gólov (landing) nedostupný');
    } else if (l1[0] !== p1.h || l1[1] !== p1.a) {
      ok = false;
      notes.push(`1. tretina: linescore ${p1.h}:${p1.a} ≠ zoznam gólov ${l1[0]}:${l1[1]}`);
    }
  }

  await sleep(100);
  return {
    d: g.gameDate,
    t: g.startTimeUTC ?? null,
    h: home,
    a: away,
    st: g.gameState,
    end,
    p1: p1 ? [p1.h, p1.a] : null,
    per: periods ? periods.map((p) => [p.h, p.a]) : null,
    fin: finH != null && finA != null ? [finH, finA] : null,
    ok,
    ...(notes.length ? { note: notes.join('; ') } : {}),
  };
}

const games = {};
let fetched = 0;
let reused = 0;
const unverified = [];
const playedIds = [...schedById.values()]
  .filter((g) => PLAYED.has(g.gameState))
  .sort((a, b) => a.gameDate.localeCompare(b.gameDate))
  .map((g) => g.id);

for (const id of playedIds) {
  const g = schedById.get(id);
  const cached = oldGames[id];
  // Z cache berieme len definitívne (OFF) a overené zápasy; ostatné skúsime znova.
  if (cached && cached.st === 'OFF' && cached.ok && g.gameState === 'OFF') {
    games[id] = cached;
    reused++;
    continue;
  }
  const res = await analyzeGame(g);
  fetched++;
  if (!res.p1 && cached?.p1) {
    // API zlyhalo – radšej ponecháme staré dáta
    games[id] = cached;
  } else {
    games[id] = res;
  }
  if (!games[id].ok) unverified.push(id);
}

for (const id of unverified) {
  const x = games[id];
  warn(`Neoverený zápas ${id} (${x.d} ${x.a} @ ${x.h}): ${x.note ?? 'neznámy dôvod'}`);
}

// ---------- 5. pohľad tímov ----------
const teams = {};
for (const t of standings) {
  const ids = schedByTeam[t.abbrev];
  if (!ids) {
    if (oldTeams[t.abbrev]) teams[t.abbrev] = oldTeams[t.abbrev];
    continue;
  }
  const list = [];
  let next = null;
  for (const id of ids) {
    const g = schedById.get(id);
    const home = g.homeTeam?.abbrev === t.abbrev;
    const opp = home ? g.awayTeam?.abbrev : g.homeTeam?.abbrev;
    if (PLAYED.has(g.gameState)) {
      const x = games[id];
      let s = null;
      let r = null;
      if (x?.p1) {
        const mine = home ? x.p1[0] : x.p1[1];
        const theirs = home ? x.p1[1] : x.p1[0];
        s = `${mine}:${theirs}`;
        r = mine > theirs ? 'V' : mine < theirs ? 'P' : 'R';
      }
      list.push({ id, d: g.gameDate, o: opp, h: home, s, r, ok: !!x?.ok });
    } else if (!next || g.gameDate < next.d) {
      next = { id, d: g.gameDate, t: g.startTimeUTC ?? null, o: opp, h: home, st: g.gameState };
    }
  }
  list.sort((a, b) => a.d.localeCompare(b.d));
  teams[t.abbrev] = { games: list, next };
}

await writeFile(
  OUT,
  JSON.stringify({
    version: 2,
    updated: new Date().toISOString(),
    season: standingsRaw.standings[0]?.seasonId ?? null,
    standings,
    teams,
    games,
    unverified,
  }),
);
console.log(
  `Hotovo: ${standings.length} tímov, ${playedIds.length} odohratých zápasov ` +
    `(nových/znova stiahnutých ${fetched}, z cache ${reused}), neoverených ${unverified.length}.`,
);
