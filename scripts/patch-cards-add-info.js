#!/usr/bin/env node
/**
 * Appends the decoded info_text (TenderGuru HTML description) to the end of every product card.
 * Safe to re-run: replaces the section if it already exists.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const runDate = getArg('date', '2026-05-25');
const cardsDir = `data/analysis/${runDate}/product-cards`;
const fullCsvPath = `data/processed/${runDate}/full-tenders.csv`;

const full = parseCsv(await readFile(fullCsvPath, 'utf8'));

// Build lookup: tender_id and tenderguru_card_id -> row
const byId = new Map();
for (const row of full) {
  if (row.tender_id) byId.set(row.tender_id, row);
  if (row.tenderguru_card_id) byId.set(row.tenderguru_card_id, row);
}

const files = (await readdir(cardsDir)).filter(f => f.endsWith('.md'));
let patched = 0, skipped = 0;

for (const file of files) {
  const cardPath = join(cardsDir, file);
  const tenderId = file.replace(/\.md$/, '').replace(/_/g, (_, i, s) => {
    // safeName replaces non-alphanum with _, try to find match by scanning
    return '_';
  });

  // Try to find by the raw filename stem (may have underscores from safeName)
  const stem = file.replace(/\.md$/, '');
  const row = byId.get(stem) || findByStem(stem);

  if (!row || !row.info_text || row.info_text.length < 50) {
    skipped++;
    continue;
  }

  const decoded = stripHtml(decodeEntities(row.info_text));
  const section = `\n## Описание тендера (TenderGuru)\n\n${decoded}\n`;

  let content = await readFile(cardPath, 'utf8');

  // Remove old section if present, then append fresh
  content = content.replace(/\n## Описание тендера \(TenderGuru\)[\s\S]*$/, '');
  content = content.trimEnd() + '\n' + section;

  await writeFile(cardPath, content, 'utf8');
  patched++;

  if (patched % 50 === 0) console.log(`  patched ${patched}…`);
}

console.log(`Done: ${patched} patched, ${skipped} skipped (no info_text)`);

function findByStem(stem) {
  // The safeName function replaces non-alphanumeric with _, so we match by checking
  // if the tender_id when sanitized equals the stem
  for (const [id, row] of byId.entries()) {
    if (safeName(id) === stem) return row;
  }
  return null;
}

function safeName(v) {
  return String(v || '').replace(/[^a-zA-Zа-яА-Я0-9_.-]+/g, '_');
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripHtml(s) {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseCsv(content) {
  const records = [];
  let field = '', record = [], inQ = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i], n = content[i + 1];
    if (inQ && c === '"' && n === '"') { field += '"'; i++; continue; }
    if (c === '"') { inQ = !inQ; continue; }
    if (!inQ && c === ',') { record.push(field); field = ''; continue; }
    if (!inQ && (c === '\n' || c === '\r')) {
      if (c === '\r' && n === '\n') i++;
      record.push(field); records.push(record); field = ''; record = [];
      continue;
    }
    field += c;
  }
  if (field || record.length) { record.push(field); records.push(record); }
  const [headers, ...data] = records.filter(r => r.some(v => v !== ''));
  if (!headers) return [];
  return data.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] || ''])));
}

function getArg(name, def) {
  const prefix = `--${name}=`;
  return process.argv.find(a => a.startsWith(prefix))?.slice(prefix.length) || def;
}
