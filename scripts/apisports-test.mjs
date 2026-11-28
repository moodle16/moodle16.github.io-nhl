// FÁZA 1 – jednorazový test API-Sports (API-Hockey) pre európske ligy.
// Spúšťa sa len ručne (workflow "Test API-Sports"). Kľúč je v secrete APISPORTS_KEY a nikde sa nevypisuje.
//
// Požiadavky (cca 18): /status (nepočíta sa), /leagues (1), pre každú ligu /games celej sezóny (8)
// a /standings (8), /games?date= (1).

import { appendFile } from 'node:fs/promises';

const KEY = process.env.APISPORTS_KEY;
if (!KEY) {
  console.error('Chýba secret APISPORTS_KEY.');
  process.exit(1);
}
const API = process.env.APISPORTS_TEST_BASE || 'https://v1.hockey.api-sports.io';
const TZ = 'Europe/Bratislava';
let used = 0;
let lastRate = {};

async function api(path) {
  const res = await fetch(API + path, { headers: { 'x-apisports-key': KEY } });
  if (!path.startsWith('/status')) used++;
  lastRate = {
    day_limit: res.headers.get('x-ratelimit-requests-limit'),
    day_remaining: res.headers.get('x-ratelimit-requests-remaining'),
    minute_remaining: res.headers.get('x-ratelimit-remaining'),
  };
  let body = null;
  try { body = await res.json(); } catch {}
  const errors = body?.errors && (Array.isArray(body.errors) ? body.errors.length : Object.keys(body.errors).length) ? body.errors : null;
  console.log(`  [${res.status}] ${path} → výsledkov ${body?.results ?? '?'}${errors ? ' CHYBA ' + JSON.stringify(errors) : ''}`);
  await new Promise((r) => setTimeout(r, process.env.APISPORTS_TEST_BASE ? 0 : 7000)); // free plán: max ~10 požiadaviek/min
  return { status: res.status, body, errors };
}

const out = [];
const log = (s = '') => { console.log(s); out.push(s); };

// ---------- účet ----------
log('## Účet');
const st = await api('/status');
const acc = st.body?.response ?? {};
log(`plán: ${acc.subscription?.plan ?? '?'}, aktívny: ${acc.subscription?.active ?? '?'}, ` +
  `požiadavky dnes: ${acc.requests?.current ?? '?'} / ${acc.requests?.limit_day ?? '?'}`);
const usedBefore = acc.requests?.current ?? null;

// ---------- ligy ----------
const WANT = [
  { key: 'SHL', country: 'Sweden', match: (n) => n === 'shl' },
  { key: 'Allsvenskan', country: 'Sweden', match: (n) => n.includes('allsvenskan') },
  { key: 'Liiga', country: 'Finland', match: (n) => n === 'liiga' },
  { key: 'DEL', country: 'Germany', match: (n) => n === 'del' },
  { key: 'DEL 2', country: 'Germany', match: (n) => n === 'del2' },
  { key: 'Extraliga CZ', country: 'Czech', match: (n) => n.includes('extraliga') },
  { key: 'Chance Liga', country: 'Czech', match: (n) => n.includes('chance') || n === '1liga' },
  { key: '1. Liga SK', country: 'Slovak', match: (n) => n === '1liga' },
];
const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s.\-_]/g, '');

log('\n## Ligy');
const lg = await api('/leagues');
const all = lg.body?.response ?? [];
for (const c of ['Sweden', 'Finland', 'Germany', 'Czech', 'Slovak']) {
  const list = all.filter((l) => String(l.country?.name ?? '').includes(c));
  log(`${c}: ` + list.map((l) => `${l.id}=${l.name}`).join(', '));
}

const now = Date.now();
const fmtParts = (ts) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { wd: p.weekday, date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
};
const addMin = (hm, m) => { const [h, mm] = hm.split(':').map(Number); const t = (h * 60 + mm + m) % 1440; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
const per = (s) => { const m = /^(\d+)\s*-\s*(\d+)$/.exec(String(s ?? '')); return m ? [+m[1], +m[2]] : null; };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SK = { Mon: 'po', Tue: 'ut', Wed: 'st', Thu: 'št', Fri: 'pi', Sat: 'so', Sun: 'ne' };

const rows = [];
const byWeekdayTimes = {}; // deň -> {liga: {čas: počet}}
const ids = [];
for (const w of WANT) {
  const cands = all.filter((l) => String(l.country?.name ?? '').includes(w.country) && w.match(norm(l.name)));
  const league = cands[0];
  log(`\n## ${w.key}`);
  if (!league) { log('liga nenájdená'); rows.push({ liga: w.key, id: '–', season: 'nie' }); continue; }
  if (cands.length > 1) log(`viac kandidátov: ${cands.map((c) => c.id + '=' + c.name).join(', ')} – beriem prvého`);
  const cur = (league.seasons ?? []).find((s) => s.current) ?? (league.seasons ?? []).at(-1);
  log(`id ${league.id} „${league.name}“ (${league.country?.name}), sezóna ${cur?.season} (${cur?.start} – ${cur?.end}), current=${cur?.current}`);
  log(`coverage: ${JSON.stringify(cur?.coverage ?? {})}`);
  ids.push(league.id);
  const row = { liga: w.key, id: league.id, name: league.name, season: cur?.season };

  // zápasy sezóny
  const g = await api(`/games?league=${league.id}&season=${cur?.season}`);
  const games = g.body?.response ?? [];
  row.seasonOk = !g.errors && games.length > 0;
  row.gamesErr = g.errors ? JSON.stringify(g.errors) : null;
  const fin = games.filter((x) => ['FT', 'AOT', 'AP'].includes(x.status?.short));
  const fut = games.filter((x) => ['NS', 'TBD'].includes(x.status?.short) && (x.timestamp * 1000 || Date.parse(x.date)) > now);
  const withP1 = fin.filter((x) => per(x.periods?.first));
  let sumOk = 0, sumOkSO = 0, sumBad = 0;
  for (const x of withP1) {
    const ps = ['first', 'second', 'third', 'overtime'].map((k) => per(x.periods?.[k])).filter(Boolean);
    const h = ps.reduce((s, p) => s + p[0], 0), a = ps.reduce((s, p) => s + p[1], 0);
    const fh = x.scores?.home, fa = x.scores?.away;
    if (h === fh && a === fa) sumOk++;
    else if (x.status?.short === 'AP' && h === a && ((fh === h + 1 && fa === a) || (fa === a + 1 && fh === h))) sumOkSO++;
    else sumBad++;
  }
  row.fin = fin.length; row.fut = fut.length; row.p1 = withP1.length;
  row.sum = `${sumOk} presne, ${sumOkSO} s nájazdom +1, ${sumBad} nesedí`;
  log(`zápasov ${games.length}: odohratých ${fin.length}, budúcich ${fut.length}, s 1. tretinou ${withP1.length}; kontrola súčtu: ${row.sum}`);
  const stat = {}; for (const x of games) stat[x.status?.short] = (stat[x.status?.short] ?? 0) + 1;
  log(`stavy: ${JSON.stringify(stat)}`);
  if (fin[0]) log(`ukážka odohratého: ${JSON.stringify({ date: fin.at(-1).date, status: fin.at(-1).status, teams: [fin.at(-1).teams?.home?.name, fin.at(-1).teams?.away?.name], scores: fin.at(-1).scores, periods: fin.at(-1).periods, week: fin.at(-1).week })}`);
  if (fut[0]) log(`najbližší: ${fut[0].date} ${fut[0].teams?.home?.name} – ${fut[0].teams?.away?.name}`);

  // rozpis: týždne, dni, časy (Europe/Bratislava)
  if (games.length) {
    const ts = games.map((x) => (x.timestamp ? x.timestamp * 1000 : Date.parse(x.date))).filter(Number.isFinite).sort((a, b) => a - b);
    const weeks = Math.max(1, (ts.at(-1) - ts[0]) / (7 * 864e5));
    const wd = {}; const times = {}; const perDate = {};
    for (const t of ts) {
      const p = fmtParts(t);
      wd[p.wd] = (wd[p.wd] ?? 0) + 1;
      times[p.hm] = (times[p.hm] ?? 0) + 1;
      perDate[p.date] = (perDate[p.date] ?? 0) + 1;
      ((byWeekdayTimes[p.wd] ??= {})[w.key] ??= {})[p.hm] = (byWeekdayTimes[p.wd][w.key][p.hm] ?? 0) + 1;
    }
    row.perWeek = (ts.length / weeks).toFixed(1);
    row.maxPerDay = Math.max(...Object.values(perDate));
    row.days = DAYS.filter((d) => wd[d]).sort((a, b) => wd[b] - wd[a]).slice(0, 3).map((d) => `${SK[d]} (${Math.round(100 * wd[d] / ts.length)} %)`).join(', ');
    const topT = Object.entries(times).sort((a, b) => b[1] - a[1]).slice(0, 3);
    row.times = topT.map(([t, n]) => `${t}→~${addMin(t, 150)} (${Math.round(100 * n / ts.length)} %)`).join(', ');
    row.latest = Object.keys(times).sort().at(-1);
    log(`sezóna ${fmtParts(ts[0]).date} – ${fmtParts(ts.at(-1)).date}: ${row.perWeek} zápasov/týždeň, max ${row.maxPerDay} za deň`);
    log(`dni: ${DAYS.map((d) => `${SK[d]} ${wd[d] ?? 0}`).join(', ')}`);
    log(`začiatky: ${Object.entries(times).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}×${n}`).join(', ')}`);
  }

  // tabuľka
  const s = await api(`/standings?league=${league.id}&season=${cur?.season}`);
  const groups = Array.isArray(s.body?.response) ? s.body.response : [];
  const teams = groups.flat().length;
  row.standOk = !s.errors && teams > 0;
  log(`tabuľka: ${groups.length} skupín, ${teams} riadkov${s.errors ? ', CHYBA ' + JSON.stringify(s.errors) : ''}`);
  if (groups[0]?.[0]) { const r = groups[0][0]; log(`ukážka riadku: ${JSON.stringify({ position: r.position, team: r.team?.name, group: r.group?.name, stage: r.stage, games: r.games?.played, points: r.points })}`); }
  rows.push(row);
}

// ---------- zápasy podľa dátumu ----------
log('\n## Zápasy podľa dátumu (všetky ligy jednou požiadavkou)');
const today = fmtParts(Date.now()).date;
const d = await api(`/games?date=${today}&timezone=${encodeURIComponent(TZ)}`);
const dg = d.body?.response ?? [];
const mine = dg.filter((x) => ids.includes(x.league?.id));
const byL = {}; for (const x of mine) byL[x.league?.name] = (byL[x.league?.name] ?? 0) + 1;
log(`${today}: spolu ${dg.length} zápasov vo všetkých ligách, z toho našich ${mine.length} ${JSON.stringify(byL)}${d.errors ? ' CHYBA ' + JSON.stringify(d.errors) : ''}`);
const dateOk = !d.errors && d.status === 200;

// ---------- súhrn ----------
const st2 = await api('/status');
const after = st2.body?.response?.requests?.current ?? null;
log(`\n## Spotreba: tento beh poslal ${used} započítaných požiadaviek; /status pred=${usedBefore}, po=${after}; hlavičky: ${JSON.stringify(lastRate)}`);

const yn = (b) => (b ? 'áno' : 'nie');
const md = [
  '| liga | id | aktuálna sezóna | 1. tretina | kontrola súčtu | tabuľka | zápasy/týždeň | max/deň | hlavné dni | časy (Bratislava) → koniec ~ |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.liga} | ${r.id} | ${yn(r.seasonOk)} ${r.season ?? ''}${r.gamesErr ? ' ' + r.gamesErr : ''} | ${r.fin ? `${r.p1}/${r.fin}` : '–'} | ${r.sum ?? '–'} | ${yn(r.standOk)} | ${r.perWeek ?? '–'} | ${r.maxPerDay ?? '–'} | ${r.days ?? '–'} | ${r.times ?? '–'} |`),
  '',
  `Dotaz podľa dátumu: ${yn(dateOk)} (${mine.length} našich zápasov dnes).`,
  '',
  '### Najneskorší bežný začiatok podľa dňa (Bratislava)',
  '| deň | ' + WANT.map((w) => w.key).join(' | ') + ' |',
  '|---|' + WANT.map(() => '---').join('|') + '|',
  ...DAYS.map((dd) => `| ${SK[dd]} | ` + WANT.map((w) => {
    const t = byWeekdayTimes[dd]?.[w.key]; if (!t) return '–';
    const tot = Object.values(t).reduce((a, b) => a + b, 0);
    const common = Object.entries(t).filter(([, n]) => n / tot >= 0.1).map(([h]) => h).sort();
    return `${tot}× ${common.join('/')}`;
  }).join(' | ') + ' |'),
];
console.log('\n' + md.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '# Test API-Sports\n\n' + md.join('\n') + '\n\n```\n' + out.join('\n') + '\n```\n');
