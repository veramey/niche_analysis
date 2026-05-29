/**
 * Ретест релевантности ДОКУМЕНТОВ тендерам в карточках дашборда.
 *
 * Документы лежат в data/raw/.../docs/{tender_id}/ и просто ПРЕДПОЛАГАЮТСЯ
 * принадлежащими этому тендеру — это нигде не проверяется (исторический баг «wrong-doc»).
 * Здесь для каждого тендера, у которого реально есть извлечённые .txt, сверяем текст
 * документов с эталонным описанием тендера из API (имя + Info), используя уже собранный
 * кэш api-retest (новых запросов к API нет). Результат — только отчёт.
 *
 * Сигнал: containment — доля отличительных слов названия тендера, встречающихся в тексте
 * документов. У корректных тендеров ≈1.0; набор документов от чужого тендера её обрушит.
 *
 * Использование:
 *   node scripts/retest-doc-relevance.js
 *   node scripts/retest-doc-relevance.js --only=<tender_id>
 *   node scripts/retest-doc-relevance.js --date=2026-05-25
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanText,
  writeJsonl,
  writeCsv,
  writeText,
  ensureDir,
} from '../src/export-utils.js';

const argv = process.argv.slice(2);
function getArg(name, def) {
  const prefix = `--${name}`;
  for (const a of argv) {
    if (a === prefix) return true;
    if (a.startsWith(`${prefix}=`)) return a.slice(prefix.length + 1);
  }
  return def;
}

const DATE = String(getArg('date', '2026-05-25'));
const ONLY = String(getArg('only', '') || '');
const MAX_FILE_BYTES = 1_500_000; // защита от гигантских txt

// Пороги (containment названия → документы; корректные ≈1.0).
const OK = 0.6;
const WEAK = 0.34;

const ROOT = process.cwd();
const TENDERS_PATH = join(ROOT, 'public/data/tenders.json');
const CACHE_DIR = join(ROOT, 'data/raw/tenderguru', DATE, 'api-retest');
const OUT_DIR = join(ROOT, 'data/analysis', DATE);

// Общие закупочные слова — выкидываем из «отличительных» токенов названия.
const STOP = new Set([
  'поставка', 'поставку', 'поставки', 'оказание', 'услуг', 'услуги', 'услугам',
  'выполнение', 'работ', 'работы', 'работам', 'нужд', 'для', 'право', 'заключения',
  'договор', 'договора', 'контракт', 'контракта', 'закупка', 'закупки', 'приобретение',
  'оборудование', 'оборудования', 'обеспечение', 'обеспечения', 'предоставлению',
  'предоставление', 'использование', 'использования', 'виде', 'простой',
  'неисключительной', 'лицензии', 'учреждения', 'учреждение', 'государственной',
  'государственного', 'муниципального', 'федерального', 'российской', 'федерации',
  'электронной', 'форме', 'конкурс', 'аукцион', 'возможностью',
]);

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#\d+;/g, ' ');
}

function tokenize(value, minLen = 4) {
  return new Set(
    cleanText(decodeEntities(value)).toLowerCase()
      .replace(/[^a-zа-яё0-9 ]+/gi, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= minLen),
  );
}

function distinctiveNameTokens(name) {
  const all = tokenize(name, 4);
  const out = new Set();
  for (const t of all) if (!STOP.has(t)) out.add(t);
  return out;
}

function containment(small, big) {
  if (!small.size) return null;
  let inter = 0;
  for (const t of small) if (big.has(t)) inter += 1;
  return inter / small.size;
}

function evidencePaths(t) {
  const raw = Array.isArray(t.evidence_files)
    ? t.evidence_files
    : String(t.evidence_files || '').split('|');
  return raw.map((s) => String(s).trim()).filter(Boolean).filter((p) => existsSync(p));
}

function readDoc(path) {
  try {
    const size = statSync(path).size;
    const buf = readFileSync(path, 'utf8');
    return size > MAX_FILE_BYTES ? buf.slice(0, MAX_FILE_BYTES) : buf;
  } catch {
    return '';
  }
}

function isBoilerplate(filename) {
  return /обоснован|нмцк|nmc|реквизит|платеж|форма|заявк|декларац|соглас|инструкц/i.test(filename);
}

function loadApi(t) {
  const key = String(t.tenderguru_card_id || t.tender_id).replace(/[^\w.-]/g, '_');
  try {
    const rec = JSON.parse(readFileSync(join(CACHE_DIR, `${key}.json`), 'utf8'));
    return rec && !rec.__notfound ? rec : null;
  } catch {
    return null;
  }
}

function main() {
  let tenders = JSON.parse(readFileSync(TENDERS_PATH, 'utf8'));
  if (ONLY) tenders = tenders.filter((t) => String(t.tender_id) === ONLY);

  const inScope = tenders
    .map((t) => ({ t, files: evidencePaths(t) }))
    .filter((x) => x.files.length > 0);

  console.log(`Ретест релевантности документов: ${inScope.length} тендеров с извлечёнными .txt.`);

  const results = [];
  for (const { t, files } of inScope) {
    const api = loadApi(t);
    const nameTokens = distinctiveNameTokens(t.tender_name);
    const refTokens = api ? tokenize(`${api.TenderName || ''} ${cleanText(decodeEntities(api.Info))}`, 4) : new Set();
    const custTokens = distinctiveNameTokens(t.customer);

    const perFile = [];
    const allDocTokens = new Set();
    for (const p of files) {
      const text = readDoc(p);
      const dtok = tokenize(text, 4);
      for (const tk of dtok) allDocTokens.add(tk);
      const fileName = p.split('/').pop();
      perFile.push({
        file: fileName,
        chars: text.length,
        name_cont: round(containment(nameTokens, dtok)),
        boilerplate: isBoilerplate(fileName),
      });
    }

    const nameCont = containment(nameTokens, allDocTokens);
    const refCont = refTokens.size ? containment(refTokens, allDocTokens) : null;
    const custCont = containment(custTokens, allDocTokens);

    // Если у названия почти нет отличительных слов — опираемся на эталон (name+Info).
    const primary = nameTokens.size >= 3 || refCont === null ? nameCont : Math.max(nameCont ?? 0, refCont);

    let status = 'ok';
    if (primary === null) status = 'no_signal';
    else if (primary < WEAK) status = 'wrong_doc';
    else if (primary < OK) status = 'weak';

    // Файлы, не относящиеся к тендеру и при этом не шаблонные — основные подозреваемые.
    const suspectFiles = perFile
      .filter((f) => (f.name_cont ?? 0) < 0.2 && !f.boilerplate && f.chars > 400)
      .map((f) => f.file);

    results.push({
      tender_id: t.tender_id,
      card_id: t.tenderguru_card_id || '',
      status,
      files_count: files.length,
      scores: {
        name_cont: round(nameCont),
        ref_cont: round(refCont),
        customer_cont: round(custCont),
        distinctive_name_tokens: nameTokens.size,
        api_cached: !!api,
      },
      suspect_files: suspectFiles,
      name: cleanText(decodeEntities(t.tender_name)).slice(0, 140),
      api_name: api ? cleanText(decodeEntities(api.TenderName)).slice(0, 140) : '',
      per_file: perFile,
    });
  }

  writeReports(results);
}

function round(v) {
  return v === null || v === undefined ? '' : Number(v.toFixed(3));
}

function writeReports(results) {
  const jsonlPath = join(OUT_DIR, 'doc-tender-relevance.jsonl');
  const csvPath = join(OUT_DIR, 'doc-tender-relevance.csv');
  const mdPath = join(OUT_DIR, 'doc-tender-relevance.md');
  ensureDir(OUT_DIR);

  writeJsonl(jsonlPath, results);

  writeCsv(csvPath, results.map((r) => ({
    tender_id: r.tender_id,
    card_id: r.card_id,
    status: r.status,
    files_count: r.files_count,
    name_cont: r.scores.name_cont,
    ref_cont: r.scores.ref_cont,
    customer_cont: r.scores.customer_cont,
    distinctive_tokens: r.scores.distinctive_name_tokens,
    suspect_files: r.suspect_files.join(' ; '),
    name: r.name,
  })));

  const order = ['ok', 'weak', 'wrong_doc', 'no_signal'];
  const meaning = {
    ok: 'документы относятся к тендеру (containment ≥ 0.6)',
    weak: 'частичное совпадение (0.34–0.6) — возможно, только шаблоны',
    wrong_doc: 'документы НЕ про этот тендер (< 0.34) — проверить',
    no_signal: 'нет отличительных слов/эталона для оценки',
  };
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  const total = results.length;

  const lines = [];
  lines.push('# Релевантность документов тендерам (doc-fidelity)');
  lines.push('');
  lines.push(`Дата: ${DATE}. Тендеров с извлечёнными .txt: **${total}**. Эталон: API (имя + Info).`);
  lines.push('');
  lines.push('Сигнал — **containment**: доля отличительных слов названия тендера, встречающихся');
  lines.push('в тексте его документов. У корректных тендеров ≈1.0; набор от чужого тендера её обрушит.');
  lines.push('');
  lines.push('| Статус | Кол-во | Доля | Значение |');
  lines.push('|--------|-------:|-----:|----------|');
  for (const s of order) {
    if (!counts[s]) continue;
    lines.push(`| \`${s}\` | ${counts[s]} | ${((counts[s] / total) * 100).toFixed(1)}% | ${meaning[s]} |`);
  }
  lines.push('');
  const problems = results.filter((r) => r.status !== 'ok');
  lines.push(`**Требуют проверки: ${problems.length} из ${total}.**`);
  lines.push('');

  for (const s of order.filter((x) => x !== 'ok')) {
    const rows = results.filter((r) => r.status === s).sort((a, b) => (a.scores.name_cont || 0) - (b.scores.name_cont || 0));
    if (!rows.length) continue;
    lines.push(`## ${s} (${rows.length})`);
    lines.push('');
    lines.push('| tender_id | name_cont | ref_cont | files | название | подозрительные файлы |');
    lines.push('|-----------|----------:|---------:|------:|----------|----------------------|');
    for (const r of rows) {
      lines.push(`| \`${r.tender_id}\` | ${r.scores.name_cont} | ${r.scores.ref_cont} | ${r.files_count} | ${mdCell(r.name)} | ${mdCell(r.suspect_files.join(' ; '), 50)} |`);
    }
    lines.push('');
  }

  lines.push('## tender_id для проверки');
  lines.push('');
  lines.push('```');
  for (const r of problems) lines.push(`${r.tender_id}\t${r.status}\tname_cont=${r.scores.name_cont}`);
  lines.push('```');
  lines.push('');

  writeText(mdPath, `${lines.join('\n')}\n`);

  console.log('');
  console.log('Готово. Отчёты:');
  console.log(`  ${jsonlPath}`);
  console.log(`  ${csvPath}`);
  console.log(`  ${mdPath}`);
  console.log('');
  console.log('Статусы:', order.filter((s) => counts[s]).map((s) => `${s}=${counts[s]}`).join('  '));
}

function mdCell(value, n = 70) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, n);
}

main();
