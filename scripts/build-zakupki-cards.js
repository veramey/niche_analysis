#!/usr/bin/env node
/**
 * Builds dashboard data from zakupki.gov.ru scraped tenders.
 * Reads:
 *   data/processed/2026-05-29/zakupki-ai-year-relevant.csv  — 64 relevant tenders
 *   data/processed/2026-05-29/zakupki-docs.jsonl            — documents per tender
 * Writes:
 *   public/data/tenders.json     — dashboard tender list
 *   public/data/meta.json        — metadata
 *   public/data/cards/*.md       — detail cards (one per tender)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const DATE      = '2026-05-29';
const INPUT_CSV = `data/processed/${DATE}/zakupki-ai-year-relevant.csv`;
const DOCS_JSONL= `data/processed/${DATE}/zakupki-docs.jsonl`;
const OUT_DIR   = 'public/data';
const CARDS_DIR = `${OUT_DIR}/cards`;

mkdirSync(CARDS_DIR, { recursive: true });

// ── parse inputs ──────────────────────────────────────────────────────────────

const tenders = parseCsv(readFileSync(INPUT_CSV, 'utf8'));
const docsMap  = new Map();
for (const line of readFileSync(DOCS_JSONL, 'utf8').trim().split('\n').filter(Boolean)) {
  const r = JSON.parse(line);
  docsMap.set(r.tender_num, r);
}

// ── build records ─────────────────────────────────────────────────────────────

const records = tenders.map(t => {
  const docs   = docsMap.get(t.tender_num) || {};
  const allDocs= docs.docs || [];
  const tzDocs = allDocs.filter(d => d.is_tz);
  const realDocs = allDocs.filter(d => d.url && (d.url.includes('filestore') || d.url.includes('download')) && !d.url.includes('etprf') && !d.url.includes('tektorg'));

  return {
    // IDs
    tender_id:          t.tender_num,
    tender_num:         t.tender_num,
    tender_name:        t.name,

    // Parties
    customer:           t.customer,

    // Money
    budget_rub:         t.price_rub ? String(parseFloat(t.price_rub)) : '',

    // Dates — dashboard expects DD-MM-YYYY; CSV has DD.MM.YYYY
    date:               t.publish_date?.replace(/\./g, '-') || '',
    end_time:           t.deadline?.replace(/\./g, '-') || '',

    // Classification
    fz:                 extractFz(t.fz),
    status:             t.status || '',

    // Links
    eis_link:           t.tender_link || '',
    tender_link:        t.tender_link || '',

    // Documents
    docs_count:         realDocs.length,
    tz_count:           tzDocs.length,
    evidence_files:     realDocs.length > 0 ? 'docs' : '',
    has_card:           true,   // we generate a card for every tender

    // Doc links (for export)
    doc_links:          tzDocs.map(d => d.url).join(' | '),

    // Source flag
    source:             'eis',
  };
});

// ── write tenders.json ────────────────────────────────────────────────────────

// Merge with existing tenders.json if present (keep old TenderGuru data too)
let existing = [];
const existingPath = `${OUT_DIR}/tenders.json`;
if (existsSync(existingPath)) {
  try {
    existing = JSON.parse(readFileSync(existingPath, 'utf8'));
  } catch { existing = []; }
}

// Deduplicate: zakupki records override existing by tender_num
const existingFiltered = existing.filter(e =>
  !records.some(r => r.tender_num && r.tender_num === (e.tender_num || e.tender_id))
);
const merged = [...existingFiltered, ...records];

writeFileSync(`${OUT_DIR}/tenders.json`, JSON.stringify(merged));
writeFileSync(`${OUT_DIR}/meta.json`, JSON.stringify({ date: DATE }));

console.log(`tenders.json: ${merged.length} total (${records.length} zakupki + ${existingFiltered.length} existing)`);

// ── generate markdown cards ───────────────────────────────────────────────────

let cardCount = 0;
for (const t of records) {
  const docs  = docsMap.get(t.tender_num) || {};
  const allDocs = (docs.docs || []).filter(d =>
    d.url && (d.url.includes('filestore') || d.url.includes('download')) &&
    !d.url.includes('etprf') && !d.url.includes('tektorg') && !d.url.includes('roseltorg')
  );
  const tzDocs  = allDocs.filter(d => d.is_tz);
  const otherDocs = allDocs.filter(d => !d.is_tz);

  const md = buildCard(t, tzDocs, otherDocs, docs.docs_url || '');
  writeFileSync(`${CARDS_DIR}/${t.tender_num}.md`, md, 'utf8');
  cardCount++;
}

console.log(`cards: ${cardCount} files written to ${CARDS_DIR}`);

// ── card template ─────────────────────────────────────────────────────────────

function buildCard(t, tzDocs, otherDocs, docsUrl) {
  const lines = [];

  lines.push(`# ${t.tender_name}`);
  lines.push('');

  lines.push('## Основные данные');
  lines.push('');
  row(lines, 'Номер тендера', t.tender_num);
  row(lines, 'Заказчик',      t.customer);
  row(lines, 'Бюджет',        t.budget_rub ? fmtBudget(Number(t.budget_rub)) : '—');
  row(lines, 'ФЗ',            t.fz);
  row(lines, 'Статус',        t.status);
  row(lines, 'Размещено',     formatDate(t.date));
  row(lines, 'Приём заявок до', formatDate(t.end_time));
  lines.push('');

  if (tzDocs.length > 0) {
    lines.push('## Техническое задание');
    lines.push('');
    for (const d of tzDocs) {
      lines.push(`- [${d.name}](${d.url})`);
    }
    lines.push('');
  }

  if (otherDocs.length > 0) {
    lines.push('## Документация');
    lines.push('');
    for (const d of otherDocs.slice(0, 20)) {
      lines.push(`- [${d.name}](${d.url})`);
    }
    if (otherDocs.length > 20) {
      lines.push(`- *(ещё ${otherDocs.length - 20} документов)*`);
    }
    lines.push('');
  }

  if (t.eis_link) {
    lines.push('## Ссылки');
    lines.push('');
    lines.push(`- [Карточка на ЕИС](${t.eis_link})`);
    if (docsUrl) lines.push(`- [Документы на ЕИС](${docsUrl})`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── helpers ───────────────────────────────────────────────────────────────────

function row(lines, label, value) {
  if (value) lines.push(`**${label}:** ${value}  `);
}

function extractFz(fzFull) {
  if (!fzFull) return '';
  const m = fzFull.match(/\d{2,3}-ФЗ/);
  return m ? m[0] : fzFull.split(' ')[0];
}

function fmtBudget(n) {
  if (!n) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' млрд ₽';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + ' млн ₽';
  if (n >= 1e3) return Math.round(n / 1e3) + ' тыс. ₽';
  return n + ' ₽';
}

function formatDate(d) {
  if (!d) return '';
  // DD-MM-YYYY → DD.MM.YYYY
  return d.replace(/-/g, '.');
}

function parseCsv(text) {
  const rows = [];
  let field = '', record = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inQ && c === '"' && n === '"') { field += '"'; i++; continue; }
    if (c === '"') { inQ = !inQ; continue; }
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
