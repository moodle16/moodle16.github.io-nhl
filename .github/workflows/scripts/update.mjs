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

const p1Cache = new Map();
async function firstPeriod(gameId) {
  if (p1Cache.has(gameId)) return p1Cache.get(gameId);
  const data = await getJson(`${API}/gamecenter/${gameId}/landing`);
  let result = null;
  const periods = data?.summary?.linescore?.byPeriod ?? [];
  for (const p of periods) {
    if (p?.periodDescriptor?.number === 1) {
      result = { away: Number(p.away), home: Number(p.home) };
      break;
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
