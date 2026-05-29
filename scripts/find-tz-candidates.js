#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { cleanText, ensureDir, writeCsv, writeJsonl } from '../src/export-utils.js';

const runDate = getArg('date', '2026-05-25');
const docsDir = getArg('docs-dir', `data/raw/tenderguru/${runDate}/docs`);
const classifiedPath = getArg('classified', `data/processed/${runDate}/classified-tenders.csv`);
const outputDir = getArg('output', `data/analysis/${runDate}/tz-candidates`);
const onlyTender = getArg('only', '');
const minScore = Number(getArg('min-score', '4'));
const onlyTenderIds = parseOnlyIds(onlyTender);

ensureDir(outputDir);

const tenders = existsSync(classifiedPath) ? parseCsv(await readFile(classifiedPath, 'utf8')) : [];
const tenderById = new Map(
  tenders.flatMap((row) => [row.tender_id, row.tenderguru_card_id].filter(Boolean).map((id) => [id, row])),
);

const tenderDirs = await readdir(docsDir, { withFileTypes: true });
const candidateRows = [];
const summaryRows = [];

for (const entry of tenderDirs) {
  if (!entry.isDirectory()) continue;

  const tenderId = entry.name;
  const tender = tenderById.get(tenderId) || {};
  if (onlyTenderIds.length > 0 && ![tenderId, tender.tenderguru_card_id || ''].some((id) => onlyTenderIds.includes(id))) {
    continue;
  }

  const docs = await collectTenderDocs(join(docsDir, tenderId));
  const strictHits = docs.filter((doc) => doc.score.strict >= minScore);
  const broadHits = docs.filter((doc) => doc.score.broad >= minScore);

  summaryRows.push({
    tender_id: tenderId,
    tenderguru_card_id: tender.tenderguru_card_id || '',
    tender_name: cleanText(tender.tender_name || ''),
    customer: cleanText(tender.customer || ''),
    docs_total: String(docs.length),
    strict_hits: String(strictHits.length),
    broad_hits: String(broadHits.length),
    status: strictHits.length > 0 ? 'strict_hit' : broadHits.length > 0 ? 'broad_hit' : 'none',
  });

  if (strictHits.length > 0) {
    candidateRows.push(...strictHits.map((doc) => toCandidateRow(tenderId, tender, doc, 'strict_hit')));
    continue;
  }

  if (broadHits.length > 0) {
    candidateRows.push(...broadHits.map((doc) => toCandidateRow(tenderId, tender, doc, 'broad_hit')));
  }
}

writeCsv(join(outputDir, 'tz-candidates.csv'), candidateRows);
writeJsonl(join(outputDir, 'tz-candidates.jsonl'), candidateRows);
writeCsv(join(outputDir, 'tz-summary.csv'), summaryRows);

console.log(`Tenders scanned: ${summaryRows.length}`);
console.log(`Tenders with strict TZ hit: ${summaryRows.filter((row) => row.status === 'strict_hit').length}`);
console.log(`Tenders with broad TZ hit: ${summaryRows.filter((row) => row.status === 'broad_hit').length}`);
console.log(`Candidates: ${candidateRows.length}`);
console.log(`CSV: ${join(outputDir, 'tz-candidates.csv')}`);

async function collectTenderDocs(tenderDir) {
  const paths = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (entry.isFile() && /\.(txt|html|docx|doc)$/i.test(entry.name)) {
        paths.push(fullPath);
      }
    }
  }

  await walk(tenderDir);

  const docs = [];
  for (const path of paths) {
    const text = await readDocText(path);
    if (!text) continue;
    const score = scoreDoc(path, text);
    docs.push({
      path,
      name: basename(path),
      text,
      score,
    });
  }

  return docs;
}

async function readDocText(path) {
  if (path.endsWith('.txt')) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return '';
    }
  }

  if (/\.docx$/i.test(path)) {
    try {
      const { stdout } = await import('node:child_process').then(({ execFile }) => new Promise((resolve, reject) => {
        execFile('unzip', ['-p', path, 'word/document.xml'], { maxBuffer: 50 * 1024 * 1024 }, (error, out) => (
          error ? reject(error) : resolve({ stdout: out })
        ));
      }));
      return cleanDocxXml(stdout);
    } catch {
      return '';
    }
  }

  if (/\.html$/i.test(path)) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return '';
    }
  }

  return '';
}

function scoreDoc(path, text) {
  const head = normalizeForMatch(text.slice(0, 8000));
  const name = normalizeForMatch(basename(path));
  const hitMap = [
    [/^техническое\s+задание\b/i, 6],
    [/^частное\s+техническое\s+задание\b/i, 6],
    [/^описание\s+объекта\s+закупки\b/i, 5],
    [/\bтехническое\s+задание\b/i, 4],
    [/\bчастное\s+техническое\s+задание\b/i, 4],
    [/\bописание\s+объекта\s+закупки\b/i, 4],
    [/\bчтз\b/i, 4],
    [/техническ[а-я]+\s+задани[ея]/i, 4],
    [/описание[-_\s]+объекта[-_\s]+закупки/i, 4],
    [/задание\s+на\s+(оказание|выполнение|поставку)/i, 3],
    [/техническ/i, 2],
    [/задани/i, 1],
    [/предмет\s+закупки/i, 1],
    [/требован/i, 1],
    [/спецификац/i, 1],
  ];

  let broad = 0;
  let strict = 0;
  const reasons = [];

  for (const [pattern, score] of hitMap) {
    if (pattern.test(head) || pattern.test(name)) {
      broad += score;
      reasons.push(pattern.source);
      if (score >= 4) strict += 1;
    }
  }

  if (/^договор|^контракт|^документация об аукционе/i.test(head)) {
    broad -= 2;
  }

  return { broad: Math.max(broad, 0), strict, reasons: [...new Set(reasons)].slice(0, 6) };
}

function toCandidateRow(tenderId, tender, doc, hitType) {
  const snippet = bestSnippet(doc.text);
  return {
    tender_id: tenderId,
    tenderguru_card_id: tender.tenderguru_card_id || '',
    tender_name: cleanText(tender.tender_name || ''),
    customer: cleanText(tender.customer || ''),
    hit_type: hitType,
    file_path: doc.path,
    file_name: doc.name,
    score: String(doc.score.broad),
    strict_hits: String(doc.score.strict),
    reasons: doc.score.reasons.join(' | '),
    snippet,
  };
}

function bestSnippet(text) {
  const lines = String(text || '').split(/\n+/).map(cleanText).filter(Boolean);
  const preferred = lines.find((line) => /техническое задание|частное техническое задание|описание объекта закупки|чтз/i.test(line));
  return preferred || lines.find((line) => /техническ|задани|предмет закупки|требован|спецификац/i.test(line)) || '';
}

function cleanDocxXml(xml) {
  return String(xml || '')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[`'’"«»]/g, ' ')
    .replace(/[_./\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCsv(content) {
  const rows = [];
  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (inQuotes && char === '"' && next === '"') {
      field += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && char === ',') {
      record.push(field);
      field = '';
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') index += 1;
      record.push(field);
      records.push(record);
      field = '';
      record = [];
      continue;
    }

    field += char;
  }

  if (field || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const [headers, ...data] = records.filter((item) => item.some((value) => value !== ''));
  for (const item of data) {
    rows.push(Object.fromEntries(headers.map((header, index) => [header, item[index] || ''])));
  }

  return rows;
}

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function parseOnlyIds(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}
