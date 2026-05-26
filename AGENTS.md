# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains the API client and shared utilities:
  - `src/cli.js` is the command-line entry point.
  - `src/tenderguru-client.js` wraps TenderGuru API v2.3.
  - `src/env.js` loads `.env`.
  - `src/export-utils.js` handles CSV/JSONL writing and text cleanup.
- `scripts/` contains workflow scripts for discovery, download, analysis, and export.
- `data/` stores raw downloads, processed CSVs, and analysis outputs by date, for example `data/raw/tenderguru/2026-05-25/`.
- `exports/` stores user-facing CSV exports.

## Build, Test, and Development Commands
- `npm run tg -- <command>` runs the CLI against TenderGuru.
- `npm run smoke` runs a small API sanity check for regions.
- `npm run analyze-docs -- --date=2026-05-25` analyzes downloaded document text and writes CSV/MD outputs.
- `node scripts/discover-ai-automation-market.js --date=YYYY-MM-DD` finds and classifies candidate tenders.
- `node scripts/download-tender-docs.js --date=YYYY-MM-DD --max-depth=4` downloads documents and extracts text.

## Coding Style & Naming Conventions
- Use modern Node.js 18+ ESM syntax.
- Prefer ASCII filenames and lowercase, hyphenated script names such as `download-tender-docs.js`.
- Keep utility logic small and composable; reuse helpers from `src/export-utils.js` before adding new ones.
- Match existing code style: semicolons, single quotes, `const` by default, and clear variable names.

## Testing Guidelines
- There is no dedicated automated test suite yet.
- Validate changes by running the relevant script on a narrow scope first, for example:
  - `node scripts/download-tender-docs.js --date=2026-05-25 --only=32616028314`
  - `npm run smoke`
- For parser or export changes, confirm outputs in `data/` or `exports/` are created and readable.

## Commit & Pull Request Guidelines
- No Git history is available in this workspace, so follow a clear imperative style for commit messages, for example: `Fix TenderGuru doc download fallback`.
- Keep PRs focused on one workflow or bug.
- Include a short summary, commands used for validation, and sample output paths when relevant.

## Security & Configuration Tips
- Store `TENDERGURU_API_CODE` and `TENDERGURU_REFRESH_CODE` in `.env`; do not commit secrets.
- Review generated CSV/JSON before sharing, since raw tender data may include contacts, URLs, and pricing.
