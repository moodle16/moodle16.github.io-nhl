// Európske ligy z Highlightly Hockey API → data-eu.json
// Bezplatný plán: 100 požiadaviek denne. Kľúč je v secrete HIGHLIGHTLY_API (nikde sa nevypisuje).
//
// Režimy (premenná MODE, nastavuje ich workflow podľa rozvrhu):
//   morning – všetky ligy: posledné výsledky + rozpis, všetky tabuľky          (~14 požiadaviek)
//   evening – len ligy, ktoré dnes hrajú: výsledky + rozpis                    (max 7)
//   late    – len ligy, ktoré dnes hrajú: výsledky + rozpis + ich tabuľky      (max 14)
//   weekend – len ligy, ktoré dnes hrajú: výsledky + rozpis                    (max 7)
//
// Zápasy prichádzajú od najnovších; 1. strana (100 zápasov) pokryje posledné týždne aj rozpis.
// Keď liga ešte nemá uložené dáta (alebo bola dlhá prestávka), skript stránkuje ďalej, kým nedosiahne
// už uložené zápasy – celá sezóna sa tak stiahne len raz.
//
// Kontrola: súčet gólov po tretinách + predĺženie = konečné skóre (pri nájazdoch +1 víťazovi).
// Ak čokoľvek zlyhá (aj minutý denný limit), ostávajú posledné platné dáta a chyba ide do logu.

import { readFile, writeFile } from 'node:fs/promises';

const KEY = process.env.HIGHLIGHTLY_API;
const API = process.env.HL_TEST_BASE || 'https://hockey.highlightly.net';
const MODE = process.env.MODE || 'morning';
const OUT = new URL('../data-eu.json', import.meta.url);
const TZ = 'Europe/Bratislava';
const MIN_REMAINING = 5; // rezerva – pod túto hranicu už nič neposielame
const inActions = !!process.env.GITHUB_ACTIONS;

export const LEAGUES = [
  { key: 'shl', id: 40781, country: 'Švédsko', name: 'SHL' },
  { key: 'allsvenskan', id: 42483, country: 'Švédsko', name: 'Hockey Allsvenskan' },
  { key: 'liiga', id: 14400, country: 'Fínsko', name: 'Liiga' },
  { key: 'del', id: 16953, country: 'Nemecko', name: 'DEL' },
  { key: 'del2', id: 17804, country: 'Nemecko', name: 'DEL 2' },
  { key: 'extraliga', id: 9294, country: 'Česko', name: 'Extraliga' },
  { key: 'tipsport', id: 78225, country: 'Slovensko', name: 'Tipsport liga' },
];

const warn = (m) => console.warn(inActions ? `::warning::${m}` : `VAROVANIE: ${m}`);
const error = (m) => console.error(inActions ? `::error::${m}` : `CHYBA: ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function local(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, year: +p.year, month: +p.month };
}
const now = Date.now();
const today = local(now).date;
const season = local(now).month >= 7 ? local(now).year : local(now).year - 1;

// ---------- API s ochranou limitu ----------
let used = 0;
let remaining = null;
let limitHit = false;
async function api(path) {
  if (limitHit) return { ok: false, limit: true };
  if (remaining != null && remaining < MIN_REMAINING) {
    limitHit = true;
    error(`Denný limit Highlightly takmer minutý (zostáva ${remaining}) – ďalšie požiadavky sa neposielajú, ostávajú posledné platné dáta.`);
    return { ok: false, limit: true };
  }
  used++;
  let res, body = null;
  try {
    res = await fetch(API + path, { headers: { 'x-rapidapi-key': KEY } });
    const rem = res.headers.get('x-ratelimit-requests-remaining');
    if (rem != null && rem !== '') remaining = Number(rem);
    try { body = await res.json(); } catch {}
  } catch (e) {
    warn(`Sieťová chyba ${e.message} pre ${path}`);
    return { ok: false };
  }
  console.log(`  [${res.status}] ${path} → ${Array.isArray(body?.data) ? body.data.length : body?.groups ? body.groups.length + ' skupín' : '?'} (zostáva ${remaining ?? '?'})`);
  if (res.status === 429 || (res.status === 403 && /limit|quota/i.test(JSON.stringify(body)))) {
    limitHit = true;
    error(`Denný limit Highlightly minutý (HTTP ${res.status}) – ostávajú posledné platné dáta.`);
    return { ok: false, limit: true };
  }
  if (!res.ok) {
    warn(`HTTP ${res.status} pre ${path}: ${JSON.stringify(body).slice(0, 200)}`);
    return { ok: false };
  }
  await sleep(API.startsWith('http://localhost') ? 0 : 1200);
  return { ok: true, body };
}

// ---------- spracovanie zápasu ----------
const sc = (s) => { const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(String(s ?? '')); return m ? [+m[1], +m[2]] : null; };
const DROP = /postponed|cancel|abandon|awarded/i;

function toRec(m) {
  const desc = m.state?.description ?? '';
  const s = m.state?.score ?? {};
  const fin = /^finished/i.test(desc);
  const rec = {
    t: m.date,
    d: local(m.date).date,
    h: m.homeTeam?.id,
    a: m.awayTeam?.id,
    hn: m.homeTeam?.name,
    an: m.awayTeam?.name,
    s: fin ? 'F' : /not started/i.test(desc) ? 'U' : 'L',
  };
  if (!fin) return rec;
  const p = [sc(s.firstPeriod), sc(s.secondPeriod), sc(s.thirdPeriod)];
  const ot = sc(s.overTime);
  const cur = sc(s.current);
  rec.p1 = p[0];
  rec.per = ot ? [...p, ot] : p;
  rec.fin = cur;
  const notes = [];
  if (!p[0]) notes.push('chýba 1. tretina');
  if (p.some((x) => !x) || !cur) notes.push('chýbajú tretiny alebo konečné skóre');
  else {
    const h = p[0][0] + p[1][0] + p[2][0] + (ot?.[0] ?? 0);
    const a = p[0][1] + p[1][1] + p[2][1] + (ot?.[1] ?? 0);
    if (/penalt/i.test(desc)) {
      const ok = h === a && ((cur[0] === h + 1 && cur[1] === a) || (cur[1] === a + 1 && cur[0] === h));
      if (!ok) notes.push(`nájazdy: súčet tretín ${h}:${a} nesedí s konečným ${cur[0]}:${cur[1]}`);
    } else if (h !== cur[0] || a !== cur[1]) notes.push(`súčet tretín ${h}:${a} ≠ konečné skóre ${cur[0]}:${cur[1]}`);
  }
  rec.ok = notes.length === 0;
  if (notes.length) rec.n = notes.join('; ');
  return rec;
}

// ---------- načítanie starých dát ----------
let old = {};
try { old = JSON.parse(await readFile(OUT, 'utf8')); } catch { console.log('data-eu.json zatiaľ neexistuje – sťahujem od začiatku.'); }
const oldByKey = Object.fromEntries((old.leagues ?? []).map((l) => [l.key, l]));

if (!KEY) {
  error('Chýba secret HIGHLIGHTLY_API – dáta sa nemenia.');
  process.exit(1);
}

console.log(`Režim ${MODE}, sezóna ${season}, dnes ${today}`);
const result = [];
let anyOk = false;

for (const L of LEAGUES) {
  const prev = oldByKey[L.key];
  const st = prev && prev.season === season
    ? { ...prev, games: { ...prev.games } }
    : { key: L.key, id: L.id, country: L.country, name: L.name, season, games: {}, standings: [], updated: null, standingsUpdated: null };
  Object.assign(st, { id: L.id, country: L.country, name: L.name });

  const hasData = Object.keys(st.games).length > 0;
  const playsToday = !hasData || Object.values(st.games).some((g) => g.d === today);
  const doMatches = MODE === 'morning' || playsToday;
  const doStandings = MODE === 'morning' || (MODE === 'late' && playsToday) || !st.standings.length;

  if (!doMatches && !doStandings) {
    console.log(`${L.name}: dnes nehrá – bez požiadaviek`);
    result.push(st);
    continue;
  }
  console.log(`${L.name}:`);

  // --- zápasy ---
  if (doMatches) {
    const lastFin = Math.max(0, ...Object.values(st.games).filter((g) => g.s === 'F').map((g) => Date.parse(g.t)));
    const fetched = [];
    let offset = 0, complete = false, firstOk = false;
    for (let page = 0; page < 10; page++) {
      const r = await api(`/matches?leagueId=${L.id}&season=${season}&limit=100&offset=${offset}`);
      if (!r.ok) break;
      if (page === 0) firstOk = true;
      const data = r.body?.data ?? [];
      fetched.push(...data);
      const total = r.body?.pagination?.totalCount ?? 0;
      const oldest = Math.min(...data.map((m) => Date.parse(m.date)).filter(Number.isFinite));
      if (data.length < 100 || offset + 100 >= total || (lastFin && oldest <= lastFin)) { complete = true; break; }
      offset += 100;
    }
    if (firstOk) {
      const ids = new Set(fetched.map((m) => String(m.id)));
      const minT = Math.min(...fetched.map((m) => Date.parse(m.date)).filter(Number.isFinite));
      // neodohraté zápasy v stiahnutom rozsahu, ktoré už v rozpise nie sú (presunuté/zrušené), odstránime
      for (const [id, g] of Object.entries(st.games)) {
        if (g.s !== 'F' && Date.parse(g.t) >= minT && !ids.has(id)) delete st.games[id];
      }
      for (const m of fetched) {
        if (DROP.test(m.state?.description ?? '')) { delete st.games[String(m.id)]; continue; }
        const rec = toRec(m);
        const prevRec = st.games[String(m.id)];
        // ak by API náhodou vrátilo odohratý zápas bez skóre, necháme staré overené dáta
        if (prevRec?.ok && rec.s === 'F' && !rec.ok && !rec.p1) continue;
        st.games[String(m.id)] = rec;
      }
      st.updated = new Date().toISOString();
      anyOk = true;
      if (!complete) warn(`${L.name}: stiahnutie nebolo úplné – dokončí sa pri ďalšom behu.`);
    } else {
      warn(`${L.name}: zápasy sa nepodarilo stiahnuť – ponechávam posledné platné dáta.`);
    }
  }

  // --- tabuľka ---
  if (doStandings) {
    const r = await api(`/standings?leagueId=${L.id}&season=${season}`);
    const groups = r.ok ? (r.body?.groups ?? []) : [];
    const rows = [];
    for (const g of groups) {
      for (const s of g.standings ?? []) {
        if (s.team?.id == null) continue;
        rows.push({ abbrev: String(s.team.id), name: s.team.name, conference: groups.length > 1 ? g.name : L.name, confRank: s.position });
      }
    }
    if (rows.length) {
      st.standings = rows;
      st.standingsUpdated = new Date().toISOString();
      anyOk = true;
    } else {
      warn(`${L.name}: tabuľku sa nepodarilo stiahnuť – ponechávam poslednú platnú.`);
    }
  }

  st.unverified = Object.entries(st.games).filter(([, g]) => g.s === 'F' && !g.ok).map(([id]) => id);
  for (const id of st.unverified) {
    const g = st.games[id];
    warn(`${L.name}: neoverený zápas ${id} (${g.d} ${g.hn} – ${g.an}): ${g.n ?? 'neznámy dôvod'}`);
  }
  result.push(st);
}

// ---------- spotreba ----------
const usage = { ...(old.usage ?? {}) };
usage[today] = (usage[today] ?? 0) + used;
for (const d of Object.keys(usage).sort().slice(0, -14)) delete usage[d];

console.log(`Požiadavky v tomto behu: ${used}, dnes spolu (podľa záznamu): ${usage[today]}, zostáva podľa API: ${remaining ?? '?'}`);

if (!anyOk && used > 0) {
  error('Žiadna požiadavka neuspela – data-eu.json sa nemení.');
  // spotrebu aj tak zaznamenáme, aby sme vedeli, koľko sa minulo
  if (old.version === 1) await writeFile(OUT, JSON.stringify({ ...old, usage, remaining }));
  process.exit(1);
}

await writeFile(OUT, JSON.stringify({
  version: 1,
  updated: new Date().toISOString(),
  season,
  usage,
  remaining,
  leagues: result,
}));
console.log(`Hotovo: ${result.map((l) => `${l.name} ${Object.keys(l.games).length} záp./${l.standings.length} tímov`).join(', ')}`);
