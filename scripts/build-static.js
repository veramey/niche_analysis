#!/usr/bin/env node
// Pre-generates static data files for GitHub Pages deployment.
// Run: node scripts/build-static.js [date]
// Output: public/data/tenders.json, public/data/meta.json, public/data/cards/*.md

import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync } from 'fs';
import { join } from 'path';

const runDate = process.argv[2] || '2026-05-25';
const processedDir = `data/processed/${runDate}`;
const analysisDir = `data/analysis/${runDate}`;
const cardsDir = `${analysisDir}/product-cards`;
const outDir = 'public/data';
const outCardsDir = `${outDir}/cards`;

function parseCsvRow(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && !inQuotes) { inQuotes = true; continue; }
    if (ch === '"' && inQuotes) {
      if (line[i + 1] === '"') { current += '"'; i++; continue; }
      inQuotes = false; continue;
    }
    if (ch === ',' && !inQuotes) { cells.push(current); current = ''; continue; }
    current += ch;
  }
  cells.push(current);
  return cells;
}

function parseCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = parseCsvRow(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvRow(line);
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
  });
}

// Build merged tenders array (same logic as serve-analysis.js)
const fullText = readFileSync(`${processedDir}/full-tenders.csv`, 'utf8');
const requirementsText = existsSync(`${analysisDir}/tender-requirements.csv`)
  ? readFileSync(`${analysisDir}/tender-requirements.csv`, 'utf8')
  : '';

const base = parseCsv(fullText);
const requirements = requirementsText ? parseCsv(requirementsText) : [];
const reqMap = new Map([
  ...requirements.map(r => [r.tender_id, r]),
  ...requirements.map(r => [r.tenderguru_card_id, r]),
].filter(([k]) => k));

const tenders = base.map(c => ({
  ...c,
  budget_rub: c.budget_rub || c.price || c.ob_price || '',
  ...(reqMap.get(c.tender_id) || reqMap.get(c.tenderguru_card_id) || {}),
  has_card: reqMap.has(c.tender_id) || reqMap.has(c.tenderguru_card_id),
}));

// Write output
mkdirSync(outCardsDir, { recursive: true });

writeFileSync(`${outDir}/tenders.json`, JSON.stringify(tenders));
writeFileSync(`${outDir}/meta.json`, JSON.stringify({ date: runDate }));

// Copy product cards
let copied = 0;
if (existsSync(cardsDir)) {
  for (const file of readdirSync(cardsDir)) {
    if (file.endsWith('.md')) {
      copyFileSync(join(cardsDir, file), join(outCardsDir, file));
      copied++;
    }
  }
}

console.log(`tenders.json: ${tenders.length} records`);
console.log(`cards: ${copied} files`);
console.log(`Output: ${outDir}/`);
