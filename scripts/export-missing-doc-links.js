#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { ensureDir, writeCsv, writeJsonl } from '../src/export-utils.js';

const runDate = getArg('date', '2026-05-25');
const inputPath = getArg('input', `data/processed/${runDate}/full-tenders.jsonl`);
const outputPath = getArg('output', `data/processed/${runDate}/missing-doc-links.csv`);
const outputJsonlPath = getArg('output-jsonl', `data/processed/${runDate}/missing-doc-links.jsonl`);
const onlyZakupki = getBoolArg('only-zakupki', false);

const rows = [];
const jsonlRows = [];
const content = await readFile(inputPath, 'utf8');

for (const line of content.split('\n')) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  const docsCount = Number(row.docs_count || 0);
  const docLinks = String(row.doc_links || '').trim();

  if (docsCount !== 0) continue;
  if (!docLinks) continue;
  if (onlyZakupki && !/zakupki\.gov\.ru/i.test(docLinks)) continue;

  const exportRow = {
    tender_id: String(row.tender_id || ''),
    tenderguru_card_id: String(row.tenderguru_card_id || ''),
    niche: String(row.niche || ''),
    tender_name: String(row.tender_name || ''),
    doc_links_from_documentation_search: docLinks,
  };

  rows.push(exportRow);
  jsonlRows.push({
    ...exportRow,
    docs_count: String(row.docs_count || ''),
    docs_status: String(row.docs_status || ''),
  });
}

ensureDir(outputPath.replace(/\/[^/]+$/, ''));
ensureDir(outputJsonlPath.replace(/\/[^/]+$/, ''));
writeCsv(outputPath, rows);
writeJsonl(outputJsonlPath, jsonlRows);

console.log(`Missing-doc tenders exported: ${rows.length}`);
console.log(`CSV: ${outputPath}`);
console.log(`JSONL: ${outputJsonlPath}`);

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function getBoolArg(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}
