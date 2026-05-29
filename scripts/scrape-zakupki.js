#!/usr/bin/env node
/**
 * Scrapes zakupki.gov.ru for all tenders matching "искусственный интеллект"
 * published in the last year. Uses Firefox via Playwright + SOCKS5 proxy from .env.
 *
 * Usage:
 *   node scripts/scrape-zakupki.js
 *   node scripts/scrape-zakupki.js --date-from=2025-05-29 --date-to=2026-05-29
 *   node scripts/scrape-zakupki.js --headless=false   # watch the browser
 */
import { chromium } from 'playwright';
import { loadDotEnv } from '../src/env.js';
import { ensureDir, writeCsv, writeJsonl } from '../src/export-utils.js';

loadDotEnv();

const DATE_FROM  = getArg('date-from',  '29.05.2025');   // DD.MM.YYYY
const DATE_TO    = getArg('date-to',    '29.05.2026');
const HEADLESS   = getArg('headless',   'true') !== 'false';
const KEYWORD    = 'искусственный интеллект';
const OUT_DATE   = '2026-05-29';
const PER_PAGE   = 50;

const processedDir = `data/processed/${OUT_DATE}`;
const rawDir       = `data/raw/tenderguru/${OUT_DATE}`;
ensureDir(processedDir);
ensureDir(rawDir);

const outJsonl = `${processedDir}/zakupki-ai-year.jsonl`;
const outCsv   = `${processedDir}/zakupki-ai-year.csv`;

// Parse proxy from ALL_PROXY env  (socks5h://user:pass@host:port)
const proxyEnv = process.env.ALL_PROXY || '';
const proxyMatch = proxyEnv.match(/socks5h?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)/);
const proxy = proxyMatch ? {
  server:   `socks5://${proxyMatch[3]}:${proxyMatch[4]}`,
  username: proxyMatch[1],
  password: proxyMatch[2],
} : undefined;

if (proxy) {
  console.log(`Proxy: ${proxy.server}  user=${proxy.username}`);
} else {
  console.warn('No proxy found in ALL_PROXY — connecting directly');
}

const browser = await chromium.launch({
  headless: HEADLESS,
  proxy,
});

const context = await browser.newContext({
  locale:    'ru-RU',
  timezoneId: 'Europe/Moscow',
  userAgent:  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
});

const page = await context.newPage();

// Build initial search URL
const searchUrl = buildSearchUrl(1);
console.log(`\nOpening: ${searchUrl}\n`);

await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

// Check for captcha / access block
const title = await page.title();
console.log(`Page title: ${title}`);

if (title.toLowerCase().includes('captcha') || title.toLowerCase().includes('blocked')) {
  console.error('Access blocked or CAPTCHA detected. Try --headless=false to solve manually.');
  await browser.close();
  process.exit(1);
}

// Determine total pages
let totalCount = 0;
let totalPages = 1;

try {
  // zakupki.gov.ru shows total count like "Найдено: 641"
  const countEl = await page.locator('.search-results__state').first().textContent({ timeout: 15_000 }).catch(() => '');
  const countMatch = countEl.match(/[\d\s]+/);
  if (countMatch) {
    totalCount = Number(countMatch[0].replace(/\s/g, ''));
    totalPages = Math.ceil(totalCount / PER_PAGE);
    console.log(`Total results: ${totalCount}  (${totalPages} pages)`);
  }
} catch {
  console.log('Could not read total count, will scrape until no results');
}

const allTenders = [];

for (let pageNum = 1; pageNum <= Math.max(totalPages, 1); pageNum++) {
  if (pageNum > 1) {
    const url = buildSearchUrl(pageNum);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(1000 + Math.random() * 800);
  }

  const rows = await scrapePage(page, pageNum);

  if (rows.length === 0) {
    console.log(`\nNo rows on page ${pageNum}, stopping.`);
    break;
  }

  allTenders.push(...rows);
  process.stdout.write(`\rPage ${pageNum}/${totalPages}  collected: ${allTenders.length}   `);
}

console.log(`\n\nDone. Unique tenders scraped: ${allTenders.length}`);

writeJsonl(outJsonl, allTenders);
writeCsv(outCsv, allTenders);
console.log(`Wrote ${outJsonl}`);
console.log(`Wrote ${outCsv}`);

await browser.close();

// ── page scraper ─────────────────────────────────────────────────────────────

async function scrapePage(page, pageNum) {
  const rows = [];

  // Wait for result cards to appear
  await page.waitForSelector('.search-registry-entry-block, .registry-entry__body', {
    timeout: 20_000,
  }).catch(() => null);

  const cards = await page.$$('.search-registry-entry-block');

  for (const card of cards) {
    try {
      const tender = await card.evaluate((el) => {
        const text = (sel) => el.querySelector(sel)?.textContent?.trim() || '';
        const href = (sel) => el.querySelector(sel)?.href || '';

        // tender number + link
        const numEl = el.querySelector('.registry-entry__header-mid__number a, .tender-identifier a');
        const tenderNum = numEl?.textContent?.trim() || '';
        const tenderLink = numEl?.href || '';

        // name
        const name = text('.registry-entry__body-value') ||
                     text('.registry-entry__body-title') || '';

        // customer
        const customer = text('.registry-entry__body-href') ||
                         text('.customer-name') || '';

        // price
        const price = text('.price-block__value, .registry-entry__header-price') || '';

        // dates
        const dates = [...el.querySelectorAll('.data-block__value')]
          .map(e => e.textContent.trim());

        // fz type (44-ФЗ / 223-ФЗ etc.)
        const fz = text('.registry-entry__header-top__title') || '';

        // status
        const status = text('.registry-entry__header-mid__title') ||
                       text('.badge') || '';

        return { tenderNum, tenderLink, name, customer, price, dates, fz, status };
      });

      rows.push({
        page: pageNum,
        tender_num: tender.tenderNum,
        name: tender.name,
        customer: tender.customer,
        price: tender.price,
        fz: tender.fz,
        status: tender.status,
        dates: tender.dates.join(' | '),
        tender_link: tender.tenderLink,
      });
    } catch {
      // skip malformed card
    }
  }

  return rows;
}

// ── URL builder ───────────────────────────────────────────────────────────────

function buildSearchUrl(pageNum) {
  const params = new URLSearchParams({
    searchString: KEYWORD,
    morphology: 'on',
    'search-filter': 'Дата размещения',
    pageNumber: String(pageNum),
    sortDirection: 'false',
    recordsPerPage: `_${PER_PAGE}`,
    showLotsInfoOnly: 'false',
    sortBy: 'UPDATE_DATE',
    fz44: 'on',
    fz223: 'on',
    pc: 'on',
    fz615: 'on',
    currencyIdGeneral: '-1',
    publishDateFrom: DATE_FROM,
    publishDateTo: DATE_TO,
  });

  return `https://zakupki.gov.ru/epz/order/extendedsearch/results.html?${params}`;
}

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find(a => a.startsWith(prefix))?.slice(prefix.length) || fallback;
}
