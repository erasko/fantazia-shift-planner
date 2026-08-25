# Odovzdanie projektu — prechod na firemný účet

Tento dokument je pre teba (alebo kohokoľvek, kto projekt preberie) pri prechode
z osobného účtu na firemný. Kód a dáta žijú **mimo chatu**, takže zmazanie histórie
konverzácie o nič nepripraví — dôležité je len prepísať prístupy.

> ⚠️ Repozitár je **verejný**. Heslá, tokeny ani telefónne čísla sem nepatria.
> Prístupové údaje si drž v správcovi hesiel, nie v súboroch.

---

## 1. Čo kde žije

| Vec | Kde | Ohrozené zmazaním chatu? |
|---|---|---|
| Zdrojový kód | GitHub `erasko/fantazia-shift-planner` | Nie |
| Bežiaca appka | Render (auto-deploy z `main`) | Nie |
| Dáta (brigádnici, rozpisy, hodiny) | Supabase Postgres | Nie |
| Znalosti o projekte | `CLAUDE.md` v repozitári | Nie — preto tam sú |
| Návod pre brigádnikov (PDF) | `~/Downloads/Fantazia-navod-brigadnici.pdf` | Nie |
| Záloha dát | `~/Documents/FLP-zaloha/` | Nie |

**Nič podstatné nie je len v chate.** Jediné, čo zmizne, je priebeh rozhovoru —
a to podstatné z neho je zapísané v `CLAUDE.md`.

---

## 2. Zálohy — sprav pred prechodom

Appka vie exportovať celý stav. V admin paneli **Exporty → „Záloha všetkých dát (.json)"**,
alebo cez príkaz (nahraď `HESLO`):

```bash
curl -s -c /tmp/c.txt -X POST -H 'Content-Type: application/json' \
  -d '{"password":"HESLO"}' \
  https://fantazia-shift-planner.onrender.com/api/login > /dev/null
curl -s -b /tmp/c.txt \
  https://fantazia-shift-planner.onrender.com/api/export/backup.json \
  > ~/Documents/FLP-zaloha/flp-backup-$(date +%F).json
```

Táto záloha obsahuje **všetko** — brigádnikov aj s ich tokenmi, rozpisy, dostupnosť,
zapísané hodiny. Zaobchádzaj s ňou ako s citlivým súborom (sú v nej prihlasovacie tokeny).

Odporúčam zálohovať pred každou väčšou zmenou a na konci sezóny.

---

## 3. Prevod účtov — postupnosť

Poradie je dôležité: **Supabase a Render až po GitHube**, lebo Render sa na GitHub napája.

### 3.1 GitHub

Repozitár je na osobnom účte `erasko`. Dve možnosti:

- **Preniesť** na firemný účet/organizáciu: *Settings → General → Transfer ownership*.
  Zachová históriu aj issues. Render potom treba znova prepojiť.
- **Nechať tak** a firemný účet len pozvať ako spolupracovníka. Jednoduchšie, ale
  vlastníctvo ostáva osobné — pri odchode z firmy problém.

Po prenose skontroluj, či Render stále vidí repozitár.

### 3.2 Render

Účet vlastní deploy. *Settings → Transfer service* alebo pozvi firemný účet do teamu.

**Nezabudni na premenné prostredia** — pri prenose sa niekedy nezoberú:

| Premenná | Poznámka |
|---|---|
| `DATABASE_URL` | **Musí byť Session pooler**, nie Direct (Render free nepodporuje IPv6) |
| `ADMIN_PASSWORD` | Pri prechode ho rovno **zmeň** |
| `ANTHROPIC_API_KEY` | Voliteľné, pre Claude chat v Agentovi |

### 3.3 Supabase

Projekt s databázou. *Settings → General → Transfer project* do firemnej organizácie.

Po prenose over, že `DATABASE_URL` na Renderi stále platí — connection string sa
môže zmeniť. Otestuj cez `https://…onrender.com/api/health` → má vrátiť `"storage":"postgres"`.
Ak vráti `"json"`, databáza **nie je pripojená** a appka beží na dočasnom súbore,
ktorý sa pri každom deployi stratí.

### 3.4 Prístup pre Claude Code

Na tomto počítači je uložený GitHub token v `~/.git-credentials`, viazaný na osobný účet.
Po prechode ho nahraď novým z firemného účtu:

```bash
# vygeneruj nový token na github.com/settings/tokens/new (scope: repo)
printf 'https://POUZIVATEL:TOKEN@github.com\n' > ~/.git-credentials
chmod 600 ~/.git-credentials
```

Starý token na GitHube **zruš**.

---

## 4. Kontrolný zoznam po prechode

```
[ ] Záloha dát stiahnutá a uložená mimo pracovného počítača
[ ] GitHub repozitár prenesený / prístup pridelený
[ ] Render prepojený na správny repozitár, deploy prebehol
[ ] DATABASE_URL funguje  →  /api/health vracia "storage":"postgres"
[ ] ADMIN_PASSWORD zmenené na nové silné heslo
[ ] Starý GitHub token zrušený, nový uložený
[ ] Admin panel sa načíta a vidno brigádnikov
[ ] Otvorený odkaz jedného brigádnika — vidí svoj rozpis
[ ] Otvorený odkaz prevádzkara — vidí rozpis aj hodiny
```

---

## 5. Prevádzkové poznámky

**Mesačný cyklus:**
1. V *Nastaveniach* prepni na nový mesiac (dáta starého sa zachovajú)
2. Nastav obdobie, otvorené dni a uzávierku (dohodnuté pravidlo: **15. deň predchádzajúceho mesiaca**)
3. V *Agentovi → Správy* vygeneruj výzvy na dostupnosť a rozošli
4. Po uzávierke v *Rozpise* vyber skupinu a klikni *Generovať*
5. Uprav ručne, čo treba, a *Zverejni*
6. Predchádzajúci mesiac ostane brigádnikom viditeľný — netreba ho rušiť

**Na konci mesiaca:** *Exporty → Skutočné odpracované hodiny + rozpory (.xlsx)*.
Druhý hárok ukazuje prípady, kde sa nahlásený a schválený čas nezhodovali.

**Bezpečnostné pripomienky:**
- Osobné odkazy brigádnikov sú **prihlasovacie údaje** — kto má odkaz, vidí ich dáta
- Heslá brigádnikov sú nepovinné a v tvare `PriezviskoMeno` bez diakritiky
- Repozitár je verejný, takže admin heslo musí byť silné (adresa appky je dohľadateľná)

---

## 6. Čo ešte nie je dorobené

| Priorita | Vec |
|---|---|
| Vysoká | **Upozornenia** — appka nič neposiela; zatiaľ generátor správ do WhatsAppu |
| Stredná | **Mzdové sadzby** — počítajú sa hodiny, nie eurá |
| Stredná | **Zákonné limity** — bez kontroly hodín a odpočinku pre mladistvých |
| Nízka | **Evidencia no-show** — keď niekto nepríde a nikto to nenahlási |

Podrobnosti k architektúre a pasciam sú v `CLAUDE.md` — načíta sa automaticky
v každej ďalšej relácii Claude Code, na hocijakom účte.
