# Fantázia Shift Planner — funkčná špecifikácia

Podklad pre stavbu mobilnej appky. Popisuje **existujúci, bežiaci systém** — webová appka
je v prevádzke a mobilná appka sa má napojiť na to isté API, nie postaviť nový backend.

- **API základ:** `https://fantazia-shift-planner.onrender.com`
- **Jazyk rozhrania:** slovenčina
- **Farby značky:** oranžová `#f99300`, navy `#0c2372`, červená `#da001c`
- **Veľkosť tímu:** ~13 brigádnikov, 2 prevádzkari, 1 admin, 4 stanoviská

---

## 1. Tri role

| Rola | Kto to je | Ako sa prihlasuje | Koľko ich je |
|---|---|---|---|
| **Admin** | Cyril, vedúci | Heslo + session cookie | 1 |
| **Prevádzkar** | Vedúci smeny v parku | Tajný odkaz `/operator/<token>`, voliteľne heslo | 2 |
| **Brigádnik** | Sezónny pracovník | Tajný odkaz `/worker/<token>`, voliteľne heslo | ~13 |

**Dôležité pre mobilnú appku:** neexistuje registrácia ani e-mail/heslo prihlásenie.
Identita = **token v URL**. Mobilná appka si token uloží raz (napr. z naskenovaného QR kódu
alebo z odkazu, ktorý používateľ otvorí) a ďalej ho posiela pri každom volaní.

Voliteľné heslo je **druhá vrstva** nad tokenom, nie náhrada. Overuje sa cez
`POST /api/{worker|operator}/<token>/access` a je v tvare `PriezviskoMeno` bez diakritiky.

---

## 2. Mesačný cyklus — celý tok

```
ADMIN                          BRIGÁDNIK                    PREVÁDZKAR
─────────────────────────────────────────────────────────────────────────
1. Založí mesiac
   (obdobie, otvorené dni,
    uzávierka = 15. deň
    predchádzajúceho mesiaca)
                          →   2. Vyplní dostupnosť
                                 (klikne dni, kedy
                                  NEMÔŽE pracovať)
3. Po uzávierke vygeneruje
   rozpis (automaticky)
4. Ručne doladí
5. Zverejní
                          →   6. Vidí svoj rozpis      →   6. Vidí celý rozpis
                                                             + kto je voľný

   ── počas mesiaca, každý deň zmeny ──

                              7. Po zmene si zapíše
                                 skutočné hodiny
                                 (LEN v ten deň)
                                                         →  8. Nezávisle schváli
                                                              hodiny (nevidí, čo
                                                              nahlásil brigádnik)
9. Na konci mesiaca
   exportuje hodiny
   + zoznam nezhôd
```

**Súbežné obdobia:** kroky 1–2 pre nový mesiac môžu bežať, kým je predchádzajúci mesiac
stále zverejnený (kroky 6–8). Brigádnik teda naraz vidí *rozpis na september* aj
*dotazník na október*.

---

## 3. Brigádnik — detailne

Jediná obrazovka, tri sekcie pod sebou. Endpoint: `GET /api/worker/<token>`.

### 3.1 Dostupnosť
- Kalendár mesiaca, ktorý sa práve zbiera (`month`, `periodStart`–`periodEnd`)
- Zobrazujú sa len **otvorené dni** (`openDays`); ostatné sú neaktívne
- Prepínanie dňa: zelená „Môžem" ⇄ červená „Nemôžem"
- **Klikajú sa dni, kedy NEMÔŽE** — neintuitívne, treba to v UI jasne napísať
- Uloženie: `PUT /api/worker/<token>/submission` s `{ unavailableDays: ["2026-10-03", …] }`
- Zamkne sa (`locked: true`), keď prejde uzávierka **alebo** keď je mesiac zverejnený
- Po zamknutí sa namiesto kalendára ponúkne **žiadosť o zmenu**

### 3.2 Tvoj rozpis
- Zoznam zmien naprieč **všetkými zverejnenými mesiacmi** (`confirmedSchedule`)
- Každá položka: dátum, stanovisko, čas od–do, mesiac
- Zobrazí sa len ak `scheduleVisible: true`

### 3.3 Zápis hodín
Pri každej zmene v rozpise jeden zo štyroch stavov:

| Stav | Podmienka | Zobrazenie |
|---|---|---|
| **Budúca** | `date > dnes` | „Hodiny zapíšeš v deň zmeny." |
| **Dnes, nezapísané** | `date == dnes` | Dve polia od–do + tlačidlo *Zapísať hodiny* |
| **Zapísané** | existuje záznam | Odznak stavu + „Nahlásil(a) si HH:MM–HH:MM" + *Poslať opravu* |
| **Zmeškaná** | `date < dnes`, bez záznamu | Červené „Hodiny neboli zapísané — kontaktuj prevádzkara" |

Uloženie: `POST /api/worker/<token>/hours`
```json
{ "date": "2026-09-04", "stationId": "st_vstup",
  "start": "10:00", "end": "19:15",
  "substituteFor": null }
```

**Pravidlá (vynucuje server, nie UI):**
- Prvý zápis **len v deň zmeny** — inak `400 Hodiny môžeš zapísať len v deň zmeny`
- Oprava existujúceho záznamu je povolená kedykoľvek, aj po schválení — vráti ho na `pending`
- Brigádnik **nikdy nevidí**, aký čas schválil prevádzkar. Vidí len stav
  `⏳ Čaká na schválenie` / `✓ Schválené`. Toto je zámerné — filtruje sa na serveri.

### 3.4 Zástup
Ak robil namiesto niekoho iného:
- Vyberie **deň** (musí byť dnešný), **stanovisko** a **za koho** zastupoval
- Ponúkajú sa len ľudia, ktorí sú v ten deň na tom stanovisku v rozpise (`fullSchedule`)
- Rovnaké volanie ako vyššie, len s `substituteFor: "<workerId>"`

### 3.5 Žiadosť o zmenu
Keď je dostupnosť zamknutá: textový dôvod + zoznam dní.
`POST /api/worker/<token>/change-request` → `{ reason, days }`. Admin ju schváli alebo zamietne.

---

## 4. Prevádzkar — detailne

Endpoint: `GET /api/operator/<token>`. Tri záložky.

### 4.1 Aktuálny deň
- **Dnes na stanoviskách** — kto kde dnes robí, s časmi
- **Voľní dnes** — koho môže zavolať pri výpadku. Pri každom: meno, počet zmien,
  stanoviská, ktoré vie zastať. Zoradené **od najmenej zaťaženého**.
  Nezobrazujú sa tí, čo sú už v rozpise, ani tí, čo nahlásili nedostupnosť.
- **Hodiny na schválenie — dnes**

### 4.2 Rozpis
Tabuľka celého zverejneného obdobia: riadok = deň, stĺpce = stanoviská + **Voľní**.

### 4.3 Hodiny
Schvaľovanie. Pri každom čakajúcom zázname zadá **vlastný** čas a potvrdí.
`POST /api/operator/<token>/hours/<logId>/approve` → `{ start, end }`

**Kritické pravidlo:** prevádzkar **nevidí**, čo nahlásil brigádnik. Formulár je predvyplnený
**plánovaným časom z rozpisu** (`plannedStart`/`plannedEnd`), nie nahláseným. Server pole
`reportedStart`/`reportedEnd` do odpovede pre prevádzkara vôbec neposiela.

> Toto je bezpečnostná vlastnosť proti dohodám medzi brigádnikom a prevádzkarom.
> V mobilnej appke to **nesmie** byť obídené — nikdy nezobrazuj nahlásený čas prevádzkarovi.

---

## 5. Admin — detailne

Endpoint: `GET /api/admin` (session cookie). Sedem záložiek.

| Záložka | Obsah |
|---|---|
| **Nastavenia** | Prepínanie mesiacov, obdobie, uzávierka, otvorené dni, časy dní, výnimky stanovísk, stanoviská, brigádnici, prevádzkari |
| **Odpovede** | Kto odovzdal dostupnosť, ktoré dni nemôže, mazanie odpovedí |
| **Rozpis** | Aktívna skupina, generovanie, ručné úpravy, zverejnenie |
| **Skupiny** | Pracovné skupiny (napr. Sezóna / Mimo sezóny) |
| **Hodiny** | Prehľad zapísaných hodín, **kto schvaľoval**, zvýraznené nezhody |
| **Žiadosti** | Schvaľovanie žiadostí o zmenu dostupnosti |
| **Exporty** | XLSX/CSV/tlač, záloha |
| **Agent** | Rýchly prehľad, generátor správ, Claude chat |

### 5.1 Generovanie rozpisu
`PUT /api/schedule` s `{ discardManual: bool }`

Algoritmus (greedy, deň po dni, stanovisko po stanovisku):
1. Kandidáti = v aktívnej skupine ∧ majú stanovisko povolené ∧ nenahlásili nedostupnosť
   ∧ nie sú v ten deň už inde priradení
2. Zoradí podľa **najmenej odpracovaných hodín** (nie počtu zmien — smeny majú rôznu dĺžku)
3. Naplní potrebný počet

Ak existujú ručné úpravy, appka sa **pýta**: zachovať ich, alebo zahodiť a vygenerovať načisto.

### 5.2 Výnimky stanovísk
`daySettings[dátum].stationOverrides[stanovisko]`:
- `required: 0` → stanovisko je v ten deň skryté
- `mergeWith: "<inéStanovisko>"` → zlúčenie; zlúčené čerpá ľudí z **oboch**, zobrazí sa
  pod spoločným názvom `mergedLabel` (napr. „Autodrom + Bumpers")

### 5.3 Exporty
| Export | Obsah |
|---|---|
| `schedule-print` | HTML na tlač/PDF, farebné, riadky = dni, stĺpce = stanoviská, legenda farieb |
| `schedule.xlsx` / `.csv` | Rozpis |
| `submissions.csv` | Odpovede brigádnikov |
| `hours.csv` | **Plánované** hodiny podľa rozpisu |
| `actual-hours.xlsx` | **Skutočné** hodiny — hárok brigádnik × deň + hárok **Rozpory** |
| `backup.json` | Celý stav |

**Hárok Rozpory** je jediné miesto, kde vidno rozdiel medzi nahláseným a schváleným časom.

---

## 6. Dátový model

Celý stav je **jeden JSON objekt** (Postgres JSONB, tabuľka `app_store`, riadok `id='main'`).

```jsonc
{
  "month": "2026-09",              // mesiac, ktorý admin práve upravuje
  "periodStart": "2026-09-01",
  "periodEnd": "2026-09-30",
  "availabilityDeadline": "2026-08-15T23:59",
  "openDays": ["2026-09-04", …],   // dni aktuálne upravovaného mesiaca
  "defaultOpensAt": "10:00",
  "defaultClosesAt": "19:00",

  "periods": {                      // archív ostatných mesiacov
    "2026-08": { "periodStart", "periodEnd", "openDays", "availabilityDeadline" }
  },
  "publishedMonths": ["2026-09"],   // ktoré mesiace vidia brigádnici

  "daySettings": {
    "2026-09-04": {
      "opensAt": "10:00", "closesAt": "19:00",
      "stationOverrides": {
        "st_bumpers":  { "required": 0, "_mergedInto": "st_autodrom" },
        "st_autodrom": { "required": 1, "mergeWith": "st_bumpers",
                         "mergedLabel": "Autodrom + Bumpers" }
      }
    }
  },

  "stations": [{ "id", "name", "required", "opensAt", "closesAt" }],
  "workers":  [{ "id", "name", "token", "passwordHash", "allowedStations": [] }],
  "operators":[{ "id", "name", "token", "passwordHash" }],
  "groups":   [{ "id", "name", "workerIds": [] }],
  "activeGroup": "grp_…",

  "submissions": [{ "id", "workerId", "workerName", "month",
                    "unavailableDays": [], "submittedAt" }],

  "schedule":          { "2026-09": { "2026-09-04": { "st_vstup": ["workerId"] } } },
  "manualAssignments": { "2026-09": { … } },   // prekrýva schedule

  "hourLogs": [{
    "id", "date", "stationId", "workerId", "workerName",
    "substituteFor", "substituteForName",
    "reportedStart", "reportedEnd", "reportedAt",   // NIKDY prevádzkarovi
    "status": "pending" | "approved",
    "approvedStart", "approvedEnd",                 // NIKDY brigádnikovi
    "approvedBy", "approvedByName", "approvedAt"
  }],

  "changeRequests": [{ "id", "workerId", "workerName", "days", "reason",
                       "status": "pending|approved|rejected", "requestedAt", "resolvedAt" }]
}
```

**Zobrazený rozpis = `schedule[mesiac]` prekrytý `manualAssignments[mesiac]`.**

---

## 7. API — kompletný zoznam

### Verejné
| Metóda | Cesta | Účel |
|---|---|---|
| GET | `/api/health` | Kontrola behu, `{ ok, storage }` |
| GET | `/api/public-config` | Mesiac, obdobie, uzávierka |

### Brigádnik (token v ceste)
| Metóda | Cesta | Účel |
|---|---|---|
| GET | `/api/worker/<token>` | Všetky jeho dáta |
| POST | `/api/worker/<token>/access` | Overenie hesla |
| PUT | `/api/worker/<token>/submission` | Odoslanie dostupnosti |
| POST | `/api/worker/<token>/hours` | Zápis / oprava hodín |
| POST | `/api/worker/<token>/change-request` | Žiadosť o zmenu |

### Prevádzkar (token v ceste)
| Metóda | Cesta | Účel |
|---|---|---|
| GET | `/api/operator/<token>` | Rozpis, voľní ľudia, hodiny |
| POST | `/api/operator/<token>/access` | Overenie hesla |
| POST | `/api/operator/<token>/hours/<id>/approve` | Schválenie hodín |

### Admin (session cookie z `POST /api/login`)
| Metóda | Cesta |
|---|---|
| POST | `/api/login`, `/api/logout` · GET `/api/session` |
| GET | `/api/admin` |
| PUT | `/api/config` · `/api/schedule` · `/api/manual-assignments` · `/api/schedule-publication` |
| DELETE | `/api/submissions/<id>` |
| POST | `/api/change-requests/<id>/approve` · `/reject` |
| GET | `/api/export/*` |
| POST | `/api/agent-chat` |

---

## 8. Pravidlá, ktoré sa nesmú porušiť

1. **Prevádzkar nikdy nevidí nahlásený čas brigádnika.** Filtruje sa na serveri.
2. **Brigádnik nikdy nevidí schválený čas.** Tiež na serveri.
3. **Prvý zápis hodín len v deň zmeny.** Oprava kedykoľvek.
4. **Čas vždy 24-hodinový.** Natívne `<input type="time">` sa riadi lokalizáciou OS
   a vie zobraziť AM/PM — v mobilnej appke použi vlastný ovládač.
5. **Dostupnosť je viazaná na mesiac.** Vyplnenie októbra nesmie prepísať september.
6. **Osobný odkaz je prihlasovací údaj.** Nikdy ho nezobrazuj inému používateľovi.
7. **Prázdne pole hesla = nemeniť**, nie „zmazať".

---

## 9. Čo mobilná appka pridá oproti webu

Web je už responzívny a na mobile použiteľný. Natívna appka má zmysel hlavne kvôli:

| Prínos | Poznámka |
|---|---|
| **Push notifikácie** | Najväčšia chýbajúca vec — dnes appka neposiela nič |
| Trvalé prihlásenie | Token uložený v zariadení, netreba hľadať odkaz |
| Rýchlejší zápis hodín | Widget / skratka „zapíš hodiny" |
| Offline náhľad rozpisu | Zobrazenie aj bez signálu |

Push notifikácie by dávali zmysel pri: zverejnení rozpisu, blížiacej sa uzávierke,
pripomienke zápisu hodín (večer v deň zmeny), schválení/zamietnutí žiadosti.

**Poznámka:** push vyžaduje doplnenie backendu — evidenciu zariadení a odosielanie.
Dnešné API to nemá.

---

## 10. Distribúcia mobilnej appky

Ako sa appka dostane k 13 sezónnym brigádnikom — od najjednoduchšieho:

### A. PWA — „Pridať na plochu" *(odporúčané pre túto veľkosť tímu)*
Používateľ otvorí odkaz v prehliadači a dá *Pridať na plochu*. Vznikne ikona,
appka beží na celú obrazovku bez adresného riadka.

- **Cena:** 0 € · **Schvaľovanie:** žiadne · **Aktualizácie:** okamžité
- Push notifikácie fungujú na Androide aj iOS (od iOS 16.4), ale na iOS **len** ak si
  appku pridali na plochu
- Nie je v App Store — treba poslať odkaz

### B. Interná distribúcia
- **Android:** APK súbor priamo (treba povoliť „neznáme zdroje")
- **iOS:** TestFlight — vyžaduje Apple Developer účet, do 10 000 testerov,
  build vyprší po 90 dňoch

### C. Obchody s aplikáciami
| | Apple App Store | Google Play |
|---|---|---|
| Poplatok | **99 $/rok** | **25 $ jednorazovo** |
| Schvaľovanie | dni, môže byť zamietnuté | hodiny až dni |
| Aktualizácia | cez recenziu | rýchlejšie |

Pre internú appku pre 13 ľudí je verejný obchod **zbytočný** — Apple navyše appky,
ktoré sú len pre zamestnancov jednej firmy, z verejného obchodu často zamieta.

### Odporúčanie
Začni **PWA**. Nulová cena, žiadne schvaľovanie, funguje na oboch platformách a rieši
aj push notifikácie. Ak sa neskôr ukáže, že treba niečo, čo PWA nezvláda, dá sa prejsť
na natívnu appku bez zmeny backendu.

---

## 11. Testovanie

Lokálne, bez dotyku produkčných dát:

```bash
git clone https://github.com/erasko/fantazia-shift-planner
cd fantazia-shift-planner && npm install
ADMIN_PASSWORD=test123 PORT=3060 DATA_DIR=/tmp/fsp-demo node server.js
```

Bez `DATABASE_URL` beží na JSON súbore. Cez admin panel (`http://localhost:3060`)
naplň stanoviská, brigádnikov a otvorené dni, vygeneruj a zverejni rozpis.

**Dôležité:** zápis hodín funguje len v deň zmeny — testovací otvorený deň musí byť
**dnešný dátum**, inak sa formulár nezobrazí.
