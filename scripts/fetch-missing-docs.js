#!/usr/bin/env node
/**
 * Fetch documents for tenders that have no doc_links.
 *
 * Strategy:
 *   1. Query TG API (tend_num) → linksTenderXML with linkURL + download fields
 *   2. Try to download directly from zakupki.gov.ru / zakaz.gov.ru via SOCKS5 proxy
 *   3. Fall back to TG download webhook (caches async — retries after delay)
 *
 * Usage:
 *   node scripts/fetch-missing-docs.js --date=2026-05-25 --limit=20
 *   node scripts/fetch-missing-docs.js --only=0372100047626000120,0373200082126000210
 *   node scripts/fetch-missing-docs.js --keep-all-docs=true --no-proxy
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, extname, basename } from 'node:path';
import { loadDotEnv } from '../src/env.js';
import { cleanText, ensureDir, writeJsonl, writeCsv } from '../src/export-utils.js';

loadDotEnv();

const execFileAsync = promisify(execFile);

const runDate = getArg('date', '2026-05-25');
const outputDir = getArg('output', `data/raw/tenderguru/${runDate}/docs`);
const manifestBase = getArg('manifest', `data/raw/tenderguru/${runDate}/missing-docs-manifest`);
const limitArg = Number(getArg('limit', '0'));
const onlyArg = getArg('only', '');
const keepAllDocs = getBoolArg('keep-all-docs', false);
const delayMs = Number(getArg('delay', '800'));
const useProxy = !getBoolArg('no-proxy', false);

const apiCode = process.env.TENDERGURU_API_CODE || '';
const proxyUrl = getProxyUrl();
const canUseProxy = useProxy && isSocksProxy(proxyUrl);
const TG_BASE = 'https://www.tenderguru.ru/api2.3/export';

if (!apiCode) {
  console.error('TENDERGURU_API_CODE not set in .env');
  process.exit(1);
}

if (canUseProxy) {
  console.log(`Proxy: ${proxyUrl.replace(/:[^:@]+@/, ':***@')} (direct zakupki.gov.ru downloads enabled)`);
} else {
  console.log('No proxy — using TG webhook fallback only');
}

ensureDir(outputDir);

// Load tenders without doc_links
const tendersJson = JSON.parse(await readFile('public/data/tenders.json', 'utf8'));
const onlyIds = parseOnlyIds(onlyArg);

let candidates = tendersJson.filter((t) => {
  const hasDocLinks = t.doc_links && t.doc_links.split('|').some((u) => u.trim().startsWith('http'));
  return !hasDocLinks && t.tender_num?.trim() && t.tenderguru_card_id;
});

if (onlyIds.length > 0) {
  candidates = candidates.filter((t) =>
    onlyIds.includes(t.tender_id) || onlyIds.includes(String(t.tenderguru_card_id)),
  );
} else if (limitArg > 0) {
  candidates = candidates.slice(0, limitArg);
}

console.log(`Processing ${candidates.length} tenders without docs…\n`);

const manifest = [];

for (const t of candidates) {
  const tgId = String(t.tenderguru_card_id);
  const tenderId = t.tender_id || tgId;
  console.log(`[${tenderId}] ${(t.tender_name || '').slice(0, 70)}`);

  // Step 1: get linksTenderXML from TG API
  let docItems = [];
  try {
    docItems = await getTenderDocLinks(t.tender_num);
  } catch (err) {
    console.log(`  ✗ API error: ${err.message}`);
    manifest.push(makeRow(t, '', 'api_error', cleanText(err.message)));
    await sleep(delayMs);
    continue;
  }

  if (docItems.length === 0) {
    console.log('  — No document links in API response');
    manifest.push(makeRow(t, '', 'no_links', 'linksTenderXML empty'));
    await sleep(delayMs);
    continue;
  }

  console.log(`  ${docItems.length} doc(s) found`);

  const tenderDir = join(outputDir, safeName(tenderId));
  await mkdir(tenderDir, { recursive: true });

  for (let i = 0; i < docItems.length; i++) {
    const item = docItems[i];
    const docName = cleanDocName(item.linkName || '');
    const idx = String(i + 1).padStart(2, '0');
    const nameNoExt = safeName(docName).replace(/\.(docx|doc|pdf|xlsx|xls|zip|rar)$/i, '');
    console.log(`  [${i + 1}/${docItems.length}] ${docName.slice(0, 65)}`);

    // Determine target path (ext resolved after download)
    const targetBase = join(tenderDir, `${idx}_${nameNoExt.slice(0, 60)}`);

    // Check if already downloaded (any extension)
    const existing = findExisting(targetBase);
    if (existing) {
      console.log(`    ↩ exists`);
      manifest.push(makeRow(t, item.linkURL, 'exists', '', existing, '', docName));
      await maybeExtractText(t, item.linkURL, existing, manifest, docName, keepAllDocs);
      continue;
    }

    let downloaded = false;

    // Strategy 1: download directly via proxy from zakupki.gov.ru / zakaz.gov.ru
    if (canUseProxy && item.linkURL && isGovUrl(item.linkURL)) {
      const ext = guessExt(item.linkURL, docName);
      const targetPath = `${targetBase}${ext}`;
      try {
        await downloadWithCurl(item.linkURL, targetPath, proxyUrl);
        const bytes = (await stat(targetPath)).size;
        console.log(`    ✓ proxy ${bytes} bytes → ${basename(targetPath)}`);
        manifest.push(makeRow(t, item.linkURL, 'downloaded_proxy', '', targetPath, String(bytes), docName));
        await maybeExtractText(t, item.linkURL, targetPath, manifest, docName, keepAllDocs);
        downloaded = true;
      } catch (err) {
        console.log(`    · proxy failed (${err.message.slice(0, 60)}), trying TG webhook…`);
      }
    }

    // Strategy 2: TG download webhook (may need two passes — first triggers caching)
    if (!downloaded && item.download) {
      const result = await downloadViaTgWebhook(t, item, targetBase, docName, manifest);
      downloaded = result;
    }

    if (!downloaded) {
      console.log(`    ✗ all strategies failed`);
      manifest.push(makeRow(t, item.linkURL, 'failed', 'all strategies failed', '', '', docName));
    }

    await sleep(200);
  }

  await sleep(delayMs);
}

writeJsonl(`${manifestBase}.jsonl`, manifest);
writeCsv(`${manifestBase}.csv`, manifest);

const downloaded = manifest.filter((r) => r.status.startsWith('downloaded')).length;
const extracted = manifest.filter((r) => r.status === 'text_extracted').length;
console.log(`\nDone. Tenders: ${candidates.length} | Downloaded: ${downloaded} | Text extracted: ${extracted}`);
console.log(`Manifest: ${manifestBase}.jsonl`);

// --- Download strategies ---

async function downloadViaTgWebhook(t, item, targetBase, docName, manifest) {
  // First pass — triggers TG to cache the file
  let fileUrl = await resolveDownloadUrl(item.download);
  if (!fileUrl) {
    // TG caches asynchronously — wait and retry once
    await sleep(2500);
    fileUrl = await resolveDownloadUrl(item.download);
  }

  if (!fileUrl) {
    manifest.push(makeRow(t, item.linkURL, 'no_file_url', 'TG webhook returned no URL', '', '', docName));
    return false;
  }

  const ext = guessExt(fileUrl, docName);
  const targetPath = `${targetBase}${ext}`;

  try {
    const buf = await downloadFetch(fileUrl);
    await writeFile(targetPath, buf);
    const bytes = buf.length;
    console.log(`    ✓ tg ${bytes} bytes → ${basename(targetPath)}`);
    manifest.push(makeRow(t, fileUrl, 'downloaded_tg', '', targetPath, String(bytes), docName, item.linkURL));
    await maybeExtractText(t, fileUrl, targetPath, manifest, docName, keepAllDocs);
    return true;
  } catch (err) {
    console.log(`    ✗ TG download error: ${err.message.slice(0, 80)}`);
    manifest.push(makeRow(t, fileUrl, 'download_error', cleanText(err.message), targetPath, '', docName));
    return false;
  }
}

async function downloadWithCurl(url, targetPath, proxy) {
  const curlProxy = proxy.replace(/^socks5:\/\//i, 'socks5h://');
  const args = [
    '-sS', '-L',
    '--connect-timeout', '20',
    '--max-time', '30',
    '--user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '--proxy', curlProxy,
    '--output', targetPath,
    '--write-out', '%{http_code}',
  ];
  args.push(url);

  const { stdout } = await execFileAsync('curl', args, { maxBuffer: 50 * 1024 * 1024 });
  const httpCode = parseInt(stdout.trim(), 10);
  if (httpCode >= 400) throw new Error(`HTTP ${httpCode}`);
}

async function downloadFetch(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'tenderguru-integration/0.1' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function resolveDownloadUrl(webhookUrl) {
  if (!webhookUrl) return '';
  const url = `${webhookUrl}&api_code=${encodeURIComponent(apiCode)}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'tenderguru-integration/0.1' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return '';
    const data = await res.json();
    const entry = Array.isArray(data) ? data[0] : data;
    const fileUrl = entry?.status || '';
    return /^https?:\/\//i.test(fileUrl) ? fileUrl : '';
  } catch {
    return '';
  }
}

// --- Text extraction ---

async function maybeExtractText(t, sourceUrl, filePath, manifest, docName, keepAll) {
  const buf = await readFile(filePath).catch(() => null);
  if (!buf || !buf.slice(0, 4).toString('latin1').startsWith('PK\x03\x04')) return;

  const textPath = `${filePath}.txt`;
  if (existsSync(textPath)) {
    manifest.push(makeRow(t, sourceUrl, 'text_exists', '', textPath, '', docName));
    return;
  }

  try {
    const { stdout } = await execFileAsync('unzip', ['-p', filePath, 'word/document.xml'], {
      maxBuffer: 50 * 1024 * 1024,
    });
    const text = cleanDocxXml(stdout);
    if (!text) {
      manifest.push(makeRow(t, sourceUrl, 'text_empty', 'empty', textPath, '', docName));
      return;
    }
    await writeFile(textPath, `${text}\n`, 'utf8');
    console.log(`    ✓ text extracted (${text.length} chars)`);
    manifest.push(makeRow(t, sourceUrl, 'text_extracted', '', textPath, String(Buffer.byteLength(text)), docName));
  } catch (err) {
    manifest.push(makeRow(t, sourceUrl, 'text_error', cleanText(err.message), textPath, '', docName));
  }
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
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- TG API ---

async function getTenderDocLinks(tenderNum) {
  const url = new URL(TG_BASE);
  url.searchParams.set('dtype', 'json');
  url.searchParams.set('api_code', apiCode);
  url.searchParams.set('tend_num', tenderNum);

  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': 'tenderguru-integration/0.1' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  const entry = Array.isArray(data) ? data[0] : data;
  const raw = entry?.linksTenderXML;
  if (!raw) return [];

  const items = Array.isArray(raw.item) ? raw.item : (raw.item ? [raw.item] : []);
  return items.filter((it) => it?.linkURL);
}

// --- Helpers ---

function findExisting(base) {
  for (const ext of ['.docx', '.doc', '.pdf', '.xlsx', '.xls', '.zip', '.rar', '']) {
    const p = `${base}${ext}`;
    if (existsSync(p)) return p;
  }
  return null;
}

function isGovUrl(url) {
  return /zakupki\.gov\.ru|zakaz\.gov\.ru/i.test(url);
}

function guessExt(url, name) {
  for (const src of [url, name]) {
    const m = String(src || '').match(/\.(docx|doc|pdf|xlsx|xls|zip|rar)(?:[?#]|$)/i);
    if (m) return `.${m[1].toLowerCase()}`;
  }
  return '';
}

function cleanDocName(name) {
  return name.replace(/\s+/g, ' ').replace(/[()]/g, '').trim();
}

function safeName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9А-Яа-яёЁ._-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

function makeRow(t, url, status, note = '', filePath = '', bytes = '', docName = '', origUrl = '') {
  return {
    tender_id: t.tender_id || '',
    tenderguru_card_id: t.tenderguru_card_id || '',
    tender_name: (t.tender_name || '').slice(0, 120),
    doc_name: docName,
    url: url || '',
    orig_zakupki_url: origUrl || '',
    status,
    note,
    file_path: filePath || '',
    bytes: bytes || '',
  };
}

function getProxyUrl() {
  return process.env.ALL_PROXY || process.env.all_proxy || process.env.HTTPS_PROXY
    || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
}

function isSocksProxy(value) {
  return /^socks(?:4a?|5h?)?:\/\//i.test(String(value || ''));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

function parseOnlyIds(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}
