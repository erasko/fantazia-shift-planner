# Nadväznosti — čo s čím súvisí

**Toto je pracovný manuál pre Clauda, nie dokumentácia appky.** Architektúru popisuje
`CLAUDE.md`. Tento súbor odpovedá na jedinú otázku:

> Keď zmením toto, čo ďalšie sa tým môže pokaziť?

Vznikol preto, že sa opakovane stalo to isté: oprava jednej obrazovky rozbila druhú,
alebo tá istá chyba prišla späť z iného uhla, lebo bola naprogramovaná na viacerých
miestach a opravilo sa len jedno.

**Pravidlo údržby:** každý vyriešený problém sem pridaj — riadok do mapy, ak odhalil
novú nadväznosť, a záznam do registra dole. Bez výnimky. Súbor, ktorý sa nedopĺňa,
je o mesiac klamstvo.

---

## Kontrolný zoznam pred každým „hotovo"

Nepreskakuj kroky preto, že zmena vyzerá malá. Väčšina chýb dole vyzerala malo.

1. **Nájdi všetky miesta.** Pozri mapu nižšie. Ak konceptu, ktorý meníš, nerozumieš
   dosť na to, aby si vymenoval všetky miesta, kde žije, tak ho ešte nemeníš — najprv
   ho vyhľadaj v `server.js` aj v `public/app.js`.
2. **`npm test`** — smoke test (`test/smoke.mjs`). Musí byť zelený *pred* aj *po*
   zmene. Keď je červený už pred ňou, najprv zisti prečo; nestavaj na rozbitom.
   `node --check server.js` chytí len preklep, `npm test` chytí regresie z registra dole.
3. **Spusť testovací server a preklikaj to v prehliadači.** Nielen `curl`, a smoke test
   to tiež nenahradí — netestuje vykresľovanie. Chyba typu
   TDZ (`Cannot access before initialization`) zhodí celú kartu a *každý API test prejde*.
   Aspoň: admin → Rozpis, admin → Hodiny, brigádnikov link, prevádzkarov link.
4. **Over aj opačný smer.** Nestačí, že sa nová hláška objaví — over aj, že po náprave
   zmizne. Inak si otestoval polovicu.
5. **Over výsledok, nie svoj regulárny výraz.** Keď parsuješ HTML v overovacom skripte,
   najprv si vypíš kúsok toho HTML a pozri, či tam hľadáš správnu triedu. Raz som na
   základe zlého regexu tvrdil, že export je prázdny, hoci nebol.
6. **Nezabudni na druhú rolu.** Skoro každá zmena v hodinách alebo v rozpise sa týka
   troch pohľadov: admin, brigádnik, prevádzkar. A často aj exportu.
7. **Doplň tento súbor a pridaj kontrolu do `test/smoke.mjs`** — takú, ktorá by tú
   chybu bola odhalila. Over, že nová kontrola vie **spadnúť**: dočasne chybu vráť
   a pozri, či test sčervenie. Kontrola, ktorá nevie spadnúť, je horšia než žiadna,
   lebo dáva falošný pokoj. Až potom commitni.

---

## Mapa nadväzností

### 1. „Ktorý mesiac / obdobie patrí tomuto dňu?"

**Najčastejší zdroj regresií v tomto projekte.** Obdobie nie je kalendárny mesiac —
víkend piatok–nedeľa je jeden celok, takže nedeľa 1. 11. môže patriť do októbra.

Žije na týchto miestach a **musia sa zhodovať**:

| Kde | Čo |
|---|---|
| `server.js` → `monthPeriod()` | vypočíta hranice obdobia z názvu mesiaca (posúva cez víkend) |
| `server.js` → `periodFor()` | hranice a otvorené dni pre daný mesiac (aktuálny alebo archív) |
| `server.js` → `inPeriod()` | patrí dátum do obdobia? |
| `server.js` → `periodDays()`, `scheduledDates()` | zoznamy dní obdobia |
| `public/app.js` → `periodOfDate()` | to isté na klientovi, pre zoskupovanie v zobrazení |

**Nikdy nepoužívaj `date.startsWith(mesiac)`** ani `date.slice(0,7)` na určenie obdobia —
to je presne tá chyba, ktorá potichu vyhodila novembrové dni z októbrového rozpisu.
Používaj `inPeriod()` / `periodOfDate()`.

**Nikdy neurčuj obdobie podľa toho, či je dátum v `openDays`.** Zabudnutý otvorený deň
z minulého mesiaca je presne to, čo tam ostane visieť — a appka potom zlepí september
s októbrom do jedného rozpisu. Rozhoduj podľa **rozsahu dátumov** obdobia.

Keď meníš jedno, prejdi všetkých päť.

---

### 2. „Kto všetko má hodiny?"

Hodiny si zapisujú **brigádnici aj prevádzkari**. Prevádzkar nie je v `store.workers`.

Kdekoľvek počítaš, sčítavaš alebo exportuješ hodiny, prechádzaj **oboje** — inak sa
stane to, čo sa už stalo: prevádzkarove hodiny boli zapísané, ale vo výplatnom exporte
neboli vôbec.

Týka sa: mesačný export hodín, `/api/export/actual-hours.xlsx`, prehľady v Agentovi,
súčty v admin karte Hodiny.

**Hodiny patria obdobiu, nie upravovanému mesiacu.** Admin pripravuje október, kým
september ešte len vypláca — `store.month` je vtedy už október. Preto nič okolo hodín
nesmie brať obdobie z `store.month` / `d.month`:

| Kde | Ako sa vyberá obdobie |
|---|---|
| `server.js` → `exportMonth(url, store)` | parameter `?month=`, predvolene `store.month` |
| `server.js` → `exportActualHoursXLSX(store, month)` | **všetky tri hárky** filtrujú `inPeriod(store, month, h.date)` |
| `server.js` → `exportHoursCSV` / `computeWorkerHours(store, month)` | plánované hodiny zo zvoleného obdobia |
| `public/app.js` → `selectedHoursMonth()` / `S.hoursMonth` | spoločný výber pre kartu Hodiny aj kartu Exporty |

Stĺpce dní vo výkaze = dni obdobia **plus každý deň, ktorý má záznam** — inak by
sa hodiny zarátali do „Spolu", ale nebolo by ich vidno v žiadnom dni.

---

### 3. Slepý zápis hodín — **nerozbi to**

Je to bezpečnostná vlastnosť proti dohodám, nie kozmetika. Popis je v `CLAUDE.md`.
Tu len to, na čo treba dať pozor pri zmenách:

- Filtruje sa **na serveri** (`sanitizeHourLogsForOperator`, `sanitizeHourLogsForWorker`),
  nie v zobrazení. Keď pridávaš nové pole do záznamu hodín, rozhodni, do ktorej strany
  patrí, a pridaj ho do príslušného filtra.
- Keď pridávaš nový endpoint, ktorý vracia hodiny, **musí prejsť cez ten istý filter**.
  Nový endpoint je najľahší spôsob, ako dieru otvoriť.
- Prevádzkarovi sa posiela zoznam ľudí ako `{id, name}` — **nikdy nie tokeny**.
  Token v URL *je* heslo.
- Test na túto vec musí kontrolovať **skutočné názvy polí**. Mal som tu tri kontroly,
  ktoré sa pýtali na neexistujúce polia — prešli by aj vtedy, keby dáta unikali.

---

### 4. Zobrazenie a mobil

- Mobilné karty robí `stackTables()` + MutationObserver v `public/app.js`, `data-label`
  na bunkách. Keď pridáš nový stĺpec do tabuľky, **pridaj mu aj `data-label`**, inak sa
  na mobile zobrazí bez popisu.
- Skrývanie riadkov musí byť `.row-collapsed { display: none !important }` — mobilné
  pravidlá dávajú riadkom `display: block`, takže obyčajné `display:none` prehrajú.
- **Keď niečo rozbaľuješ alebo zbaľuješ, over to na dlhom období.** Odstránenie
  zoskupenia pri jedinom období spravilo z októbra jeden neprerušený zoznam a posledný
  deň dole vyzeral, že sa nevygeneroval. Skupinovú lištu kresli **vždy**, aj pri jednom
  období.

---

### 5. Exporty

- Export tlačového rozpisu: `server.js` → `exportSchedulePrintHTML()`.
- Export je **vždy len za jedno obdobie** — keď sa objaví „zlepenec" viacerých mesiacov,
  chyba je skoro isto v bode 1 tejto mapy, nie v exporte.
- Názov obdobia v hlavičke sa berie z `store.month`; keď sa nemení, pozri, či sa vôbec
  prepol aktívny mesiac.
- Prázdne bunky v exporte **musia povedať prečo**. Deň otvorený až po vygenerovaní
  rozpisu vytlačí prázdny riadok, čo vyzerá ako pokazený export. Rieši to hláška
  `.gen-notice` a bunka `nevygenerované` (`.col-nogen`).
- V tlačovom CSS **nepoužívaj `position: fixed`** — Safari to rozbije.

---

### 6. Zverejnenie rozpisu

`store.publishedMonths[]` rozhoduje, čo brigádnik vidí. Regenerácia rozpisu
(`PUT /api/schedule`) **zverejnenie zruší** (`setMonthPublished(s, s.month, false)`) —
to je zámer, aby brigádnici nevideli polovičný rozpis. Ale znamená to, že po každom
generovaní treba znova zverejniť.

Keď užívateľ hlási „zverejnil som, ale nevidia to", over v tomto poradí:
1. je mesiac naozaj v `publishedMonths`?
2. vidí klient tie dni ako patriace do toho mesiaca? (bod 1 mapy)
3. má brigádnik v ten mesiac vôbec priradenie?

---

### 7. Časy stanovísk

`stationTimes()` — prišpendlený čas na stanovisku vyhráva, inak sa berie čas dňa
posunutý o `offsetStart` / `offsetEnd` (Chrobáčikovo a Kasa začínajú skôr). Ten istý
výpočet musí platiť v rozpise, v predvyplnení hodín aj v exporte — nepočítaj časy
nikde ručne, volaj `stationTimes()`.

---

### 8. Zmeny v stave (`store`)

Celý stav je jeden JSON objekt. Keď pridáš nové pole:
- dopíš ho do `defaultStore()`, inak staré uložené dáta padnú na `undefined`;
- počítaj s tým, že **produkčné dáta to pole nemajú** — vždy čítaj s predvolenou
  hodnotou (`store.neco || []`), nikdy nepredpokladaj, že existuje.

---

## Register vyriešených problémov

Najnovšie hore. Keď sa niektorý vráti, nehľadaj odznova — pozri sem.

### 2026-09-29 — Export hodín miešal obdobia
- **Symptóm (zachytený skôr, než to Cyril zažil):** po prepnutí na október by výkaz
  hodín mal októbrové (prázdne) stĺpce, ale v „Spolu" septembrové hodiny. Po prvých
  októbrových zmenách by „Spolu" sčítalo september aj október dokopy.
- **Príčina:** stĺpce sa brali z upravovaného mesiaca, súčty zo **všetkých záznamov
  za celú sezónu**. Karta Hodiny mala to isté — nadpis s upravovaným mesiacom, súčty
  za všetko. Súbor sa volal vždy `skutocne-hodiny.xlsx`, bez obdobia.
- **Oprava:** každé obdobie samostatne (bod 2 mapy), výber obdobia v karte Hodiny
  aj Exporty, súbor `FLP-hodiny-2026-09.xlsx`.
- **Test:** `test/smoke.mjs` → „Export hodín — každé obdobie samostatne". Proti
  starému kódu 4 kontroly červené.

### 2026-09-28 — Stiahnuté PDF rozpisu malo prázdnu stranu
- **Symptóm:** „export rozpisu stále nefunguje" — súbor `FLP - Rozpis OKTÓBER 2026.pdf`
  mal 998 bajtov a jednu prázdnu stranu.
- **Príčina:** appka ani export. PDF vyrobilo **Safari cez Súbor → Exportovať do PDF**,
  čo na macOS dáva prázdny súbor (v metadátach `/Creator (Safari)`, žiadne fonty).
  Názov súboru bol správny, takže stránka sa vykreslila v poriadku — zlyhal až prevod.
- **Ako to spoznať:** `strings subor.pdf | grep Creator`. Keď je tam Safari a súbor má
  pod ~2 kB, je to táto pasca, nie chyba appky.
- **Oprava:** na exportnej stránke je červené varovanie, že sa má použiť tlačidlo
  (Cmd+P → Uložiť ako PDF), nie Súbor → Exportovať do PDF.

### 2026-09-28 — Export vyzeral prázdny „ako vzor"
- **Symptóm:** export sa stiahne, ale prvá strana je prázdna ako šablóna.
- **Príčina:** export nebol pokazený. Dni otvorené *až po* vygenerovaní rozpisu nemajú
  nikoho priradeného a vytlačili sa ako prázdne bunky.
- **Oprava:** `exportSchedulePrintHTML()` — hláška `.gen-notice` na tej strane, kde sú
  prázdne dni, a bunka „nevygenerované".
- **Ako overiť:** otvor deň po generovaní → export musí obsahovať hlášku; znova
  „Generovať rozpis" → hláška musí zmiznúť.

### 2026-09-26 — Rozpis „zlepenec" viacerých mesiacov (3× za sebou)
- **Symptóm:** september a október sa zobrazili ako jeden rozpis; opakovalo sa po
  každej oprave z iného miesta.
- **Príčina:** rozhodovanie o období na troch miestach s troma rôznymi pravidlami —
  `startsWith`, „je v `openDays`", a natvrdo `d.month` v admin rozpise.
- **Oprava:** jediný zdroj pravdy — `inPeriod()` na serveri, `periodOfDate()` na
  klientovi, obe podľa **rozsahu dátumov**.
- **Poučenie:** toto je bod 1 mapy. Keď sa objaví čokoľvek s obdobiami, prejdi všetkých
  päť miest naraz.

### 2026-09-26 — 1. 11. sa nevygenerovalo
- **Príčina:** obdobie končilo posledným dňom kalendárneho mesiaca.
- **Oprava:** `monthPeriod()` posúva koniec cez víkend — víkend piatok–nedeľa je jeden
  celok.

### 2026-09-26 — Celá karta Hodiny zmizla
- **Príčina:** `const adminMark` deklarovaný až po použití (TDZ).
- **Poučenie:** **všetky API testy prešli.** Chytilo to až kliknutie v prehliadači.
  Odtiaľ je krok 3 kontrolného zoznamu.

### 2026-09-26 — Prevádzkarove hodiny chýbali vo výplatách
- **Príčina:** mesačný export prechádzal len `store.workers`.
- **Oprava:** prechádzať brigádnikov **aj** prevádzkarov. Bod 2 mapy.

### 2026-09-26 — Prázdny zoznam ľudí u prevádzkara
- **Príčina:** payload pre prevádzkara neobsahoval zoznam ľudí.
- **Oprava:** posiela sa `{id, name}` — **nikdy tokeny**.

### 2026-09-26 — Zverejnený rozpis brigádnik nevidel
- **Príčina:** klient priradil tie dni inému mesiacu (bod 1 mapy).
- **Poučenie:** „nevidí rozpis" nie je chyba zverejnenia, kým sa nevylúči bod 1.

---

## Čo tento manuál nechytí

Buď o tom úprimný, nech sa naň nespolieha viac, než unesie:

- **Vykresľovanie.** Smoke test volá API. Chyba, ktorá zhodí kartu v prehliadači,
  tu prejde. Preto krok 3 kontrolného zoznamu.
- **Mobilné zobrazenie.** Nekontroluje sa vôbec — treba pozrieť očami.
- **Produkčné dáta.** Test beží na čistom stave. Chyby typu „staré dáta nemajú nové
  pole" odhalí až produkcia. Preto bod 8 mapy.
- **Prekrývajúce sa obdobia.** Keby admin ručne nastavil začiatok nového obdobia na
  deň, ktorý už patrí predchádzajúcemu, ten deň sa zaráta do oboch výkazov. Automatické
  hranice (`monthPeriod`) sa neprekrývajú — víkend sa pripája k starému obdobiu a nové
  začína prvým pracovným dňom — ale ručne zadané dátumy sa nekontrolujú.
- **Súbežnosť.** Dlho otvorená admin stránka vie pri uložení prepísať novšie dáta
  (`S.schedEdits` drží starú snímku). Známe, zatiaľ neopravené.
