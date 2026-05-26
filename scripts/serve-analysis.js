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

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function notFound(res, msg = 'Not found') {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end(msg);
}

async function buildAllTenders() {
  const [fullText, requirementsText] = await Promise.all([
    readFile(`${processedDir}/full-tenders.csv`, 'utf8').catch(() => ''),
    readFile(`${analysisDir}/tender-requirements.csv`, 'utf8').catch(() => ''),
  ]);
  const baseText = fullText || await readFile(`${processedDir}/classified-tenders.csv`, 'utf8');
  const base = parseCsv(baseText);
  const requirements = requirementsText ? parseCsv(requirementsText) : [];
  const reqMap = new Map([
    ...requirements.map(r => [r.tender_id, r]),
    ...requirements.map(r => [r.tenderguru_card_id, r]),
  ].filter(([k]) => k));

  return base.map(c => ({
    ...c,
    budget_rub: c.budget_rub || c.price || c.ob_price || '',
    ...(reqMap.get(c.tender_id) || reqMap.get(c.tenderguru_card_id) || {}),
    has_card: reqMap.has(c.tender_id) || reqMap.has(c.tenderguru_card_id),
  }));
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
