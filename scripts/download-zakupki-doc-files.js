#!/usr/bin/env node
/**
 * Downloads actual zakupki.gov.ru document files from a docs JSONL produced by
 * scripts/download-zakupki-docs.js. EIS file URLs may return 404 to curl while
 * working as browser downloads, so this uses Playwright's download API.
 *
 * Usage:
 *   node scripts/download-zakupki-doc-files.js --date=2026-05-30 --input=data/processed/2026-05-30/zakupki-edo-docs.jsonl --prefix=zakupki-edo-doc-files
 *   node scripts/download-zakupki-doc-files.js --only-tz=true
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { firefox } from 'playwright';
import { loadDotEnv } from '../src/env.js';
import { cleanText, ensureDir, writeCsv, writeJsonl } from '../src/export-utils.js';
import { startRelay } from '../src/socks5-relay.js';

loadDotEnv();

const DATE = getArg('date', '2026-05-30');
const PREFIX = getArg('prefix', 'zakupki-doc-files');
const INPUT = getArg('input', `data/processed/${DATE}/zakupki-docs.jsonl`);
const OUTPUT = getArg('output', `data/raw/${PREFIX}/${DATE}`);
const MANIFEST_CSV = getArg('manifest-csv', `data/processed/${DATE}/${PREFIX}-manifest.csv`);
const MANIFEST_JSONL = getArg('manifest-jsonl', `data/processed/${DATE}/${PREFIX}-manifest.jsonl`);
const ONLY_TZ = getBoolArg('only-tz', false);
const HEADLESS = getArg('headless', 'true') !== 'false';
const TIMEOUT = Number(getArg('timeout', '60000'));

ensureDir(OUTPUT);

const tenders = readJsonl(INPUT);
const tasks = [];

for (const tender of tenders) {
  for (const [index, doc] of (tender.docs || []).entries()) {
    if (!doc.url) continue;
    if (ONLY_TZ && !doc.is_tz) continue;
    if (!isDownloadUrl(doc.url)) continue;
    tasks.push({ tender, doc, index });
  }
}

const pm = (process.env.ALL_PROXY || '').match(/socks5h?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)/);
let relay = null;
let launchProxy;
if (pm) {
  relay = await startRelay(pm[1], pm[2], pm[3], Number(pm[4]));
  launchProxy = { server: `socks5://localhost:${relay.port}` };
  console.log(`Proxy relay: localhost:${relay.port} -> ${pm[3]}:${pm[4]}`);
}

const browser = await firefox.launch({ headless: HEADLESS, proxy: launchProxy });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(TIMEOUT);

console.log(`Files to download: ${tasks.length}${ONLY_TZ ? ' (ТЗ only)' : ''}`);

const manifest = [];

try {
  for (let i = 0; i < tasks.length; i += 1) {
    const { tender, doc, index } = tasks[i];
    const tenderDir = join(OUTPUT, tender.tender_num);
    ensureDir(tenderDir);

    process.stdout.write(`[${i + 1}/${tasks.length}] ${tender.tender_num} ${doc.is_tz ? 'ТЗ' : 'doc'} ... `);

    try {
      const result = await downloadWithBrowser(page, doc.url, tenderDir, index, doc.name);
      manifest.push({
        tender_num: tender.tender_num,
        is_tz: doc.is_tz ? 'yes' : 'no',
        doc_name: doc.name || '',
        source_url: doc.url,
        status: 'downloaded',
        file_path: result.filePath,
        bytes: String(result.bytes),
        suggested_filename: result.suggestedFilename,
      });
      console.log(`${result.bytes} bytes`);
    } catch (error) {
      manifest.push({
        tender_num: tender.tender_num,
        is_tz: doc.is_tz ? 'yes' : 'no',
        doc_name: doc.name || '',
        source_url: doc.url,
        status: 'error',
        file_path: '',
        bytes: '',
        suggested_filename: '',
        error: cleanText(error.message).slice(0, 300),
      });
      console.log(`ERROR: ${cleanText(error.message).slice(0, 160)}`);
    }
  }
} finally {
  await browser.close();
  if (relay) relay.stop();
}

writeCsv(MANIFEST_CSV, manifest);
writeJsonl(MANIFEST_JSONL, manifest);

const ok = manifest.filter((row) => row.status === 'downloaded').length;
console.log(`\nDone. Downloaded ${ok}/${manifest.length}`);
console.log(`Wrote ${MANIFEST_CSV}`);
console.log(`Wrote ${MANIFEST_JSONL}`);
process.exit(0);

async function downloadWithBrowser(page, url, dir, index, name) {
  const downloadPromise = page.waitForEvent('download');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT }).catch((error) => {
    if (!/Download is starting/i.test(error.message)) throw error;
  });
  const download = await downloadPromise;
  const suggestedFilename = sanitizeFileName(download.suggestedFilename() || '');
  const fallback = `${String(index + 1).padStart(2, '0')}-${sanitizeFileName(name || 'document')}`;
  const filePath = join(dir, uniqueFileName(dir, suggestedFilename || fallback));
  await download.saveAs(filePath);
  return {
    filePath,
    bytes: statSync(filePath).size,
    suggestedFilename,
  };
}

function uniqueFileName(dir, name) {
  const safe = sanitizeFileName(name || 'document');
  if (!existsSync(join(dir, safe))) return safe;
  const dot = safe.lastIndexOf('.');
  const base = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : '';
  for (let i = 2; i < 1000; i += 1) {
    const next = `${base}-${i}${ext}`;
    if (!existsSync(join(dir, next))) return next;
  }
  return `${base}-${Date.now()}${ext}`;
}

function sanitizeFileName(value) {
  return cleanText(value)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 160)
    || 'document';
}

function isDownloadUrl(url) {
  return /filestore|download\/priz|\/file\.html\?uid=|attachments\/download|download\/file/i.test(url);
}

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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
