# Fantázia Shift Planner — Claude inštrukcie

## Živé dáta z appky

Keď sa používateľ pýta na čokoľvek týkajúce sa **rozpisu, brigádnikov, dostupnosti alebo zmien**,
VŽDY najprv načítaj aktuálne dáta zo servera pomocou tohto príkazu:

```bash
curl -s -H "x-agent-key: $AGENT_API_KEY" http://127.0.0.1:3000/api/agent-data
```

Ak server nebeží lokálne, spusti ho:
```bash
cd /Users/cyrilfogas/Documents/CLAUDECODE/fantazia-shift-planner
ADMIN_PASSWORD=admin123 AGENT_API_KEY=$AGENT_API_KEY PORT=3000 DATA_DIR=/tmp/fsp-preview node server.js &
sleep 2
```

## Kedy fetchovať dáta

- Otázky o tom KTO pracuje KDE a KEDY → fetch schedule
- Otázky o brigádnikoch, odpovediach, dostupnosti → fetch submissions
- Otázky o žiadostiach o zmenu → fetch changeRequests
- Otázky "kto má koľko zmien/dní/hodín" → použi pole `shiftCounts` z /api/agent-data (už spočítané, nepočítaj ručne zo `schedule`)
- Všeobecné otázky o kóde → nepotrebné fetchy

## Premenné prostredia

- `AGENT_API_KEY` — kľúč pre /api/agent-data endpoint (nastav v .env alebo pri spustení)
- `ADMIN_PASSWORD` — admin heslo (default: admin123 pre lokálny vývoj)
- `PORT` — port servera (default: 3000)

## Štruktúra projektu

- `server.js` — Node.js HTTP server (ESM), ~600 riadkov
- `public/app.js` — SPA frontend (~650 riadkov), vanilla JS
- `public/styles.css` — CSS s Fantázia brand farbami (#f99300, #0c2372, #da001c)
- `public/assets/fantazia-logo.svg` — originálne logo
- `render.yaml` — deploy konfigurácia pre Render.com

## Poznámky

- Bez `AGENT_API_KEY` env var je /api/agent-data endpoint vypnutý (vráti 401)
- Nastav `AGENT_API_KEY` na dlhý náhodný string pred deployom na produkciu
