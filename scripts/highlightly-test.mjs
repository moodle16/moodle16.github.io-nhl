// Jednorazový test Highlightly Hockey API (bezplatný plán, 100 požiadaviek/deň).
// Kľúč je v secrete HIGHLIGHTLY_API a nikde sa nevypisuje. Spúšťa sa len ručne.

import { appendFile } from 'node:fs/promises';

const KEY = process.env.HIGHLIGHTLY_API;
if (!KEY) { console.error('Chýba secret HIGHLIGHTLY_API.'); process.exit(1); }
const API = process.env.HL_TEST_BASE || 'https://hockey.highlightly.net';
const TZ = 'Europe/Bratislava';
const MOCK = !!process.env.HL_TEST_BASE;
let used = 0;
let rate = {};
const out = [];
const log = (s = '') => { console.log(s); out.push(s); };

async function api(path) {
  used++;
  let res, body = null;
  try {
    res = await fetch(API + path, { headers: { 'x-rapidapi-key': KEY } });
    rate = { limit: res.headers.get('x-ratelimit-requests-limit'), remaining: res.headers.get('x-ratelimit-requests-remaining') };
    try { body = await res.json(); } catch {}
  } catch (e) { console.log(`  CHYBA siete ${e.message} ${path}`); }
  const n = Array.isArray(body?.data) ? body.data.length : Array.isArray(body) ? body.length : body?.groups ? body.groups.length + ' skupín' : '?';
  const err = res && !res.ok ? JSON.stringify(body).slice(0, 300) : '';
  log(`  [${res?.status}] ${path} → ${n}${body?.pagination ? ` (spolu ${body.pagination.totalCount})` : ''}${body?.plan ? ` plán=${body.plan.tier}` : ''} zostáva=${rate.remaining}/${rate.limit} ${err}`);
  if (body?.plan?.message && !api.planShown) { api.planShown = true; log(`  správa plánu: ${body.plan.message}`); }
  await new Promise((r) => setTimeout(r, MOCK ? 0 : 1500));
  return { ok: !!res?.ok, status: res?.status, body };
}

const fmt = (ts) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
const sc = (s) => { const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(String(s ?? '')); return m ? [+m[1], +m[2]] : null; };
const FIN = /finished/i;

function checkMatches(list) {
  // overí 1. tretinu a súčet tretín; skúša dve možnosti: tretiny ako prírastky vs. priebežný stav
  let fin = 0, p1 = 0, incr = 0, cumul = 0, bad = 0;
  const badEx = [];
  for (const m of list) {
    const st = m.state ?? {};
    if (!FIN.test(st.description ?? '')) continue;
    fin++;
    const s = st.score ?? {};
    const f = sc(s.firstPeriod), se = sc(s.secondPeriod), t = sc(s.thirdPeriod), ot = sc(s.overTime), cur = sc(s.current), pen = sc(s.penalties);
    if (f) p1++;
    if (!f || !se || !t || !cur) { bad++; if (badEx.length < 2) badEx.push(s); continue; }
    const sum = [f[0] + se[0] + t[0] + (ot?.[0] ?? 0), f[1] + se[1] + t[1] + (ot?.[1] ?? 0)];
    const so = /penalt/i.test(st.description ?? '');
    const eq = (a, b) => a[0] === b[0] && a[1] === b[1];
    const soOk = (a) => a[0] === a[1] && Math.abs(cur[0] - cur[1]) === 1 && Math.min(cur[0], cur[1]) === a[0];
    if (eq(sum, cur) || (so && soOk(sum))) incr++;
    else if (eq(ot ?? t, cur) || (so && soOk(ot ?? t))) cumul++;
    else { bad++; if (badEx.length < 2) badEx.push({ state: st.description, ...s }); }
  }
  return { fin, p1, incr, cumul, bad, badEx };
}

const WANT = [
  { key: 'SHL', c: /swed/i, m: (n) => n === 'shl' },
  { key: 'Allsvenskan', c: /swed/i, m: (n) => n.includes('allsvenskan') },
  { key: 'Liiga', c: /finl/i, m: (n) => n === 'liiga' },
  { key: 'DEL', c: /germ/i, m: (n) => n === 'del' },
  { key: 'DEL 2', c: /germ/i, m: (n) => n === 'del2' },
  { key: 'Extraliga CZ', c: /czech/i, m: (n) => n.includes('extraliga') },
  { key: 'Chance Liga', c: /czech/i, m: (n) => n.includes('chance') || n === '1liga' },
  { key: 'Tipsport liga SK', c: /slovak/i, m: (n) => n.includes('extraliga') || n.includes('tipsport') },
];
const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s.\-_]/g, '');

// ---------- ligy ----------
log('## Ligy');
const leagues = [];
for (let off = 0; off < 400; off += 100) {
  const r = await api(`/leagues?limit=100&offset=${off}`);
  const d = r.body?.data ?? [];
  leagues.push(...d);
  if (d.length < 100) break;
}
for (const c of [/swed/i, /finl/i, /germ/i, /czech/i, /slovak/i]) {
  const l = leagues.filter((x) => c.test(x.country?.name ?? ''));
  log(`${c.source}: ` + l.map((x) => `${x.id}=${x.name} [${(x.seasons ?? []).map((s) => s.season).sort().slice(-3).join(',')}]`).join('; '));
}

const rows = [];
const ids = new Set();
for (const w of WANT) {
  log(`\n## ${w.key}`);
  const cands = leagues.filter((x) => w.c.test(x.country?.name ?? '') && w.m(norm(x.name)));
  if (cands.length > 1) log(`kandidáti: ${cands.map((x) => x.id + '=' + x.name).join(', ')}`);
  // pri viacerých kandidátoch ber ten s najnovšou sezónou
  const lg = cands.sort((a, b) => Math.max(...(b.seasons ?? []).map((s) => s.season), 0) - Math.max(...(a.seasons ?? []).map((s) => s.season), 0))[0];
  if (!lg) { log('liga nenájdená'); rows.push({ liga: w.key }); continue; }
  ids.add(lg.id);
  const season = Math.max(...(lg.seasons ?? []).map((s) => s.season));
  log(`id ${lg.id} „${lg.name}“, najnovšia sezóna ${season}`);
  const row = { liga: w.key, id: lg.id, name: lg.name, season };

  const m = await api(`/matches?leagueId=${lg.id}&season=${season}&limit=100&offset=0`);
  const list = m.body?.data ?? [];
  row.total = m.body?.pagination?.totalCount ?? list.length;
  row.seasonOk = m.ok && list.length > 0;
  const ts = list.map((x) => Date.parse(x.date)).filter(Number.isFinite).sort((a, b) => a - b);
  if (ts.length) log(`prvá strana: ${list.length} zápasov z ${row.total}, dátumy ${fmt(ts[0])} – ${fmt(ts.at(-1))}`);
  const states = {}; for (const x of list) states[x.state?.description] = (states[x.state?.description] ?? 0) + 1;
  log(`stavy: ${JSON.stringify(states)}`);
  const ck = checkMatches(list);
  Object.assign(row, ck);
  log(`odohraté ${ck.fin}, s 1. tretinou ${ck.p1}; súčet sedí ako prírastky ${ck.incr}, ako priebežný stav ${ck.cumul}, nesedí ${ck.bad}`);
  if (ck.badEx.length) log(`nesedí napr.: ${JSON.stringify(ck.badEx)}`);
  const ex = list.find((x) => FIN.test(x.state?.description ?? ''));
  if (ex) log(`ukážka: ${JSON.stringify({ id: ex.id, date: ex.date, week: ex.week, home: ex.homeTeam?.name, away: ex.awayTeam?.name, state: ex.state })}`);
  const exOT = list.find((x) => /over time|penalt/i.test(x.state?.description ?? ''));
  if (exOT) log(`ukážka OT/nájazdy: ${JSON.stringify({ home: exOT.homeTeam?.name, away: exOT.awayTeam?.name, state: exOT.state })}`);
  row.pages = Math.ceil((row.total || 0) / 100);

  const s = await api(`/standings?leagueId=${lg.id}&season=${season}`);
  const groups = s.body?.groups ?? [];
  const teams = groups.reduce((a, g) => a + (g.standings?.length ?? 0), 0);
  row.standOk = s.ok && teams > 0;
  log(`tabuľka: ${groups.length} skupín, ${teams} riadkov${groups[0]?.standings?.[0] ? ', 1. ' + JSON.stringify(groups[0].standings[0]) : ''}`);
  rows.push(row);
}

// ---------- zápasy podľa dátumu ----------
log('\n## Zápasy podľa dátumu (všetky ligy)');
const dateRows = [];
for (const off of [0, -1, -14, 7]) {
  const day = fmt(Date.now() + off * 864e5);
  const all = [];
  let r, ok = true, total = 0;
  for (let o = 0; o < 300; o += 100) {
    r = await api(`/matches?date=${day}&timezone=${encodeURIComponent(TZ)}&limit=100&offset=${o}`);
    ok = ok && r.ok;
    const d = r.body?.data ?? [];
    total = r.body?.pagination?.totalCount ?? total;
    all.push(...d);
    if (d.length < 100 || off !== 0) break; // stránkovanie overíme len pri dnešku
  }
  const ours = all.filter((x) => ids.has(x.league?.id));
  const cnt = {}; for (const x of ours) cnt[x.league?.name] = (cnt[x.league?.name] ?? 0) + 1;
  const ck = checkMatches(ours);
  dateRows.push({ day, off, ok, total, got: all.length, ours: ours.length, cnt, ...ck });
  log(`${day} (${off > 0 ? '+' : ''}${off} d): ok=${ok}, spolu ${total}, stiahnutých ${all.length}, našich ${ours.length} ${JSON.stringify(cnt)}, odohratých ${ck.fin}, 1. tretina ${ck.p1}, súčet ok ${ck.incr + ck.cumul}, nesedí ${ck.bad}`);
}

log(`\n## Spotreba: ${used} požiadaviek, podľa hlavičky zostáva ${rate.remaining} z ${rate.limit}`);

const yn = (b) => (b ? 'áno' : 'nie');
const md = [
  '| liga | id | sezóna | aktuálna sezóna | zápasov v sezóne | 1. tretina (1. strana) | súčet sedí | tabuľka |',
  '|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.liga} | ${r.id ?? '–'} ${r.name ?? ''} | ${r.season ?? '–'} | ${yn(r.seasonOk)} | ${r.total ?? '–'} | ${r.fin != null ? `${r.p1}/${r.fin}` : '–'} | ${r.fin != null ? `${r.incr + r.cumul}/${r.fin} (nesedí ${r.bad})` : '–'} | ${yn(r.standOk)} |`),
  '',
  '| dátum | funguje | spolu | našich | odohratých | 1. tretina | nesedí |',
  '|---|---|---|---|---|---|---|',
  ...dateRows.map((d) => `| ${d.day} (${d.off > 0 ? '+' : ''}${d.off} d) | ${yn(d.ok)} | ${d.total} | ${d.ours} ${JSON.stringify(d.cnt)} | ${d.fin} | ${d.p1} | ${d.bad} |`),
];
console.log('\n' + md.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '# Test Highlightly\n\n' + md.join('\n') + '\n\n```\n' + out.join('\n') + '\n```\n');
