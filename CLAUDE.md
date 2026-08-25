# Fantázia Shift Planner

Plánovač zmien pre brigádnikov v zábavnom parku Fantázia Liptov.
Komunikačný jazyk s používateľom je **slovenčina**. Vlastník: Cyril (erasko).

- **Produkcia:** https://fantazia-shift-planner.onrender.com (Render, auto-deploy z `main`)
- **Repozitár:** https://github.com/erasko/fantazia-shift-planner — ⚠️ **VEREJNÝ**, nikdy sem necommituj heslá, tokeny ani reálne osobné údaje
- **Databáza:** Supabase Postgres (tabuľka `app_store`, jeden riadok `id='main'` s celým stavom v JSONB)

## Architektúra

Zámerne bez frameworkov — jeden Node súbor + jeden JS súbor, žiadny build krok.

| Súbor | Obsah |
|---|---|
| `server.js` | HTTP server (ESM, bez Expressu), API, generovanie rozpisu, exporty |
| `public/app.js` | Celý frontend (vanilla JS, IIFE), tri pohľady: admin / brigádnik / prevádzkar |
| `public/styles.css` | Farby značky: `#f99300` oranžová, `#0c2372` navy, `#da001c` červená |
| `render.yaml` | Deploy konfigurácia |

**Úložisko:** Postgres cez `DATABASE_URL`, fallback na `data/store.json` keď premenná chýba (lokálny vývoj).
Celý stav je **jeden JSON objekt** — pozri `defaultStore()`.

**Prístup:** admin cez heslo + session cookie; brigádnici a prevádzkari cez **tajný token v URL**
(`/worker/<token>`, `/operator/<token>`), voliteľne aj heslom navyše.

## Kľúčové koncepty

**Súbežné obdobia.** Appka drží viac mesiacov naraz:
- `store.month` — mesiac, ktorý admin práve upravuje / zbiera naň dostupnosť
- `store.periods[mesiac]` — archív dátumov a otvorených dní pre každý mesiac
- `store.publishedMonths[]` — mesiace, ktorých rozpis brigádnici vidia

Vďaka tomu môže september ostať zverejnený, kým na október beží dotazník.
Ploché polia (`openDays`, `periodStart`…) vždy popisujú **aktuálne upravovaný** mesiac;
`activateMonth()` prepína a `snapshotCurrentPeriod()` archivuje.

**Dostupnosť je viazaná na mesiac.** `submissions[].month` — vyplnenie októbra nesmie
prepísať septembrovú dostupnosť, z ktorej bol postavený zverejnený rozpis.

**Rozpis má dve vrstvy.** `schedule[mesiac]` (automaticky vygenerovaný) + `manualAssignments[mesiac]`
(ručné úpravy navrchu). Pri regenerácii sa appka pýta, či ručné zmeny zachovať alebo zahodiť.

**Generovanie rozpisu** (`generateSchedule`) — greedy, deň po dni: z dostupných a oprávnených
vyberá vždy toho s **najmenej odpracovanými hodinami** (nie zmenami — stanoviská majú rôzne dlhé smeny).
Filtruje podľa `activeGroup`, ak je nastavená.

**Výnimky stanovísk** — `daySettings[dátum].stationOverrides[stanovisko]`:
`required: 0` stanovisko v ten deň skryje, `mergeWith` ho zlúči s iným (`mergedLabel` je spoločný názov).
Zlúčené stanovisko čerpá brigádnikov z **oboch** pôvodných.

**Zápis hodín — obojstranne slepý.** Zámerné proti dohodám:
- Brigádnik zapisuje **len v deň zmeny**; po odoslaní zamknuté, oprava len explicitným tlačidlom
- Prevádzkar **nevidí**, čo brigádnik nahlásil (`sanitizeHourLogsForOperator`) — formulár predvypĺňa
  *plánovaný* čas z rozpisu
- Brigádnik **nevidí**, čo prevádzkar schválil (`sanitizeHourLogsForWorker`)
- Nezhody vidí **len admin** v exporte `/api/export/actual-hours.xlsx`

Toto je bezpečnostná vlastnosť, nie kozmetika — filtruje sa **na serveri**, nie v zobrazení. Nerozbi to.

**Zástup.** Kto robil za niekoho, zapíše si hodiny sám a vyberie, koho zastupoval
(`substituteFor`). Zastupovaný musí byť v ten deň v rozpise.

## Konvencie

- **Čas vždy 24-hodinový.** Natívny `<input type="time">` sa riadi lokalizáciou OS a vie zobraziť AM/PM —
  preto je nahradený vlastným textovým poľom (`timeInputHTML`, trieda `.time-input`).
  Dátumy formátuj cez `fmtDateTime` / `fmtDateOnly`, nie cez `toLocale*`.
- **Prázdne pole hesla znamená „nemeniť".** Klient posiela `password` len keď je vyplnené,
  a `null` keď admin zaškrtne „zrušiť". Server: `if (w.password) … else if (w.password === null) …`.
  Kedysi tu bola chyba, ktorá pri každom uložení Nastavení potichu vymazala všetky heslá.
- **Agent má dve úrovne.** „Rýchly prehľad" a generátor správ počítajú **lokálne v prehliadači**,
  zadarmo a bez API kľúča. Claude chat (`/api/agent-chat`) je platený a vyžaduje `ANTHROPIC_API_KEY`.
  Nové funkcie rob lokálne, kým naozaj nepotrebujú jazykový model.

## Premenné prostredia

| Premenná | Účel |
|---|---|
| `DATABASE_URL` | Supabase Postgres. **Musí to byť Session pooler**, nie Direct — Render free tier nepodporuje IPv6 |
| `ADMIN_PASSWORD` | Admin heslo (lokálne default `admin`) |
| `ANTHROPIC_API_KEY` | Voliteľné — bez neho Claude chat vráti 503, zvyšok Agenta funguje |
| `AGENT_API_KEY` | Voliteľné — zapína read-only `/api/agent-data` |
| `PORT`, `DATA_DIR` | Lokálny vývoj |

## Lokálny vývoj

```bash
ADMIN_PASSWORD=test123 PORT=3060 DATA_DIR=/tmp/fsp-demo node server.js
```

Bez `DATABASE_URL` beží na JSON súbore — produkčných dát sa to nedotkne.
Na testovanie si cez API naplň brigádnikov, stanoviská a otvorené dni; vygeneruj a zverejni rozpis.
**Pozor:** zápis hodín funguje len v deň zmeny, takže testovací deň musí byť **dnešný dátum**.

## Známe pasce

- **Export do PDF v Safari.** „File → Export as PDF" dáva prázdny súbor. Správna cesta je
  Cmd+P → PDF → Save as PDF. V tlačovom CSS nepoužívaj `position: fixed` (Safari to rozbije).
- **Render + Supabase.** Direct connection je IPv6-only a na Render free tier zlyhá na `ENETUNREACH`.
- **Starý systém.** Predchodca (Codex) používal rovnaké tabuľky `app_store` / `app_backups`
  v inom Supabase projekte (MaCPLANNER). Označoval mesiace posunuto — august mal `month: '2026-07'`.
  Archívy sú v `publishedSchedules[].snapshot`.

## Čo ešte nie je hotové

1. **Upozornenia** — appka nič neposiela. Náhrada: generátor správ v Agentovi (text na skopírovanie do WhatsAppu).
2. **Mzdové sadzby** — počítajú sa hodiny, nie eurá.
3. **Zákonné limity** — bez kontroly hodín a odpočinku pre mladistvých.
4. **Evidencia no-show** — keď niekto nepríde a nikto to nenahlási.
