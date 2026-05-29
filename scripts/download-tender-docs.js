#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { tmpdir } from 'node:os';
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

if (typeof http.setGlobalProxyFromEnv === 'function') {
  http.setGlobalProxyFromEnv();
}

const execFileAsync = promisify(execFile);
const runDate = getArg('date', '2026-05-25');
const inputPath = getArg('input', `data/processed/${runDate}/classified-tenders.csv`);
const outputDir = getArg('output', `data/raw/tenderguru/${runDate}/docs`);
const manifestCsvPath = getArg('manifest-csv', `data/raw/tenderguru/${runDate}/docs-manifest.csv`);
const manifestJsonlPath = getArg('manifest-jsonl', `data/raw/tenderguru/${runDate}/docs-manifest.jsonl`);
const maxPerTender = Number(getArg('max-per-tender', '20'));
const maxDepth = Number(getArg('max-depth', '3'));
const onlyTender = getArg('only', '');
const keepAllDocs = getBoolArg('keep-all-docs', false);
const cookieJar = new Map();
const proxyUrl = getProxyUrl();
const useCurlProxy = isSocksProxy(proxyUrl);
const curlTempDirPromise = useCurlProxy
  ? mkdtemp(join(tmpdir(), 'tenderguru-curl-'))
  : Promise.resolve('');
const discardedPaths = new Set();
const technicalAssignmentNamePatterns = [
  /(?:^|[^a-z0-9])tz(?:[^a-z0-9]|$)/i,
  /(?:^|[^a-z0-9])chtz(?:[^a-z0-9]|$)/i,
  /tehnicheskoe[-_\s]+zadanie/i,
  /tekhnicheskoe[-_\s]+zadanie/i,
  /technical[-_\s]+assignment/i,
  /opisanie[-_\s]+obekta[-_\s]+zakupki/i,
  /prilozhenie[-_\s]+.*(?:tehnicheskoe[-_\s]+zadanie|opisanie[-_\s]+obekta[-_\s]+zakupki)/i,
];
const nonTechnicalAssignmentNamePatterns = [
  /proekt\s+dogovora/i,
  /dogovor/i,
  /contract/i,
  /proekt\s+kontrakta/i,
  /kontrakt/i,
  /protokol/i,
  /soglashen/i,
];
const nonTechnicalAssignmentTextPatterns = [
  /^лицензионный\s+договор\b/i,
  /^проект\s+договора\b/i,
  /^проект\s+контракта\b/i,
  /^договор\b/i,
  /^контракт\b/i,
];

ensureDir(outputDir);

const onlyTenderIds = parseOnlyIds(onlyTender);
const rows = parseCsv(await readFile(inputPath, 'utf8'))
  .filter((row) => onlyTenderIds.length === 0 || [row.tender_id, row.tenderguru_card_id].some((id) => onlyTenderIds.includes(id)));
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
  const seenPaths = new Set();

  for (let index = 0; index < links.length; index += 1) {
    const url = links[index];
    const targetPath = join(tenderDir, buildFileName(index + 1, url));

    if (existsSync(targetPath)) {
      manifest.push(manifestRow(row, url, 'exists', '', targetPath));
      await expandDownloadedFile(row, url, targetPath, tenderDir, manifest, 0, seenPaths);
      continue;
    }

    try {
      const result = await download(url, targetPath, { referer: url });
      manifest.push(manifestRow(row, url, 'downloaded', result.contentType, targetPath, result.bytes));
      await expandDownloadedFile(row, url, targetPath, tenderDir, manifest, 0, seenPaths);
    } catch (error) {
      manifest.push(manifestRow(row, url, 'error', cleanText(error.message), targetPath));
    }
  }

  if (!keepAllDocs) {
    await cleanupTenderDir(tenderDir);
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
    .filter((value) => !/api_code=/i.test(value));
}

async function download(url, targetPath, { referer = '' } = {}) {
  if (useCurlProxy) {
    return downloadWithCurl(url, targetPath, { referer });
  }

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

async function downloadWithCurl(url, targetPath, { referer = '' } = {}) {
  const host = new URL(url).host;
  const tempDir = await curlTempDirPromise;
  const headerPath = join(tempDir, `${safeName(host)}-${Date.now()}-${Math.random().toString(16).slice(2)}.headers`);
  const curlProxy = normalizeSocksProxyUrl(proxyUrl);
  const cookie = cookieJar.get(host) || '';

  const args = [
    '-sS',
    '-L',
    '--connect-timeout',
    '30',
    '--max-time',
    '30',
    '--user-agent',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '--header',
    'Accept: */*',
    '--dump-header',
    headerPath,
    '--output',
    targetPath,
    '--write-out',
    '__CURL_META__%{content_type}\t%{url_effective}\n',
    '--proxy',
    curlProxy,
  ];

  if (cookie) {
    args.push('--cookie', cookie);
  }

  if (referer) {
    args.push('--referer', referer);
  }

  args.push(url);

  try {
    const { stdout } = await execFileAsync('curl', args, { maxBuffer: 2 * 1024 * 1024 });
    const metaLine = String(stdout || '')
      .split(/\r?\n/)
      .find((line) => line.startsWith('__CURL_META__')) || '';
    const [, contentType = '', finalUrl = ''] = metaLine.replace('__CURL_META__', '').split('\t');
    const headerText = await readFile(headerPath, 'utf8');
    storeCookiesFromHeaderLines(new URL(finalUrl || url).host, headerText);
    const bytes = String((await stat(targetPath)).size);

    await writeFile(`${targetPath}.meta.json`, JSON.stringify({
      source_url: redactSecrets(url),
      final_url: redactSecrets(finalUrl || url),
      content_type: contentType,
      content_length: bytes,
    }, null, 2), 'utf8');

    await rm(headerPath, { force: true });
    return { contentType, bytes };
  } catch (error) {
    await rm(headerPath, { force: true });
    throw new Error(cleanText(error.stderr || error.message || 'curl failed'));
  }
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

function storeCookiesFromHeaderLines(host, headerText) {
  const current = new Map(
    String(cookieJar.get(host) || '')
      .split(/;\s*/)
      .filter(Boolean)
      .map((pair) => pair.split('=', 2)),
  );

  for (const line of String(headerText || '').split(/\r?\n/)) {
    const match = line.match(/^set-cookie:\s*([^=;\s]+)=([^;]*)/i);
    if (!match) continue;
    const [, name, value] = match;
    current.set(name.trim(), value.trim());
  }

  if (!current.size) return;

  cookieJar.set(host, [...current.entries()].map(([name, value]) => `${name}=${value}`).join('; '));
}

async function expandDownloadedFile(row, sourceUrl, filePath, tenderDir, manifest, depth, seen = new Set()) {
  if (depth >= maxDepth) return;

  if (seen.has(filePath)) {
    if (discardedPaths.has(filePath)) {
      await removeArtifact(filePath);
      await removeArtifact(`${filePath}.meta.json`);
      await removeArtifact(`${filePath}.txt`);
    }
    return;
  }

  seen.add(filePath);

  const kind = await detectFileKind(filePath);
  const baseName = basename(filePath);

  if (kind === 'docx') {
    const textPath = `${filePath}.txt`;
    const text = await extractDocxText(row, sourceUrl, filePath, manifest);
    const keep = keepAllDocs || isTechnicalAssignmentFile(sourceUrl, baseName, text);

    if (!keep) {
      await removeArtifact(filePath);
      await removeArtifact(`${filePath}.meta.json`);
      await removeArtifact(textPath);
      discardedPaths.add(filePath);
      manifest.push(manifestRow(row, sourceUrl, 'skipped', 'Not a technical assignment document', filePath, '', sourceUrl));
    }

    return;
  }

  if (kind !== 'html') {
    if (!keepAllDocs && !isTechnicalAssignmentFile(sourceUrl, baseName, '')) {
      await removeArtifact(filePath);
      await removeArtifact(`${filePath}.meta.json`);
      discardedPaths.add(filePath);
      manifest.push(manifestRow(row, sourceUrl, 'skipped', 'Not a technical assignment document', filePath, '', sourceUrl));
    }
    return;
  }

  const html = await readHtml(filePath);
  const childLinks = extractViewerLinks(html, sourceUrl)
    .filter((url, index, array) => array.indexOf(url) === index);

  const keep = isTechnicalAssignmentFile(sourceUrl, baseName, html);

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

  if (!keep) {
    await removeArtifact(filePath);
    await removeArtifact(`${filePath}.meta.json`);
    discardedPaths.add(filePath);
    manifest.push(manifestRow(row, sourceUrl, 'skipped', 'Not a technical assignment document', filePath, '', sourceUrl));
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
    return text;
  } catch (error) {
    manifest.push(manifestRow(row, sourceUrl, 'text_error', cleanText(error.message), textPath, '', docxPath));
    return '';
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

async function removeArtifact(path) {
  await rm(path, { force: true });
}

async function cleanupTenderDir(rootDir) {
  const entries = await readDirRecursive(rootDir);
  const baseEntries = entries.filter((entryPath) => !entryPath.endsWith('.meta.json') && !entryPath.endsWith('.txt'));

  for (const entryPath of baseEntries) {
    if (await shouldKeepArtifact(entryPath)) {
      continue;
    }

    await removeArtifact(entryPath);
    await removeArtifact(`${entryPath}.meta.json`);
    await removeArtifact(`${entryPath}.txt`);
  }
}

async function shouldKeepArtifact(filePath) {
  const fileName = basename(filePath);
  const normalizedName = normalizeForMatch(fileName);
  if (nonTechnicalAssignmentNamePatterns.some((pattern) => pattern.test(normalizedName))) {
    return false;
  }

  if (technicalAssignmentNamePatterns.some((pattern) => pattern.test(normalizedName))) {
    return true;
  }

  const textPath = `${filePath}.txt`;
  if (!existsSync(textPath)) return false;

  try {
    const text = await readFile(textPath, 'utf8');
    return isTechnicalAssignmentFile('', fileName, text);
  } catch {
    return false;
  }
}

async function readDirRecursive(rootDir) {
  const { readdir, stat } = await import('node:fs/promises');
  const result = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (entry.isFile()) {
        result.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  return result;
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

function getBoolArg(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function parseOnlyIds(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function isTechnicalAssignmentFile(sourceUrl, fileName, text) {
  const normalizedName = normalizeForMatch(`${sourceUrl} ${fileName}`);
  if (nonTechnicalAssignmentNamePatterns.some((pattern) => pattern.test(normalizedName))) {
    return false;
  }

  const normalizedText = normalizeForMatch(String(text || ''));
  const head = normalizedText.slice(0, 5000);
  if (nonTechnicalAssignmentTextPatterns.some((pattern) => pattern.test(head))) {
    return false;
  }

  if (technicalAssignmentNamePatterns.some((pattern) => pattern.test(normalizedName))) {
    return true;
  }

  if (!normalizedText) return false;
  return (
    /^техническое\s+задание\b/i.test(head)
    || /^частное\s+техническое\s+задание\b/i.test(head)
    || /^описание\s+объекта\s+закупки\b/i.test(head)
    || /\bтехническое\s+задание\b/i.test(head)
    || /\bчастное\s+техническое\s+задание\b/i.test(head)
    || /\bописание\s+объекта\s+закупки\b/i.test(head)
    || /\bчтз\b/i.test(head.slice(0, 1500))
  );
}

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[`'’"«»]/g, ' ')
    .replace(/[_./\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


function getProxyUrl() {
  return process.env.ALL_PROXY
    || process.env.all_proxy
    || process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || '';
}

function isSocksProxy(value) {
  return /^socks(?:4a?|5h?)?:\/\//i.test(String(value || ''));
}

function normalizeSocksProxyUrl(value) {
  return String(value || '').replace(/^socks5:\/\//i, 'socks5h://');
}
