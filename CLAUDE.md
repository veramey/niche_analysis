# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# API smoke test (regions reference lookup)
npm run smoke

# CLI — all commands
npm run tg -- search-tenders --kwords '"ремонт дороги"' --price1 10000000 --param f=44
npm run tg -- tender --id 12402324
npm run tg -- tender --tend-num 0174500001123002772
npm run tg -- contragent --inn 7716615618
npm run tg -- contragent-contact --inn 7716615618
npm run tg -- get --param mode=regions
npm run tg -- refresh-key --refresh-code "<code>" --update no

# Workflow scripts (date defaults to 2026-05-25)
node scripts/discover-ai-automation-market.js --date=YYYY-MM-DD --limit=50 --pages=1
node scripts/download-tender-docs.js --date=YYYY-MM-DD --max-depth=4 --only=<tender_id>
npm run analyze-docs -- --date=YYYY-MM-DD
node scripts/export-selected-tenders-docs.js
```

No build or test step. Validate changes by running the relevant script on a narrow scope (e.g. `--only=<id>`).

## Architecture

Pure Node.js 18+ ESM — no external dependencies. `.env` is loaded by `src/env.js` (manual parser; no `dotenv` package).

**Core layer (`src/`):**
- `tenderguru-client.js` — `TenderGuruClient` class wrapping TenderGuru API v2.3 (`https://www.tenderguru.ru/api2.3/export`). All requests are GET with `dtype=json` by default. `api_code` is injected automatically from `process.env.TENDERGURU_API_CODE`.
- `cli.js` — argument parser and command dispatcher. camelCase `--flags` are converted to `snake_case` API params via `toApiParams`. `--param key=value` passes raw API params.
- `export-utils.js` — shared helpers: `writeCsv`, `writeJsonl`, `appendJsonl`, `cleanText` (strips HTML/CDATA), `normalizeDocs` (handles TenderGuru's inconsistent doc shapes), `redactSecretsDeep`, `parseApiTenderInfo`, `dateValue`.

**Data pipeline (`scripts/`):**
1. `discover-ai-automation-market.js` — searches multiple keyword queries, deduplicates, classifies, writes `data/processed/{date}/candidates.jsonl|csv` and `data/processed/{date}/classified-tenders.jsonl|csv`.
2. `download-tender-docs.js` — fetches document manifests and downloads/extracts text from tender docs, writes to `data/raw/tenderguru/{date}/docs/{tender_id}/`.
3. `analyze-tender-docs.js` — reads classified tenders + downloaded docs, produces product cards (`data/analysis/{date}/product-cards/{id}.md`) and summary CSVs/MDs.
4. `export-selected-tenders-docs.js` — generates user-facing `exports/` CSVs.

**Data layout** (all date-partitioned):
```
data/raw/tenderguru/{date}/     ← API responses, docs, manifests
data/processed/{date}/          ← classified-tenders, candidates
data/analysis/{date}/           ← niches-summary, mvp-opportunities, product-cards/
exports/                        ← user-facing CSV exports
```

## Conventions

- ESM only (`"type": "module"`); use `import`/`export`, not `require`.
- Semicolons, single quotes, `const` by default.
- Always reuse helpers from `src/export-utils.js` before adding new ones.
- Script args parsed with a local `getArg(name, default)` pattern — each script has its own.
- `TENDERGURU_API_CODE` and `TENDERGURU_REFRESH_CODE` live in `.env`; never commit them.
