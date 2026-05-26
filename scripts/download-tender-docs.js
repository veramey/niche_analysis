#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, extname, join } from 'node:path';
import { loadDotEnv } from '../src/env.js';
import {
  cleanText,
  ensureDir,
  redactSecrets,
  writeCsv,
  writeJsonl,
} from '../src/export-utils.js';

loadDotEnv();

const execFileAsync = promisify(execFile);
const runDate = getArg('date', '2026-05-25');
const inputPath = getArg('input', `data/processed/${runDate}/classified-tenders.csv`);
const outputDir = getArg('output', `data/raw/tenderguru/${runDate}/docs`);
const manifestCsvPath = getArg('manifest-csv', `data/raw/tenderguru/${runDate}/docs-manifest.csv`);
const manifestJsonlPath = getArg('manifest-jsonl', `data/raw/tenderguru/${runDate}/docs-manifest.jsonl`);
const maxPerTender = Number(getArg('max-per-tender', '20'));
const maxDepth = Number(getArg('max-depth', '3'));
const onlyTender = getArg('only', '');
const includeSourceLinks = getArg('include-source-links', '0') === '1';
const cookieJar = new Map();

ensureDir(outputDir);

const rows = parseCsv(await readFile(inputPath, 'utf8'))
  .filter((row) => !onlyTender || [row.tender_id, row.tenderguru_card_id].includes(onlyTender));
const manifest = [];

for (const row of rows) {
  const links = extractLinks(row)
    .filter(Boolean)
    .filter((url, index, array) => array.indexOf(url) === index)
    .slice(0, maxPerTender);

  if (links.length === 0) {
    manifest.push(manifestRow(row, null, 'no_links', 'No document links found'));
    continue;
  }

  const tenderDir = join(outputDir, safeName(row.tender_id || row.tenderguru_card_id || 'unknown'));
  await mkdir(tenderDir, { recursive: true });

  for (let index = 0; index < links.length; index += 1) {
    const url = links[index];
    const targetPath = join(tenderDir, buildFileName(index + 1, url));

    if (existsSync(targetPath)) {
      manifest.push(manifestRow(row, url, 'exists', '', targetPath));
      await expandDownloadedFile(row, url, targetPath, tenderDir, manifest, 0);
      continue;
    }

    try {
      const result = await download(url, targetPath, { referer: url });
      manifest.push(manifestRow(row, url, 'downloaded', result.contentType, targetPath, result.bytes));
      await expandDownloadedFile(row, url, targetPath, tenderDir, manifest, 0);
    } catch (error) {
      manifest.push(manifestRow(row, url, 'error', cleanText(error.message), targetPath));
    }
  }
}

writeCsv(manifestCsvPath, manifest);
writeJsonl(manifestJsonlPath, manifest);

console.log(`Processed ${rows.length} tenders`);
console.log(`Document records: ${manifest.length}`);
console.log(`Downloaded: ${manifest.filter((row) => row.status === 'downloaded').length}`);
console.log(`Extracted text files: ${manifest.filter((row) => row.status === 'text_extracted').length}`);
console.log(`Manifest: ${manifestCsvPath}`);

function extractLinks(row) {
  const values = [
    row.doc_links_from_documentation_search,
  ];

  return values
    .flatMap((value) => String(value || '').split(/\s+\|\s+/))
    .map((value) => value.trim())
    .filter((value) => /^https?:\/\//i.test(value))
    .filter((value) => !/api_code=/i.test(value))
    .filter((value) => includeSourceLinks || !/zakupki\.gov\.ru/i.test(value));
}

async function download(url, targetPath, { referer = '' } = {}) {
  const response = await fetchWithCookies(url, { referer });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('Empty response body');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(targetPath, buffer);

  const contentType = response.headers.get('content-type') || '';
  const bytes = String(buffer.length);

  await writeFile(`${targetPath}.meta.json`, JSON.stringify({
    source_url: redactSecrets(url),
    final_url: redactSecrets(response.url),
    content_type: contentType,
    content_length: bytes,
  }, null, 2), 'utf8');

  return { contentType, bytes };
}

async function fetchWithCookies(url, { referer = '' } = {}) {
  const host = new URL(url).host;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: '*/*',
  };

  const cookie = cookieJar.get(host);
  if (cookie) headers.Cookie = cookie;
  if (referer) headers.Referer = referer;

  const response = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });

  storeCookies(host, response.headers);
  return response;
}

function storeCookies(host, headers) {
  const cookies = headers.getSetCookie ? headers.getSetCookie() : [];
  if (!cookies.length) return;

  const current = new Map(
    String(cookieJar.get(host) || '')
      .split(/;\s*/)
      .filter(Boolean)
      .map((pair) => pair.split('=', 2)),
  );

  for (const cookie of cookies) {
    const [pair] = String(cookie).split(';', 1);
    const [name, ...rest] = pair.split('=');
    if (!name) continue;
    current.set(name.trim(), rest.join('=').trim());
  }

  cookieJar.set(host, [...current.entries()].map(([name, value]) => `${name}=${value}`).join('; '));
}

async function expandDownloadedFile(row, sourceUrl, filePath, tenderDir, manifest, depth, seen = new Set()) {
  if (depth >= maxDepth || seen.has(filePath)) return;
  seen.add(filePath);

  const kind = await detectFileKind(filePath);

  if (kind === 'docx') {
    await extractDocxText(row, sourceUrl, filePath, manifest);
    return;
  }

  if (kind !== 'html') return;

  const html = await readHtml(filePath);
  const childLinks = extractViewerLinks(html, sourceUrl)
    .filter((url, index, array) => array.indexOf(url) === index)
    .filter((url) => !/zakupki\.gov\.ru/i.test(url));

  for (let index = 0; index < childLinks.length; index += 1) {
    const childUrl = childLinks[index];
    const targetPath = join(tenderDir, buildDerivedFileName(depth + 1, index + 1, childUrl));

    if (existsSync(targetPath)) {
      manifest.push(manifestRow(row, childUrl, 'exists', '', targetPath, '', sourceUrl));
      await expandDownloadedFile(row, childUrl, targetPath, tenderDir, manifest, depth + 1, seen);
      continue;
    }

    try {
      const result = await download(childUrl, targetPath, { referer: sourceUrl });
      const finalPath = await renameByDetectedKind(targetPath, result.contentType, childUrl);
      manifest.push(manifestRow(row, childUrl, 'downloaded', result.contentType, finalPath, result.bytes, sourceUrl));
      await expandDownloadedFile(row, childUrl, finalPath, tenderDir, manifest, depth + 1, seen);
    } catch (error) {
      manifest.push(manifestRow(row, childUrl, 'error', cleanText(error.message), targetPath, '', sourceUrl));
    }
  }
}

async function extractDocxText(row, sourceUrl, docxPath, manifest) {
  const textPath = `${docxPath}.txt`;

  if (existsSync(textPath)) {
    manifest.push(manifestRow(row, sourceUrl, 'text_exists', '', textPath, '', docxPath));
    return;
  }

  try {
    const { stdout } = await execFileAsync('unzip', ['-p', docxPath, 'word/document.xml'], {
      maxBuffer: 50 * 1024 * 1024,
    });
    const text = cleanDocxXml(stdout);

    if (!text) {
      manifest.push(manifestRow(row, sourceUrl, 'text_empty', 'DOCX text was empty', textPath, '', docxPath));
      return;
    }

    await writeFile(textPath, `${text}\n`, 'utf8');
    manifest.push(manifestRow(row, sourceUrl, 'text_extracted', '', textPath, Buffer.byteLength(text), docxPath));
  } catch (error) {
    manifest.push(manifestRow(row, sourceUrl, 'text_error', cleanText(error.message), textPath, '', docxPath));
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
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractViewerLinks(html, sourceUrl) {
  const links = [];

  for (const pattern of [
    /\s(?:src|href|data-src)=["']([^"']+)["']/gi,
    /view\.officeapps\.live\.com\/op\/view\.aspx\?src=([^"']+)/gi,
  ]) {
    for (const match of html.matchAll(pattern)) {
      const raw = match[1] || match[2] || '';
      const value = decodeHtml(raw).trim();
      if (!value) continue;

      const normalized = normalizeChildUrl(value, sourceUrl);
      const decodedDownloadUrl = decodeTenderGuruDownloadUrl(normalized);
      if (decodedDownloadUrl) links.push(decodedDownloadUrl);

      if (
        /tenderguru\.ru\/download_files\.php/i.test(normalized)
        || /tenderguru\.ru\/docfiles\//i.test(normalized)
      ) {
        links.push(normalizeOfficeViewerUrl(normalized));
      }
    }
  }

  return links;
}

function normalizeChildUrl(value, sourceUrl) {
  const decoded = decodeURIComponent(value);

  try {
    return new URL(decoded, sourceUrl).toString();
  } catch {
    return decoded;
  }
}

function normalizeOfficeViewerUrl(value) {
  try {
    const parsed = new URL(value);
    const src = parsed.hostname === 'view.officeapps.live.com' ? parsed.searchParams.get('src') : '';
    return src || value;
  } catch {
    return value;
  }
}

function decodeTenderGuruDownloadUrl(value) {
  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    return '';
  }

  if (!/tenderguru\.ru$/i.test(parsed.hostname) || parsed.pathname !== '/download_files.php') {
    return '';
  }

  const drl = parsed.searchParams.get('drl');
  if (!drl) return '';

  try {
    const decoded = Buffer.from(drl, 'base64').toString('utf8');
    return /^https?:\/\//i.test(decoded) ? decoded : '';
  } catch {
    return '';
  }
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#034;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function detectFileKind(filePath) {
  const buffer = await readFile(filePath);
  const head = buffer.subarray(0, 512).toString('latin1');

  if (head.startsWith('PK\u0003\u0004')) return 'docx';
  if (/^\s*<!doctype html/i.test(head) || /^\s*<html/i.test(head) || /<iframe|<div|<link/i.test(head)) return 'html';
  return 'binary';
}

async function readHtml(filePath) {
  const buffer = await readFile(filePath);
  const latin = buffer.toString('latin1');
  const encoding = /charset\s*=\s*windows-1251|charset\s*=\s*cp1251/i.test(latin)
    ? 'windows-1251'
    : 'utf-8';

  return new TextDecoder(encoding).decode(buffer);
}

async function renameByDetectedKind(targetPath, contentType, url) {
  const kind = await detectFileKind(targetPath);
  const currentExt = extname(targetPath);
  const desiredExt = extensionForKind(kind, contentType, url);

  if (!desiredExt || currentExt.toLowerCase() === desiredExt) return targetPath;

  const renamedPath = `${targetPath}${desiredExt}`;
  if (existsSync(renamedPath)) return renamedPath;
  await rename(targetPath, renamedPath);
  return renamedPath;
}

function extensionForKind(kind, contentType, url) {
  if (kind === 'docx') return '.docx';
  if (kind === 'html') return '.html';
  if (/pdf/i.test(contentType) || /\.pdf(?:[?#]|$)/i.test(url)) return '.pdf';
  if (/rar/i.test(contentType) || /\.rar(?:[?#]|$)/i.test(url)) return '.rar';
  if (/zip/i.test(contentType) || /\.zip(?:[?#]|$)/i.test(url)) return '.zip';
  return '';
}

function manifestRow(row, url, status, note = '', filePath = '', bytes = '', derivedFrom = '') {
  return {
    tender_id: row.tender_id || '',
    tenderguru_card_id: row.tenderguru_card_id || '',
    niche: row.niche || '',
    tender_name: row.tender_name || '',
    source_url: redactSecrets(url || ''),
    status,
    note,
    file_path: filePath,
    bytes,
    derived_from: redactSecrets(derivedFrom || ''),
  };
}

function buildFileName(index, url) {
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return `doc-${String(index).padStart(3, '0')}.bin`;
  }

  const rawBase = decodeURIComponent(basename(parsed.pathname) || '').replace(/[^\wа-яА-ЯёЁ.-]+/g, '_');
  const extension = extname(rawBase);
  const suffix = extension ? '' : guessExtension(parsed.pathname);

  return `doc-${String(index).padStart(3, '0')}-${rawBase || 'download'}${suffix}`;
}

function buildDerivedFileName(depth, index, url) {
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return `derived-${depth}-${String(index).padStart(3, '0')}.bin`;
  }

  const urlName = decodeURIComponent(basename(parsed.pathname) || '')
    .replace(/[^\wа-яА-ЯёЁ.-]+/g, '_');
  const queryName = parsed.searchParams.get('drl')
    ? `download_files-${safeName(parsed.searchParams.get('drl')).slice(-32)}`
    : '';
  const rawBase = urlName && urlName !== 'download_files.php' ? urlName : queryName;

  return `derived-${depth}-${String(index).padStart(3, '0')}-${rawBase || 'download'}`;
}

function guessExtension(pathname) {
  if (/download\.html$/i.test(pathname)) return '.bin';
  if (/docviewer/i.test(pathname)) return '.html';
  return '.bin';
}

function safeName(value) {
  return String(value || 'unknown').replace(/[^a-zA-Zа-яА-Я0-9_.-]+/g, '_');
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
