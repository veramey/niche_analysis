#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadDotEnv } from '../src/env.js';
import { TenderGuruClient } from '../src/tenderguru-client.js';

loadDotEnv();

const tenderIds = [
  '94522987',
  '94523005',
  '94523042',
  '94523403',
  '94523514',
  '94523516',
  '94523615',
  '94523617',
  '94523744',
  '94523889',
];

const client = new TenderGuruClient();
const rows = [];

for (const id of tenderIds) {
  const [tender] = await client.getTenderById(id);
  const docs = normalizeDocs(tender.docsXML);
  const aiDocs = await getAiDocsStatus(id);

  if (docs.length === 0) {
    rows.push(toRow(tender, null, aiDocs));
    continue;
  }

  for (const doc of docs) {
    rows.push(toRow(tender, doc, aiDocs));
  }
}

mkdirSync('exports', { recursive: true });

const outputPath = 'exports/software-tenders-docs-2026-05-25.csv';
writeFileSync(outputPath, toCsv(rows), 'utf8');
console.log(`Exported ${rows.length} rows to ${outputPath}`);

function normalizeDocs(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(normalizeDocs);
  if (typeof value !== 'object') return [{ raw: value }];

  if (Array.isArray(value.Doc)) return value.Doc;
  if (Array.isArray(value.Item)) return value.Item;
  if (Array.isArray(value.Document)) return value.Document;
  if (Array.isArray(value.file)) return value.file;

  if (Object.keys(value).length === 0) return [];
  return [value];
}

async function getAiDocsStatus(id) {
  try {
    const response = await client.request('', {
      mode: 'ai',
      act: 'webhook',
      t: id,
      ff: 'a',
      drl: '1',
    });
    const first = Array.isArray(response) ? response[0] : response;

    if (first?.access === 'denied') {
      return {
        status: 'denied',
        info: clean(first.info),
      };
    }

    return {
      status: 'available',
      info: clean(JSON.stringify(response).slice(0, 500)),
    };
  } catch (error) {
    return {
      status: 'error',
      info: clean(error.message),
    };
  }
}

function toRow(tender, doc, aiDocs) {
  const docsCount = normalizeDocs(tender.docsXML).length;

  return {
    tender_id: tender.ID || '',
    date: tender.Date || '',
    tender_name: clean(tender.TenderName),
    customer: clean(tender.Customer),
    customer_inn: tender.CustomerINN || '',
    region: clean(tender.Region),
    price: tender.Price || '',
    end_time: tender.EndTime || '',
    fz: tender.Fz || '',
    etp: clean(tender.Etp),
    tender_link: tender.TenderLink || '',
    tenderguru_link: tender.TenderLinkInner || '',
    tender_num_outer: tender.TenderNumOuter || '',
    doc_name: clean(firstValue(doc, ['Name', 'DocName', 'FileName', 'Filename', 'title', 'name', 'View'])),
    doc_url: redact(firstValue(doc, ['URL', 'Url', 'Link', 'DocPath', 'FilePath', 'Path', 'href', 'View'])),
    doc_type: clean(firstValue(doc, ['Type', 'DocType', 'type'])),
    docs_count_in_card: docsCount,
    docs_status: docsCount > 0 ? 'docsXML available' : 'docsXML empty in tender card',
    docs_ai_status: aiDocs.status,
    docs_ai_info: aiDocs.info,
    docs_ai_api_url: `https://www.tenderguru.ru/api2.3/export?dtype=json&mode=ai&act=webhook&t=${encodeURIComponent(tender.ID)}&ff=a&drl=1`,
  };
}

function firstValue(source, keys) {
  if (!source || typeof source !== 'object') return source || '';

  for (const key of keys) {
    if (source[key]) return source[key];
  }

  return '';
}

function toCsv(data) {
  const headers = Object.keys(data[0] || {});
  const lines = [headers.join(',')];

  for (const row of data) {
    lines.push(headers.map((header) => csvCell(row[header])).join(','));
  }

  return `${lines.join('\n')}\n`;
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function clean(value) {
  return String(value ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function redact(value) {
  return String(value ?? '').replace(/(api_code=)[^&"'\s]+/gi, '$1<redacted>');
}
