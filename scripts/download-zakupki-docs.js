#!/usr/bin/env node
/**
 * Downloads document lists (ТЗ and attachments) for each tender
 * in zakupki-ai-year-relevant.csv. Uses Firefox + SOCKS5 relay.
 *
 * Usage:
 *   node scripts/download-zakupki-docs.js
 *   node scripts/download-zakupki-docs.js --headless=false
 *   node scripts/download-zakupki-docs.js --only=32616004003
 *   node scripts/download-zakupki-docs.js --date=2026-05-30 --input=data/processed/2026-05-30/zakupki-edo-ai-relevant.csv --prefix=zakupki-edo-docs
 */
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { firefox } from 'playwright';
import { loadDotEnv } from '../src/env.js';
import { ensureDir, writeCsv, writeJsonl } from '../src/export-utils.js';
import { startRelay } from '../src/socks5-relay.js';

loadDotEnv();

const HEADLESS = getArg('headless', 'true') !== 'false';
const ONLY     = getArg('only', '');
const OUT_DATE = getArg('date', '2026-05-29');
const PREFIX   = getArg('prefix', 'zakupki-docs');

const inputCsv  = getArg('input', `data/processed/${OUT_DATE}/zakupki-ai-year-relevant.csv`);
const outDir    = getArg('output', `data/raw/${PREFIX}/${OUT_DATE}`);
const outJsonl  = getArg('out-jsonl', `data/processed/${OUT_DATE}/${PREFIX}.jsonl`);
const outCsv    = getArg('out-csv', `data/processed/${OUT_DATE}/${PREFIX}.csv`);

ensureDir(outDir);
ensureDir(`data/processed/${OUT_DATE}`);

// ── parse CSV ─────────────────────────────────────────────────────────────────

const csvText = await readFile(inputCsv, 'utf8');
const tenders = parseCsv(csvText);
const targets = ONLY
  ? tenders.filter(t => t.tender_num === ONLY || t.tender_link.includes(ONLY))
  : tenders;

console.log(`Tenders to process: ${targets.length}`);

// ── proxy ──────────────────────────────────────────────────────────────────────

const pm = (process.env.ALL_PROXY || '').match(/socks5h?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)/);
let relay = null, launchProxy;
if (pm) {
  relay = await startRelay(pm[1], pm[2], pm[3], Number(pm[4]));
  launchProxy = { server: `socks5://localhost:${relay.port}` };
  console.log(`Proxy relay: localhost:${relay.port} → ${pm[3]}:${pm[4]}\n`);
}

// ── browser ────────────────────────────────────────────────────────────────────

const browser = await firefox.launch({ headless: HEADLESS, proxy: launchProxy });
const page    = await browser.newPage();
page.setDefaultTimeout(30_000);

const results = [];

for (let i = 0; i < targets.length; i++) {
  const tender = targets[i];
  process.stdout.write(`[${i + 1}/${targets.length}] ${tender.tender_num} ... `);

  try {
    // Step 1: load common-info and find the "Документы" tab link
    await page.goto(tender.tender_link, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1200);

    const docsUrl = await page.evaluate(() => {
      const anchors = [...document.querySelectorAll('a')];
      const docsAnchor = anchors.find(a =>
        (a.textContent || '').trim() === 'Документы' &&
        (a.getAttribute('href') || '').includes('documents')
      );
      if (!docsAnchor) return null;
      const href = docsAnchor.getAttribute('href');
      return href.startsWith('http') ? href : 'https://zakupki.gov.ru' + href;
    });

    if (!docsUrl) {
      console.log('no docs tab found');
      results.push({ tender_num: tender.tender_num, name: tender.name, customer: tender.customer,
        price_rub: tender.price_rub, fz: tender.fz, docs_url: '', docs_count: 0, tz_count: 0,
        docs: [], error: 'no docs tab link found' });
      continue;
    }

    // Step 2: navigate to documents page
    await page.goto(docsUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1500);

    const docs = await extractDocs(page, tender.tender_num);

    results.push({
      tender_num:   tender.tender_num,
      name:         tender.name,
      customer:     tender.customer,
      price_rub:    tender.price_rub,
      fz:           tender.fz,
      docs_url:     docsUrl || '',
      docs_count:   docs.length,
      tz_count:     docs.filter(d => d.is_tz).length,
      docs,
    });

    console.log(`${docs.length} docs, ${docs.filter(d => d.is_tz).length} ТЗ`);

    // Save per-tender JSON
    await writeFile(
      `${outDir}/${tender.tender_num}.json`,
      JSON.stringify({ tender_num: tender.tender_num, docs_url: docsUrl, docs }, null, 2),
      'utf8',
    );
  } catch (err) {
    console.log(`ERROR: ${err.message.split('\n')[0]}`);
    results.push({
      tender_num: tender.tender_num, name: tender.name, customer: tender.customer,
      price_rub: tender.price_rub, fz: tender.fz, docs_url: tender.tender_link,
      docs_count: 0, tz_count: 0, docs: [], error: err.message.split('\n')[0],
    });
  }
}

await browser.close();
if (relay) relay.stop();

// ── write output ──────────────────────────────────────────────────────────────

writeJsonl(outJsonl, results);

// Flat CSV: one row per document
const flatRows = results.flatMap(r =>
  r.docs.length > 0
    ? r.docs.map(d => ({
        tender_num:  r.tender_num,
        tender_name: r.name,
        customer:    r.customer,
        price_rub:   r.price_rub,
        fz:          r.fz,
        is_tz:       d.is_tz ? 'yes' : 'no',
        doc_name:    d.name,
        doc_url:     d.url,
        doc_size:    d.size || '',
        docs_url:    r.docs_url,
      }))
    : [{
        tender_num:  r.tender_num,
        tender_name: r.name,
        customer:    r.customer,
        price_rub:   r.price_rub,
        fz:          r.fz,
        is_tz:       '',
        doc_name:    r.error ? `ERROR: ${r.error}` : 'no docs found',
        doc_url:     '',
        doc_size:    '',
        docs_url:    r.docs_url,
      }]
);

writeCsv(outCsv, flatRows);

const totalDocs = results.reduce((s, r) => s + r.docs_count, 0);
const totalTz   = results.reduce((s, r) => s + r.tz_count,   0);
console.log(`\nDone. Total docs: ${totalDocs}, ТЗ: ${totalTz}`);
console.log(`Wrote ${outJsonl}`);
console.log(`Wrote ${outCsv}`);
process.exit(0);

// ── DOM extractor ─────────────────────────────────────────────────────────────

async function extractDocs(page, tenderNum) {
  return page.evaluate(() => {
    const docs = [];

    const TZ_RE = /техническое\s*задани|тех\.?\s*задани|\bтз\b|\btz\b|specification|terms.of.reference|\btor\b|техзадание|техническое_задание|описание\s+объекта|описание_объекта|приложение\s*[№#]?\s*1[^0-9].*описание|требования.*объект|техтребовани/i;

    // DOCUMENT_URL_RE: matches zakupki file download patterns
    const DOC_RE = /filestore|download\/priz|\/file\.html\?uid=|attachments\/download|download\/file|\/docs?\//i;

    const seen = new Set();

    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      const text = (a.textContent || '').trim().replace(/\s+/g, ' ');

      // Skip empty-text links (those are modal/signature links)
      if (!text) continue;

      // Skip nav/external/footer links
      if (/roseltorg|tektorg|etpgpb|fabrikant|astgoz|sberbank-ast|rts-tender|lot-online|kremlin|government|economy|minfin|fas\.gov|roskazna|zakupki-traffic|chooseAuth|siteMap|userFeed|quiz|news-search|qa\/view|pricereq|normalization|orderclause|btk\.|dizk\.|oboz\.|ktru\/start|orderplan|contract\/search|contractfz223|capitalrepairs|legalacts|epz\/main\/public\/document|chooseRegion|user-feedback/i.test(href)) continue;
      if (/^mailto:|^#$/.test(href)) continue;

      const url = href.startsWith('http') ? href : 'https://zakupki.gov.ru' + href;

      // Must look like a document URL OR have a document-like name
      const looksLikeDoc = DOC_RE.test(url) || /\.(pdf|docx?|xlsx?|zip|rar|7z|rtf)(\?|#|$)/i.test(url);

      if (!looksLikeDoc) continue;
      if (seen.has(url)) continue;
      seen.add(url);

      const is_tz = TZ_RE.test(text + ' ' + url);
      docs.push({ name: text.slice(0, 300), url, is_tz });
    }

    return docs;
  });
}

// ── CSV parser ────────────────────────────────────────────────────────────────

function parseCsv(text) {
  const rows = [];
  let field = '', record = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inQ && c === '"' && n === '"') { field += '"'; i++; continue; }
    if (c === '"')    { inQ = !inQ; continue; }
    if (!inQ && c === ',') { record.push(field); field = ''; continue; }
    if (!inQ && (c === '\n' || c === '\r')) {
      if (c === '\r' && n === '\n') i++;
      record.push(field); rows.push(record); field = ''; record = [];
      continue;
    }
    field += c;
  }
  if (field || record.length) { record.push(field); rows.push(record); }
  const [headers, ...data] = rows.filter(r => r.some(v => v !== ''));
  return data.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] || ''])));
}

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find(a => a.startsWith(prefix))?.slice(prefix.length) || fallback;
}
