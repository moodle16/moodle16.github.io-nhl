# NHL – forma v 1. tretine

Statická stránka (GitHub Pages): https://moodle16.github.io/moodle16.github.io-nhl/

- `index.html` – stránka (tabuľky po konferenciách, forma 5 posledných zápasov, rozbalenie tímu).
- `data.json` – dáta, generuje ich skript, ručne needitovať.
- `scripts/update.mjs` – stiahne dáta z `api-web.nhle.com`.
- `.github/workflows/update.yml` – spúšťa skript každé 3 hodiny (aj ručne: Actions → Aktualizácia dát → Run workflow).

Každý zápas sa kontroluje: súčet gólov po tretinách (+ predĺženie, bez nájazdov) musí sedieť
s konečným skóre a 1. tretina musí sedieť so zoznamom gólov. Ak nie, zápas je označený ako
„neoverený“ a v behu workflow sa objaví varovanie.

Odohraté a overené zápasy sa berú z `data.json`, sťahujú sa len nové.
