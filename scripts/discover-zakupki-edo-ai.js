#!/usr/bin/env node
/**
 * Discovers zakupki.gov.ru tenders around EDO/document automation/Document AI.
 * Runs a query matrix against registry cards and attached-file search, then
 * deduplicates and classifies results with src/edo-scoring.js.
 *
 * Usage:
 *   node scripts/discover-zakupki-edo-ai.js
 *   node scripts/discover-zakupki-edo-ai.js --date-from=01.01.2026 --date-to=30.05.2026 --pages=2
 *   node scripts/discover-zakupki-edo-ai.js --headless=false --queries="электронный документооборот|OCR"
 */
import { firefox } from 'playwright';
import { loadDotEnv } from '../src/env.js';
import { appendJsonl, cleanText, ensureDir, writeCsv, writeJsonl } from '../src/export-utils.js';
import { startRelay } from '../src/socks5-relay.js';
import { EDO_QUERIES, scoreEdoCandidate } from '../src/edo-scoring.js';

loadDotEnv();

const today = new Date();
const defaultDateTo = formatRuDate(today);
const defaultDateFrom = formatRuDate(addYears(today, -1));

const DATE_FROM = getArg('date-from', defaultDateFrom);
const DATE_TO = getArg('date-to', defaultDateTo);
const OUT_DATE = getArg('out-date', formatIsoDate(today));
const HEADLESS = getArg('headless', 'true') !== 'false';
const PAGES = Number(getArg('pages', '1'));
const PER_PAGE = Number(getArg('per-page', '50'));
const MIN_SCORE = Number(getArg('min-score', '5'));
const INCLUDE_NOISE = getBoolArg('include-noise', false);
const INCLUDE_ATTACHED = getBoolArg('attached', true);
const INCLUDE_CARD = getBoolArg('card', true);
const QUERY_FILTER = getArg('queries', '');
const PAGE_DELAY_MS = Number(getArg('page-delay-ms', '1200'));

const processedDir = `data/processed/${OUT_DATE}`;
const rawDir = `data/raw/zakupki/${OUT_DATE}`;
ensureDir(processedDir);
ensureDir(rawDir);

const rawJsonl = `${rawDir}/edo-ai-search-results.jsonl`;
const outJsonl = `${processedDir}/zakupki-edo-ai-candidates.jsonl`;
const outCsv = `${processedDir}/zakupki-edo-ai-candidates.csv`;
const relevantJsonl = `${processedDir}/zakupki-edo-ai-relevant.jsonl`;
const relevantCsv = `${processedDir}/zakupki-edo-ai-relevant.csv`;

writeJsonl(rawJsonl, []);

const queries = buildQueries();
const modes = [
  ...(INCLUDE_CARD ? ['card'] : []),
  ...(INCLUDE_ATTACHED ? ['attached_file'] : []),
];

if (queries.length === 0 || modes.length === 0) {
  console.error('No queries or search modes selected.');
  process.exit(1);
}

const pm = (process.env.ALL_PROXY || '').match(/socks5h?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)/);
let relay = null;
let launchProxy;

if (pm) {
  relay = await startRelay(pm[1], pm[2], pm[3], Number(pm[4]));
  launchProxy = { server: `socks5://localhost:${relay.port}` };
  console.log(`Proxy relay: localhost:${relay.port} -> ${pm[3]}:${pm[4]}`);
} else {
  console.warn('No ALL_PROXY found - connecting directly');
}

const browser = await firefox.launch({ headless: HEADLESS, proxy: launchProxy });
const page = await browser.newPage();
page.setDefaultTimeout(30_000);

const candidates = new Map();

console.log(`EDO/Document AI discovery: ${DATE_FROM} -> ${DATE_TO}`);
console.log(`Queries: ${queries.length}, modes: ${modes.join(', ')}, pages/query: ${PAGES}\n`);

try {
  for (const item of queries) {
    for (const mode of modes) {
      for (let pageNum = 1; pageNum <= PAGES; pageNum += 1) {
        await collectPage(page, item, mode, pageNum);
      }
    }
  }
} finally {
  await browser.close();
  if (relay) relay.stop();
}

const allRows = [...candidates.values()]
  .map(toScoredRow)
  .sort((a, b) => b.score - a.score || compareDates(b.publish_date, a.publish_date));
const relevantRows = allRows.filter((row) => INCLUDE_NOISE || (row.relevant === 'yes' && Number(row.score) >= MIN_SCORE));

writeJsonl(outJsonl, allRows);
writeCsv(outCsv, allRows);
writeJsonl(relevantJsonl, relevantRows);
writeCsv(relevantCsv, relevantRows);

console.log(`\nDone. Unique candidates: ${allRows.length}`);
console.log(`Relevant candidates: ${relevantRows.length}`);
console.log(`Wrote ${outCsv}`);
console.log(`Wrote ${relevantCsv}`);
process.exit(0);

async function collectPage(page, queryItem, mode, pageNum) {
  const url = buildUrl(queryItem.query, mode, pageNum);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForTimeout(PAGE_DELAY_MS + Math.random() * 700);
    await page.waitForSelector('.search-registry-entry-block', { timeout: 15_000 }).catch(() => null);

    const rows = await scrapePage(page, { queryItem, mode, pageNum });
    for (const row of rows) {
      appendJsonl(rawJsonl, { ...row, url });
    }

    for (const row of rows) {
      upsertCandidate(row);
    }

    process.stdout.write(`\r${queryItem.query} | ${mode} | page ${pageNum}/${PAGES} | total ${candidates.size}   `);
  } catch (error) {
    console.warn(`\nSkipped ${queryItem.query} ${mode} page ${pageNum}: ${cleanText(error.message).slice(0, 160)}`);
  }
}

async function scrapePage(page, { queryItem, mode, pageNum }) {
  return page.evaluate(({ query, group, mode: sourceMode, pageNum: pn }) => {
    const rows = [];

    for (const card of document.querySelectorAll('.search-registry-entry-block')) {
      try {
        const t = (sel) => card.querySelector(sel)?.textContent?.replace(/\s+/g, ' ')?.trim() || '';
        const numEl = card.querySelector('.registry-entry__header-mid__number a');
        const tenderNum = numEl?.textContent?.replace(/[^\d]/g, '') || '';
        const tenderLink = numEl?.href || '';
        const fz = t('.registry-entry__header-top__title').split('\n')[0].trim();
        const status = t('.registry-entry__header-mid__title');
        const name = t('.registry-entry__body-value');
        const customer = t('.registry-entry__body-href a') || t('.registry-entry__body-href');
        const price = t('.price-block__value')
          .replace(/\u00a0/g, '')
          .replace(/\s/g, '')
          .replace('₽', '')
          .replace(',', '.')
          .trim();
        const dataTitles = [...card.querySelectorAll('.data-block__title')].map((e) => e.textContent.trim());
        const dataValues = [...card.querySelectorAll('.data-block__value')].map((e) => e.textContent.trim());
        const cardText = card.textContent?.replace(/\s+/g, ' ')?.trim() || '';

        let publishDate = '';
        let deadline = '';
        dataTitles.forEach((title, i) => {
          const v = dataValues[i] || '';
          if (title.includes('Размещено')) publishDate = v;
          if (title.includes('Окончание') || title.includes('подачи')) deadline = v;
        });

        rows.push({
          page: pn,
          query,
          group,
          source: sourceMode,
          tender_num: tenderNum,
          fz,
          status,
          name,
          customer,
          price_rub: price,
          publish_date: publishDate,
          deadline,
          tender_link: tenderLink,
          card_text: cardText,
        });
      } catch {
        // Skip malformed cards.
      }
    }

    return rows;
  }, {
    query: queryItem.query,
    group: queryItem.group,
    mode,
    pageNum,
  });
}

function upsertCandidate(row) {
  const id = row.tender_num || row.tender_link || `${row.name}:${row.customer}`;
  const current = candidates.get(id) || {
    id,
    tender_num: row.tender_num,
    fz: row.fz,
    status: row.status,
    name: row.name,
    customer: row.customer,
    price_rub: row.price_rub,
    publish_date: row.publish_date,
    deadline: row.deadline,
    tender_link: row.tender_link,
    cardText: '',
    searchText: '',
    queries: new Set(),
    groups: new Set(),
    sources: new Set(),
  };

  current.fz = current.fz || row.fz;
  current.status = current.status || row.status;
  current.name = current.name || row.name;
  current.customer = current.customer || row.customer;
  current.price_rub = current.price_rub || row.price_rub;
  current.publish_date = current.publish_date || row.publish_date;
  current.deadline = current.deadline || row.deadline;
  current.tender_link = current.tender_link || row.tender_link;
  current.cardText = [current.cardText, row.card_text].filter(Boolean).join('\n');
  current.searchText = [current.searchText, row.query, row.group].filter(Boolean).join('\n');
  current.queries.add(row.query);
  current.groups.add(row.group);
  current.sources.add(row.source);

  candidates.set(id, current);
}

function toScoredRow(candidate) {
  const scored = scoreEdoCandidate(candidate);
  return {
    tender_num: candidate.tender_num || '',
    classification: scored.classification,
    relevant: scored.relevant ? 'yes' : 'no',
    score: String(scored.score),
    reason: scored.reason,
    domain_terms: scored.domain_terms.join('; '),
    ai_automation_terms: scored.ai_automation_terms.join('; '),
    platform_terms: scored.platform_terms.join('; '),
    negative_terms: scored.negative_terms.join('; '),
    queries: [...candidate.queries].join(' | '),
    groups: [...candidate.groups].join('; '),
    sources: [...candidate.sources].join('; '),
    fz: candidate.fz || '',
    status: candidate.status || '',
    name: candidate.name || '',
    customer: candidate.customer || '',
    price_rub: candidate.price_rub || '',
    publish_date: candidate.publish_date || '',
    deadline: candidate.deadline || '',
    tender_link: candidate.tender_link || '',
  };
}

function buildUrl(query, mode, pageNum) {
  const params = new URLSearchParams({
    morphology: 'on',
    sortBy: 'UPDATE_DATE',
    pageNumber: String(pageNum),
    sortDirection: 'false',
    recordsPerPage: `_${PER_PAGE}`,
    showLotsInfoHidden: 'false',
    fz44: 'on',
    fz223: 'on',
    af: 'on',
    ca: 'on',
    pc: 'on',
    pa: 'on',
    currencyIdGeneral: '-1',
    publishDateFrom: DATE_FROM,
    publishDateTo: DATE_TO,
  });

  params.set('searchString', query);
  if (mode === 'attached_file') {
    params.set('searchTextInAttachedFile', query);
  }

  return `https://zakupki.gov.ru/epz/order/extendedsearch/results.html?${params}`;
}

function buildQueries() {
  if (!QUERY_FILTER) return EDO_QUERIES;
  return QUERY_FILTER
    .split('|')
    .map((query) => query.trim())
    .filter(Boolean)
    .map((query) => ({ query, group: 'custom' }));
}

function compareDates(left, right) {
  return dateNumber(left) - dateNumber(right);
}

function dateNumber(value) {
  const match = String(value || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!match) return 0;
  return Number(`${match[3]}${match[2]}${match[1]}`);
}

function addYears(date, years) {
  const next = new Date(date);
  next.setFullYear(next.getFullYear() + years);
  return next;
}

function formatRuDate(date) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${d}.${m}.${date.getFullYear()}`;
}

function formatIsoDate(date) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

function getArg(name, fallback = '') {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function getBoolArg(name, fallback = false) {
  const value = getArg(name, '');
  if (!value) return fallback;
  return !['false', '0', 'no'].includes(value.toLowerCase());
}
