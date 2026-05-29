#!/usr/bin/env node
import { loadDotEnv } from '../src/env.js';
import { TenderGuruClient } from '../src/tenderguru-client.js';
import {
  appendJsonl,
  cleanText,
  ensureDir,
  parseApiTenderInfo,
  redactSecrets,
  writeCsv,
  writeJsonl,
} from '../src/export-utils.js';

loadDotEnv();

const KEYWORD = '"искусственный интеллект"';
const DATE_FROM = getArg('date-from', '2025-05-29');
const DATE_TO = getArg('date-to', '2026-05-29');
const TENPAGE = 50;
const runDate = getArg('date', '2026-05-29');

const outDir = `data/raw/tenderguru/${runDate}`;
const processedDir = `data/processed/${runDate}`;
ensureDir(outDir);
ensureDir(processedDir);

const rawSearchPath = `${outDir}/ai-year-search.jsonl`;
const rawDocsPath = `${outDir}/ai-year-docs.jsonl`;
const outJsonl = `${processedDir}/ai-tenders-year.jsonl`;
const outCsv = `${processedDir}/ai-tenders-year.csv`;

writeJsonl(rawSearchPath, []);
writeJsonl(rawDocsPath, []);

const client = new TenderGuruClient();
const tenders = new Map();

// ── search endpoint ──────────────────────────────────────────────────────────

console.log(`Fetching search: ${KEYWORD}  ${DATE_FROM}→${DATE_TO}`);
let searchTotal = 0;
{
  const first = await fetchSearch(1);
  searchTotal = getTotal(first);
  console.log(`  search total: ${searchTotal}`);
  ingestItems(first, 'search');
  const totalPages = Math.ceil(searchTotal / TENPAGE);
  for (let page = 2; page <= totalPages; page++) {
    const items = await fetchSearch(page);
    ingestItems(items, 'search');
    process.stdout.write(`\r  search page ${page}/${totalPages}   `);
  }
  console.log();
}

// ── documentation endpoint ───────────────────────────────────────────────────

console.log(`Fetching documentation: ${KEYWORD}  ${DATE_FROM}→${DATE_TO}`);
let docsTotal = 0;
{
  const first = await fetchDocs(1);
  docsTotal = getTotal(first);
  console.log(`  docs total: ${docsTotal}`);
  ingestItems(first, 'documentation');
  const totalPages = Math.ceil(docsTotal / TENPAGE);
  for (let page = 2; page <= totalPages; page++) {
    const items = await fetchDocs(page);
    ingestItems(items, 'documentation');
    process.stdout.write(`\r  docs page ${page}/${totalPages}   `);
  }
  console.log();
}

// ── write output ─────────────────────────────────────────────────────────────

const rows = [...tenders.values()].sort((a, b) => {
  const da = parseDMY(a.date);
  const db = parseDMY(b.date);
  return db - da;
});

writeJsonl(outJsonl, rows);
writeCsv(outCsv, rows);

console.log(`\nUnique tenders: ${rows.length}`);
console.log(`Search hits: ${searchTotal}, Documentation hits: ${docsTotal}`);
console.log(`Wrote ${outJsonl}`);
console.log(`Wrote ${outCsv}`);

// ── helpers ───────────────────────────────────────────────────────────────────

async function fetchSearch(page) {
  try {
    const response = await client.searchTenders({
      kwords: KEYWORD,
      sort_by: 'by_date',
      sort_dest: 'desc',
      date1: DATE_FROM,
      date2: DATE_TO,
      page,
      tenpage: TENPAGE,
    });
    appendJsonl(rawSearchPath, { page, response });
    return response;
  } catch (err) {
    console.warn(`\n  search page ${page} error: ${cleanText(redactSecrets(err.message))}`);
    return [];
  }
}

async function fetchDocs(page) {
  try {
    const response = await client.request('/documentation', {
      kwords: KEYWORD,
      date1: DATE_FROM,
      date2: DATE_TO,
      page,
      tenpage: TENPAGE,
    }, { timeoutMs: 20000 });
    appendJsonl(rawDocsPath, { page, response });
    return response;
  } catch (err) {
    console.warn(`\n  docs page ${page} error: ${cleanText(redactSecrets(err.message))}`);
    return [];
  }
}

function getTotal(response) {
  const meta = Array.isArray(response) ? response.find(i => i && i.Total) : null;
  return meta ? Number(meta.Total) : 0;
}

function responseItems(response) {
  return (Array.isArray(response) ? response : []).filter(i => i && i.ID && !i.Total);
}

function ingestItems(response, source) {
  for (const item of responseItems(response)) {
    const apiInfo = parseApiTenderInfo(item.ApiTenderInfo);
    const tendNum = item.TenderNumOuter || apiInfo.tend_num || '';
    const innerId = source === 'documentation' ? apiInfo.id || '' : item.ID || apiInfo.id || '';
    const key = tendNum || innerId || item.ID || item.TenderName;

    const cur = tenders.get(key) || { sources: new Set(), docLinks: new Set() };

    Object.assign(cur, {
      tender_id: key,
      tenderguru_id: cur.tenderguru_id || innerId,
      tender_num: tendNum || cur.tender_num || '',
      date: item.Date || cur.date || '',
      name: cleanText(item.TenderName || cur.name || ''),
      customer: cleanText(item.Customer || cur.customer || ''),
      category: cleanText(item.Category || cur.category || ''),
      region: cleanText(item.Region || cur.region || ''),
      price: item.Price || cur.price || '',
      end_time: item.EndTime || cur.end_time || '',
      fz: item.Fz || cur.fz || '',
      etp: cleanText(item.Etp || cur.etp || ''),
      tender_link: item.TenderLink || cur.tender_link || '',
      tenderguru_link: item.TenderLinkInner || cur.tenderguru_link || '',
      fragment: cleanText(JSON.stringify(item.searchFragmentXML || '')),
    });

    cur.sources.add(source);
    if (item.DocLink1) cur.docLinks.add(item.DocLink1);
    if (item.DocLink2) cur.docLinks.add(item.DocLink2);

    tenders.set(key, cur);
  }
}

function parseDMY(str) {
  if (!str) return 0;
  const [d, m, y] = str.split('-');
  return new Date(`${y}-${m}-${d}`).getTime() || 0;
}

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find(a => a.startsWith(prefix))?.slice(prefix.length) || fallback;
}
