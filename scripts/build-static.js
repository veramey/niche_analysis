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

function readOptional(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function addRowsToMap(map, rows) {
  for (const row of rows) {
    for (const key of [row.tender_id, row.tenderguru_card_id, row.documentation_result_id]) {
      if (key && !map.has(key)) map.set(key, row);
    }
  }
}

function sphereFields(row = {}) {
  return {
    sphere: row.sphere || '',
    sphere_label: row.sphere_label || '',
    sphere_confidence: row.sphere_confidence || row.confidence || '',
    sphere_evidence: row.sphere_evidence || row.evidence || '',
    secondary_spheres: row.secondary_spheres || '',
    sphere_needs_review: row.sphere_needs_review || row.needs_review || '',
  };
}

// Build merged tenders array (same logic as serve-analysis.js)
const fullText = readOptional(`${processedDir}/full-tenders.csv`);
const classifiedWithSpheresText = readOptional(`${processedDir}/classified-tenders-with-spheres.csv`);
const classifiedText = readOptional(`${processedDir}/classified-tenders.csv`);
const requirementsText = existsSync(`${analysisDir}/tender-requirements.csv`)
  ? readFileSync(`${analysisDir}/tender-requirements.csv`, 'utf8')
  : '';
const spheresText = readOptional(`${analysisDir}/sphere-classifications.csv`);

const full = fullText ? parseCsv(fullText) : [];
const classified = parseCsv(classifiedWithSpheresText || classifiedText || fullText);
const base = classified.length ? classified : full;
const requirements = requirementsText ? parseCsv(requirementsText) : [];
const spheres = spheresText ? parseCsv(spheresText) : [];
const fullMap = new Map();
const reqMap = new Map([
  ...requirements.map(r => [r.tender_id, r]),
  ...requirements.map(r => [r.tenderguru_card_id, r]),
].filter(([k]) => k));
const sphereMap = new Map();
addRowsToMap(fullMap, full);
addRowsToMap(sphereMap, spheres);
addRowsToMap(sphereMap, base.filter(r => r.sphere || r.sphere_label));

const tenders = base.map(c => {
  const fullRow = fullMap.get(c.tender_id) || fullMap.get(c.tenderguru_card_id) || {};
  const reqRow = reqMap.get(c.tender_id) || reqMap.get(c.tenderguru_card_id) || {};
  const sphereRow = sphereMap.get(c.tender_id) || sphereMap.get(c.tenderguru_card_id) || {};
  return {
    ...fullRow,
    ...c,
    budget_rub: c.budget_rub || fullRow.budget_rub || c.price || fullRow.price || c.ob_price || fullRow.ob_price || '',
    ...reqRow,
    ...sphereFields({ ...c, ...sphereRow }),
    has_card: reqMap.has(c.tender_id) || reqMap.has(c.tenderguru_card_id),
  };
});

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
