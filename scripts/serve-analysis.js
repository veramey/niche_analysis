#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { loadDotEnv } from '../src/env.js';

loadDotEnv();

const PORT = Number(process.env.PORT || 3456);
const runDate = process.argv[2] || '2026-05-25';
const processedDir = `data/processed/${runDate}`;
const analysisDir = `data/analysis/${runDate}`;
const cardsDir = `${analysisDir}/product-cards`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

function parseCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = parseCsvRow(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvRow(line);
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
  });
}

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

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function notFound(res, msg = 'Not found') {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end(msg);
}

async function buildAllTenders() {
  const [fullText, classifiedWithSpheresText, classifiedText, requirementsText, spheresText] = await Promise.all([
    readFile(`${processedDir}/full-tenders.csv`, 'utf8').catch(() => ''),
    readFile(`${processedDir}/classified-tenders-with-spheres.csv`, 'utf8').catch(() => ''),
    readFile(`${processedDir}/classified-tenders.csv`, 'utf8').catch(() => ''),
    readFile(`${analysisDir}/tender-requirements.csv`, 'utf8').catch(() => ''),
    readFile(`${analysisDir}/sphere-classifications.csv`, 'utf8').catch(() => ''),
  ]);
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

  return base.map(c => {
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
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    if (path === '/api/tenders') {
      const data = await buildAllTenders();
      return json(res, data);
    }

    if (path === '/api/niches') {
      const text = await readFile(`${analysisDir}/niches-summary.csv`, 'utf8');
      return json(res, parseCsv(text));
    }

    if (path.startsWith('/api/card/')) {
      const id = decodeURIComponent(path.replace('/api/card/', ''));
      const cardPath = `${cardsDir}/${id}.md`;
      if (!existsSync(cardPath)) return notFound(res, 'Card not found');
      const text = await readFile(cardPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(text);
    }

    if (path === '/api/meta') {
      return json(res, { date: runDate, analysisDir });
    }

    const filePath = join('public', path === '/' ? 'index.html' : path);
    if (existsSync(filePath)) {
      const ext = extname(filePath);
      const mime = MIME[ext] || 'application/octet-stream';
      const content = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': mime });
      return res.end(content);
    }

    const index = await readFile('public/index.html', 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(index);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Error: ${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`Analysis dashboard: http://localhost:${PORT}`);
  console.log(`Date: ${runDate}`);
});
