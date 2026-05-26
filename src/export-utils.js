import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function writeJsonl(path, items) {
  ensureDir(dirname(path));
  writeFileSync(path, '', 'utf8');

  for (const item of items) {
    appendJsonl(path, item);
  }
}

export function appendJsonl(path, item) {
  ensureDir(dirname(path));
  appendFileSync(path, `${JSON.stringify(redactSecretsDeep(item))}\n`, 'utf8');
}

export function writeCsv(path, rows) {
  ensureDir(dirname(path));

  if (rows.length === 0) {
    writeFileSync(path, '', 'utf8');
    return;
  }

  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(',')),
  ];

  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

export function writeText(path, content) {
  ensureDir(dirname(path));
  writeFileSync(path, content, 'utf8');
}

export function cleanText(value) {
  return String(value ?? '')
    .replace(/!\[CDATA\[/g, '')
    .replace(/\]\]/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#034;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\[B\]|\[\/B\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function redactSecrets(value) {
  return String(value ?? '').replace(/(api_code=)[^&"'\s]+/gi, '$1<redacted>');
}

export function redactSecretsDeep(value) {
  if (Array.isArray(value)) return value.map(redactSecretsDeep);

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactSecretsDeep(item)]),
    );
  }

  if (typeof value === 'string') return redactSecrets(value);
  return value;
}

export function parseApiTenderInfo(value) {
  if (!value) return {};

  try {
    const url = new URL(redactSecrets(value));
    return {
      id: url.searchParams.get('id') || '',
      tend_num: url.searchParams.get('tend_num') || '',
    };
  } catch {
    return {};
  }
}

export function normalizeDocs(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(normalizeDocs);
  if (typeof value !== 'object') return [{ raw: value }];
  if (Array.isArray(value.Doc)) return value.Doc;
  if (Array.isArray(value.Item)) return value.Item;
  if (Array.isArray(value.Document)) return value.Document;
  if (Array.isArray(value.file)) return value.file;
  return Object.keys(value).length === 0 ? [] : [value];
}

export function dateValue(value) {
  const [day, month, year] = String(value || '').split('-').map(Number);
  return year && month && day ? Date.UTC(year, month - 1, day) : 0;
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}
