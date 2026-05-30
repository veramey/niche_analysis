#!/usr/bin/env node
/**
 * Scrapes zakupki.gov.ru for all tenders matching "искусственный интеллект"
 * published in the last year. Two passes: by name/description + by attached files.
 * Firefox via Playwright + SOCKS5 relay (no auth locally).
 *
 * Usage:
 *   node scripts/scrape-zakupki.js
 *   node scripts/scrape-zakupki.js --date-from=29.05.2025 --date-to=29.05.2026
 *   node scripts/scrape-zakupki.js --headless=false
 */
import { firefox } from 'playwright';
import { loadDotEnv } from '../src/env.js';
import { ensureDir, writeCsv, writeJsonl } from '../src/export-utils.js';
import { startRelay } from '../src/socks5-relay.js';

loadDotEnv();

const DATE_FROM     = getArg('date-from', '29.05.2025');
const DATE_TO       = getArg('date-to',   '29.05.2026');
const HEADLESS      = getArg('headless',  'true') !== 'false';
const KEYWORD       = 'искусственный интеллект';
const OUT_DATE      = '2026-05-29';
const PER_PAGE      = 50;
const RETRY_MAX     = 3;
const PAGE_DELAY_MS = 2000;


const processedDir = `data/processed/${OUT_DATE}`;
ensureDir(processedDir);
ensureDir(`data/raw/tenderguru/${OUT_DATE}`);

const outJsonl = `${processedDir}/zakupki-ai-year.jsonl`;
const outCsv   = `${processedDir}/zakupki-ai-year.csv`;

// ── proxy setup ───────────────────────────────────────────────────────────────

const pm = (process.env.ALL_PROXY || '').match(/socks5h?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)/);
let relay = null;
let launchProxy;

if (pm) {
  relay = await startRelay(pm[1], pm[2], pm[3], Number(pm[4]));
  launchProxy = { server: `socks5://localhost:${relay.port}` };
  console.log(`Proxy relay: localhost:${relay.port} → ${pm[3]}:${pm[4]}`);
} else {
  console.warn('No ALL_PROXY found — connecting directly');
}

// ── browser ───────────────────────────────────────────────────────────────────

const browser = await firefox.launch({ headless: HEADLESS, proxy: launchProxy });
const page    = await browser.newPage();
page.setDefaultTimeout(30_000);

// ── scrape ────────────────────────────────────────────────────────────────────

console.log(`\nKeyword: "${KEYWORD}"   ${DATE_FROM} → ${DATE_TO}\n`);

await page.goto(buildUrl(1), { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(2000);

const totalText  = await page.locator('[class*="total"]').first().textContent().catch(() => '');
const totalMatch = totalText.match(/(\d[\d\s]*)/);
const totalCount = totalMatch ? Number(totalMatch[1].replace(/\s/g, '')) : 0;
const totalPages = totalCount ? Math.ceil(totalCount / PER_PAGE) : 999;
console.log(`Total: ${totalCount}  (${totalPages} pages)\n`);

const allRows = [];
writeJsonl(outJsonl, []);

for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
  let rows = [];

  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    try {
      if (pageNum > 1 || attempt > 1) {
        await page.goto(buildUrl(pageNum), { waitUntil: 'domcontentloaded', timeout: 90_000 });
        await page.waitForTimeout(PAGE_DELAY_MS + Math.random() * 1000);
      }
      await page.waitForSelector('.search-registry-entry-block', { timeout: 25_000 }).catch(() => null);
      rows = await scrapePage(page, { pageNum });
      break;
    } catch (err) {
      console.warn(`\n  page ${pageNum} attempt ${attempt} failed: ${err.message.split('\n')[0]}`);
      if (attempt < RETRY_MAX) await page.waitForTimeout(5000 * attempt);
    }
  }

  if (rows.length === 0) {
    console.log(`\nPage ${pageNum}: no cards — stopping`);
    break;
  }

  allRows.push(...rows);
  writeJsonl(outJsonl, allRows);
  process.stdout.write(`\rPage ${pageNum}/${totalPages}   collected: ${allRows.length}   `);
}

// ── final output ──────────────────────────────────────────────────────────────

const finalRows = allRows;
console.log(`\nDone. Total: ${finalRows.length}`);

writeJsonl(outJsonl, finalRows);
writeCsv(outCsv, finalRows);
console.log(`Wrote ${outJsonl}`);
console.log(`Wrote ${outCsv}`);

await browser.close();
if (relay) relay.stop();

// ── card scraper ──────────────────────────────────────────────────────────────

async function scrapePage(page, { pageNum }) {
  return page.evaluate(({ pn }) => {
    const rows = [];

    for (const card of document.querySelectorAll('.search-registry-entry-block')) {
      try {
        const t = (sel) => card.querySelector(sel)?.textContent?.replace(/\s+/g, ' ')?.trim() || '';

        const fz        = t('.registry-entry__header-top__title').split('\n')[0].trim();
        const numEl     = card.querySelector('.registry-entry__header-mid__number a');
        const tenderNum = numEl?.textContent?.replace(/[^\d]/g, '') || '';
        const tenderLink = numEl?.href || '';
        const status    = t('.registry-entry__header-mid__title');
        const name      = t('.registry-entry__body-value');
        const customer  = t('.registry-entry__body-href a') || t('.registry-entry__body-href');
        const price     = t('.price-block__value')
          .replace(/ /g, '').replace(/\s/g, '').replace('₽', '').replace(',', '.').trim();

        const dataTitles = [...card.querySelectorAll('.data-block__title')].map(e => e.textContent.trim());
        const dataValues = [...card.querySelectorAll('.data-block__value')].map(e => e.textContent.trim());

        let publishDate = '', deadline = '';
        dataTitles.forEach((title, i) => {
          const v = dataValues[i] || '';
          if (title.includes('Размещено')) publishDate = v;
          if (title.includes('Окончание') || title.includes('подачи')) deadline = v;
        });

        rows.push({ page: pn, fz, tender_num: tenderNum, status, name, customer, price_rub: price, publish_date: publishDate, deadline, tender_link: tenderLink });
      } catch { /* skip malformed */ }
    }

    return rows;
  }, { pn: pageNum });
}

// ── URL builder ───────────────────────────────────────────────────────────────

function buildUrl(pageNum) {
  const p = new URLSearchParams({
    searchString:              KEYWORD,
    morphology:                'on',
    sortBy:                    'UPDATE_DATE',
    pageNumber:                String(pageNum),
    sortDirection:             'false',
    recordsPerPage:            `_${PER_PAGE}`,
    showLotsInfoHidden:        'false',
    fz44:                      'on',
    fz223:                     'on',
    af:                        'on',
    ca:                        'on',
    pc:                        'on',
    pa:                        'on',
    currencyIdGeneral:         '-1',
    searchTextInAttachedFile:  KEYWORD,
    publishDateFrom:           DATE_FROM,
    publishDateTo:             DATE_TO,
  });
  return `https://zakupki.gov.ru/epz/order/extendedsearch/results.html?${p}`;
}

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find(a => a.startsWith(prefix))?.slice(prefix.length) || fallback;
}
