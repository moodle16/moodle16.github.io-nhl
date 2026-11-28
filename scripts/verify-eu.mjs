// Nezávislá kontrola európskych líg: porovná skóre 1. tretiny a konečné skóre z data-eu.json (Highlightly)
// s API-Sports (iný poskytovateľ). Bezplatný API-Sports dovoľuje len včera/dnes/zajtra → 1 požiadavka na deň.
// Spúšťa sa len ručne (workflow "Kontrola európskych líg"). Kľúč: secret APISPORTS_KEY.

import { readFile, appendFile } from 'node:fs/promises';

const KEY = process.env.APISPORTS_KEY;
if (!KEY) { console.error('Chýba secret APISPORTS_KEY.'); process.exit(1); }
const TZ = 'Europe/Bratislava';
const day = (off) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + off * 864e5));
const DAYS = (process.env.DAYS || '-1,0').split(',').map((x) => day(+x));

const eu = JSON.parse(await readFile(new URL('../data-eu.json', import.meta.url), 'utf8'));
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\b(hc|hk|hkm|ehc|erc|ec|if|ik|ifk|sc|hv71|ks|bk|mhk|msk|team|ice|the)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const toks = (s) => new Set(norm(s).split(' ').filter((t) => t.length >= 3));
function sim(a, b) {
  const A = toks(a), B = toks(b);
  let best = 0;
  for (const x of A) for (const y of B) {
    if (x === y) best = Math.max(best, 1);
    else if (x.startsWith(y) || y.startsWith(x)) best = Math.max(best, 0.8);
    else if (x.slice(0, 5) === y.slice(0, 5) && x.length >= 5) best = Math.max(best, 0.6);
  }
  return best;
}
const sc = (s) => { const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(String(s ?? '')); return m ? [+m[1], +m[2]] : null; };

const lines = [];
const log = (s = '') => { console.log(s); lines.push(s); };
const stats = {};
const problems = [];

for (const D of DAYS) {
  const ours = [];
  for (const l of eu.leagues) for (const [id, g] of Object.entries(l.games)) if (g.d === D && g.s === 'F') ours.push({ id, league: l.name, ...g });
  if (!ours.length) { log(`${D}: v našich dátach žiadne odohraté zápasy`); continue; }
  const res = await fetch(`https://v1.hockey.api-sports.io/games?date=${D}&timezone=${encodeURIComponent(TZ)}`, { headers: { 'x-apisports-key': KEY } });
  const body = await res.json().catch(() => null);
  if (!res.ok || (body?.errors && Object.keys(body.errors).length)) { log(`${D}: API-Sports chyba ${res.status} ${JSON.stringify(body?.errors)}`); continue; }
  const theirs = (body.response ?? []).filter((x) => ['FT', 'AOT', 'AP'].includes(x.status?.short));
  log(`\n## ${D}: našich odohratých ${ours.length}, v API-Sports odohratých (všetky ligy sveta) ${theirs.length}, zostáva požiadaviek ${res.headers.get('x-ratelimit-requests-remaining')}`);
  for (const g of ours) {
    const st = (stats[g.league] ??= { spolu: 0, sedi: 0, nesedi: 0, nenajdene: 0 });
    st.spolu++;
    let best = null, bestScore = 0;
    for (const t of theirs) {
      const s = sim(g.hn, t.teams?.home?.name) + sim(g.an, t.teams?.away?.name);
      if (s > bestScore) { bestScore = s; best = t; }
    }
    if (!best || bestScore < 1.2) { st.nenajdene++; log(`  ? ${g.league}: ${g.hn} – ${g.an} nenájdený v API-Sports`); continue; }
    const p1 = sc(best.periods?.first);
    const fin = [best.scores?.home, best.scores?.away];
    const ok1 = p1 && p1[0] === g.p1?.[0] && p1[1] === g.p1?.[1];
    const okF = fin[0] === g.fin?.[0] && fin[1] === g.fin?.[1];
    const line = `${g.league}: ${g.hn} – ${g.an} | 1. tretina naša ${g.p1?.join(':')} vs API-Sports ${p1?.join(':')} | konečné ${g.fin?.join(':')} vs ${fin.join(':')} (${best.teams.home.name} – ${best.teams.away.name}, ${best.league?.name})`;
    if (ok1 && okF) { st.sedi++; log('  ✔ ' + line); }
    else { st.nesedi++; problems.push(line); log('  ✘ ' + line); }
  }
}

const md = ['| liga | porovnaných | 1. tretina aj konečné skóre sedí | nesedí | nenájdené v API-Sports |', '|---|---|---|---|---|',
  ...Object.entries(stats).map(([k, s]) => `| ${k} | ${s.spolu} | ${s.sedi} | ${s.nesedi} | ${s.nenajdene} |`)];
log('\n' + md.join('\n'));
if (problems.length) log('\nNESEDÍ:\n' + problems.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '# Kontrola európskych líg\n\n' + md.join('\n') + '\n\n```\n' + lines.join('\n') + '\n```\n');
