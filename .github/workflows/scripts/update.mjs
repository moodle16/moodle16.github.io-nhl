// Stiahne tabuľku NHL a pre každý tím posledných 5 zápasov (1. tretina) + najbližší zápas.
import { writeFile } from 'node:fs/promises';

const API = 'https://api-web.nhle.com/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'nhl-stranka/1.0' } });
      if (res.ok) return await res.json();
      console.warn(`HTTP ${res.status} pre ${url}`);
    } catch (e) {
      console.warn(`Chyba ${e.message} pre ${url}`);
    }
    await sleep(1000 * i);
  }
  return null;
}

function fromLinescore(d) {
  const periods = d?.summary?.linescore?.byPeriod ?? d?.linescore?.byPeriod ?? [];
  for (const p of periods) {
    if (p?.periodDescriptor?.number === 1 && p.away != null && p.home != null) {
      return { away: Number(p.away), home: Number(p.home) };
    }
  }
  return null;
}

function fromScoring(d) {
  const scoring = d?.summary?.scoring;
  if (!Array.isArray(scoring) || !scoring.length) return null;
  const home = d.homeTeam?.abbrev;
  const away = d.awayTeam?.abbrev;
  if (!home || !away) return null;
  const p1 = scoring.find((s) => s?.periodDescriptor?.number === 1);
  if (!p1) {
    return scoring.some((s) => (s?.periodDescriptor?.number ?? 0) >= 2) ? { away: 0, home: 0 } : null;
  }
  let h = 0;
  let a = 0;
  for (const g of p1.goals ?? []) {
    const ab = g?.teamAbbrev?.default ?? g?.teamAbbrev;
    if (ab === home) h++;
    else if (ab === away) a++;
  }
  return { away: a, home: h };
}

function fromPbp(d) {
  const plays = d?.plays;
  if (!Array.isArray(plays) || !plays.length) return null;
  let home = 0;
  let away = 0;
  for (const p of plays) {
    if (p?.typeDescKey === 'goal' && p?.periodDescriptor?.number === 1 && p.details) {
      home = Number(p.details.homeScore ?? home);
      away = Number(p.details.awayScore ?? away);
    }
  }
  return { away, home };
}

const p1Cache = new Map();
let diagShown = false;
async function firstPeriod(gameId) {
  if (p1Cache.has(gameId)) return p1Cache.get(gameId);
  const landing = await getJson(`${API}/gamecenter/${gameId}/landing`);
  let result = fromLinescore(landing) || fromScoring(landing);
  if (!result) {
    const pbp = await getJson(`${API}/gamecenter/${gameId}/play-by-play`);
    result = fromPbp(pbp);
    if (!result && !diagShown) {
      diagShown = true;
      console.warn(`DIAG hra ${gameId}: landing kľúče = ${Object.keys(landing ?? {}).join(',')}`);
      console.warn(`DIAG summary kľúče = ${Object.keys(landing?.summary ?? {}).join(',')}`);
      console.warn(`DIAG pbp kľúče = ${Object.keys(pbp ?? {}).join(',')}`);
    }
  }
  p1Cache.set(gameId, result);
  await sleep(150);
  return result;
}

const standingsRaw = await getJson(`${API}/standings/now`);
if (!standingsRaw?.standings?.length) {
  console.error('Nepodarilo sa stiahnuť tabuľku, data.json sa nemení.');
  process.exit(1);
}

const standings = standingsRaw.standings
  .map((t) => ({
    abbrev: t.teamAbbrev?.default,
    name: t.teamName?.default ?? t.teamCommonName?.default,
    gp: t.gamesPlayed,
    w: t.wins,
    l: t.losses,
    otl: t.otLosses,
    pts: t.points,
    division: t.divisionName,
    conference: t.conferenceName,
    seq: t.leagueSequence ?? null,
  }))
  .filter((t) => t.abbrev)
  .sort((a, b) => (a.seq != null && b.seq != null ? a.seq - b.seq : b.pts - a.pts));

standings.forEach((t, i) => (t.rank = i + 1));

const teams = {};
for (const t of standings) {
  const sched = await getJson(`${API}/club-schedule-season/${t.abbrev}/now`);
  if (!sched?.games) {
    console.warn(`Rozpis pre ${t.abbrev} chýba`);
    continue;
  }
  const games = sched.games.filter((g) => [2, 3].includes(g.gameType));
  const isHome = (g) => g.homeTeam?.abbrev === t.abbrev;
  const opp = (g) => (isHome(g) ? g.awayTeam?.abbrev : g.homeTeam?.abbrev);

  const played = games
    .filter((g) => g.gameState === 'OFF' || g.gameState === 'FINAL')
    .sort((a, b) => b.gameDate.localeCompare(a.gameDate))
    .slice(0, 5);

  const last5 = [];
  for (const g of played) {
    const p1 = await firstPeriod(g.id);
    let status = 'neznáme';
    let score = null;
    if (p1) {
      const mine = isHome(g) ? p1.home : p1.away;
      const theirs = isHome(g) ? p1.away : p1.home;
      score = `${mine}:${theirs}`;
      status = mine > theirs ? 'vyhral' : mine < theirs ? 'prehral' : 'remíza';
    }
    last5.push({ date: g.gameDate, opp: opp(g), home: isHome(g), p1: score, status });
  }

  const future = games
    .filter((g) => g.gameState === 'FUT' || g.gameState === 'PRE')
    .sort((a, b) => a.gameDate.localeCompare(b.gameDate))[0];

  teams[t.abbrev] = {
    last5,
    next: future
      ? { date: future.gameDate, start: future.startTimeUTC ?? null, opp: opp(future), home: isHome(future) }
      : null,
  };
  await sleep(150);
}

await writeFile('data.json', JSON.stringify({ updated: new Date().toISOString(), standings, teams }, null, 1));
console.log(`Hotovo: ${standings.length} tímov.`);
