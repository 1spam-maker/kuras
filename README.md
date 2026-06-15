# Kuro kainų sekiklis (LT)

Automatiškai renka degalų kainas iš [Lietuvos energetikos agentūros](https://www.ena.lt/dk-visa-informacija/), kaupia istoriją ir rodo viešame puslapyje su grafikais. Atsinaujina kiekvieną darbo dieną. Kaina: 0 € (GitHub Actions + Pages).

## Kaip veikia

```
GitHub Actions (kasdien 11:05 LT)
  → scrape.mjs parsina ena.lt puslapį (data → SharePoint nuoroda)
  → atsisiunčia naujus Excel failus (?download=1)
  → atnaujina data.json (kaupia istoriją)
  → commit
GitHub Pages servina index.html + data.json → visi mato
```

## Paleidimas (3 žingsniai)

1. **Sukurk repo** ir įkelk visus failus (`scrape.mjs`, `index.html`, `data.json`, `.github/workflows/daily.yml`).

2. **Įjunk GitHub Pages:**
   `Settings → Pages → Source: Deploy from a branch → Branch: main / root → Save`
   Puslapis bus: `https://<vardas>.github.io/<repo>/`

3. **Patikrink workflow:**
   `Actions → Kuro kainų scrape → Run workflow` (rankinis paleidimas).
   Po ~1 min `data.json` turi atsinaujinti tikrais duomenimis.

Toliau viskas vyksta automatiškai.

## Konfigūracija

`.github/workflows/daily.yml`:
- `cron: '5 8 * * 1-5'` — paleidimo laikas (UTC). 08:05 UTC = 11:05 LT vasarą.
- `START_FROM` — nuo kurios datos kaupti. Tuščia = nuo pirmo paleidimo dienos. `'2026-06-01'` = nuo nurodytos.

## ⚠️ Jei scrape nepavyksta (SharePoint blokuoja)

GitHub Actions sukasi Microsoft Azure (JAV) IP. ENA SharePoint „anyone" nuorodos **gali** blokuoti datacenter IP, nors iš LT naršyklės veikia. Jei `Actions` log rodo:

```
ĮSPĖJIMAS: nepavyko atsisiųsti nė vienos naujos dienos
```

→ scrape iš GitHub neveikia. **Plano B (Power Automate):**

1. Power Automate cloud flow, trigeris „Recurrence" (kasdien 10:30).
2. „Get file content using path" (SharePoint, tavo prieiga) — paima dienos Excel.
3. Konvertuok į JSON (Compose / Parse).
4. HTTP `PUT` į GitHub Contents API → atnaujink `data.json`.

Tokiu atveju scrape.mjs nereikalingas; frontend lieka toks pat.

## Teisinė pastaba

Failai yra ENA vidiniame SharePoint (`/s/intra/`), dalinami „anyone with link". De facto vieši, bet **ne deklaruoti atviri duomenys**. Perskelbiant:
- nurodyk šaltinį (ENA), linkuok atgal,
- nemonetizuok,
- norint 100 % švaru — paklausk ENA (`info@ena.lt`), ar leidžia.

ENA gali bet kada pakeisti dalinimosi nustatymus ar nuorodas — tai struktūrinis šio sprendimo trapumas, ne kodo klaida.

## Failai

| Failas | Paskirtis |
|--------|-----------|
| `scrape.mjs` | Scraper (Node 20, tik `xlsx` paketas) |
| `index.html` | Viešas dashboard |
| `data.json` | Kaupiama istorija (auto) |
| `.github/workflows/daily.yml` | Kasdienis cron |
