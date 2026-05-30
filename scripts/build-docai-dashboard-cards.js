#!/usr/bin/env node
/**
 * Builds dashboard records and markdown cards for 6-month Document AI tenders.
 *
 * Usage:
 *   node scripts/build-docai-dashboard-cards.js --date=2026-05-30-docai-6m
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { promisify } from 'node:util';
import { cleanText, ensureDir } from '../src/export-utils.js';

const execFileAsync = promisify(execFile);

const DATE = getArg('date', '2026-05-30-docai-6m');
const INPUT_CSV = getArg('input', `data/processed/${DATE}/docai-6m-relevance.csv`);
const DOCS_JSONL = getArg('docs', `data/processed/${DATE}/zakupki-docai-6m-docs.jsonl`);
const FILES_MANIFEST = getArg('files', `data/processed/${DATE}/zakupki-docai-6m-doc-files-browser-manifest.jsonl`);
const OUT_DIR = 'public/data';
const CARDS_DIR = `${OUT_DIR}/cards`;

ensureDir(CARDS_DIR);

const rows = parseCsv(readFileSync(INPUT_CSV, 'utf8'))
  .filter((row) => !['low', ''].includes(row.docai_verdict));
const docsMap = new Map(readJsonl(DOCS_JSONL).map((row) => [row.tender_num, row]));
const filesByTender = groupBy(readJsonl(FILES_MANIFEST), (row) => row.tender_num);

const records = [];
let cardCount = 0;

for (const row of rows) {
  const docs = docsMap.get(row.tender_num) || {};
  const files = filesByTender.get(row.tender_num) || [];
  const analysis = await analyze(row, docs, files);
  records.push(toRecord(row, docs, files, analysis));
  writeFileSync(`${CARDS_DIR}/${row.tender_num}.md`, renderCard(row, docs, files, analysis), 'utf8');
  cardCount += 1;
}

const tendersPath = `${OUT_DIR}/tenders.json`;
const existing = existsSync(tendersPath)
  ? JSON.parse(readFileSync(tendersPath, 'utf8'))
  : [];
const ids = new Set(records.map((row) => row.tender_num));
const merged = [
  ...existing.filter((row) => !ids.has(row.tender_num || row.tender_id)),
  ...records,
];

writeFileSync(tendersPath, JSON.stringify(merged));
writeFileSync(`${OUT_DIR}/meta.json`, JSON.stringify({ date: DATE }));

console.log(`tenders.json: ${merged.length} total (${records.length} DocAI records added/updated)`);
console.log(`cards: ${cardCount} files written to ${CARDS_DIR}`);

async function analyze(row, docs, files) {
  const downloaded = files.filter((file) => file.status === 'downloaded');
  const tzFiles = downloaded.filter((file) => file.is_tz === 'yes');
  const selected = (tzFiles.length ? tzFiles : downloaded).slice(0, 5);
  let text = '';
  for (const file of selected) text += `\n${await extractText(file.file_path)}`;
  text = cleanText(text).slice(0, 350_000);

  const combined = `${row.name || ''}\n${text}`.toLowerCase();
  const productCategory = classifyProduct(row, combined);
  const modules = modulesFor(row, combined);
  const constraints = constraintsFor(combined);
  const snippets = evidenceSnippets(text, row.docai_hits);

  return {
    text,
    snippets,
    product_category: productCategory,
    niche: productCategory === 'speech_to_text' ? 'voice_assistant' : 'document_ai',
    sphere: classifySphere(row),
    sphere_label: sphereLabel(classifySphere(row)),
    opportunity_title: titleFor(productCategory),
    problem: summarizeProblem(row, snippets, productCategory),
    requested_solution: summarizeSolution(row, productCategory, modules),
    mvp_opportunity: suggestMvp(productCategory),
    target_buyers: suggestBuyers(row, productCategory),
    modules,
    constraints,
    integrations: integrationsFor(combined),
    ai_terms: aiTermsFor(row, combined),
    reuse_score: reuseScore(productCategory, row.docai_verdict),
    complexity: complexityFor(downloaded, constraints, productCategory),
  };
}

async function extractText(path) {
  if (!path || !existsSync(path)) return '';
  const ext = extname(path).toLowerCase();
  try {
    if (ext === '.docx') {
      const { stdout } = await execFileAsync('unzip', ['-p', path, 'word/document.xml'], { maxBuffer: 30 * 1024 * 1024 });
      return cleanDocxXml(stdout);
    }
    if (ext === '.doc' || ext === '.rtf') {
      const { stdout } = await execFileAsync('textutil', ['-convert', 'txt', '-stdout', path], { maxBuffer: 30 * 1024 * 1024 });
      return cleanText(stdout);
    }
    if (ext === '.pdf') {
      const { stdout } = await execFileAsync('pdftotext', [path, '-'], { maxBuffer: 30 * 1024 * 1024 });
      return cleanText(stdout);
    }
  } catch {
    return '';
  }
  return '';
}

function toRecord(row, docs, files, a) {
  const realDocs = (docs.docs || []).filter((doc) => isDownloadUrl(doc.url));
  const tzDocs = realDocs.filter((doc) => doc.is_tz);
  return {
    tender_id: row.tender_num,
    tender_num: row.tender_num,
    tender_name: row.name,
    customer: row.customer,
    budget_rub: row.price_rub ? String(parseFloat(row.price_rub)) : '',
    date: row.publish_date?.replace(/\./g, '-') || '',
    end_time: row.deadline?.replace(/\./g, '-') || '',
    fz: extractFz(row.fz),
    status: row.status || '',
    eis_link: row.tender_link || '',
    tender_link: row.tender_link || '',
    docs_count: realDocs.length,
    tz_count: tzDocs.length,
    evidence_files: files.some((file) => file.status === 'downloaded') ? 'docs' : '',
    has_card: true,
    doc_links: tzDocs.map((doc) => doc.url).join(' | '),
    source: 'eis',
    source_segment: 'docai_6m',
    classification: row.docai_verdict,
    matched_terms: row.docai_hits || row.ai_automation_terms || '',
    reason: `6m Document AI relevance: ${row.docai_verdict}; hits: ${row.docai_hits || 'нет'}`,
    relevance_score: relevanceScore(row.docai_verdict),
    sphere: a.sphere,
    sphere_label: a.sphere_label,
    niche: a.niche,
    product_category: a.product_category,
    reuse_score: a.reuse_score,
    opportunity_title: a.opportunity_title,
    problem: a.problem,
    requested_solution: a.requested_solution,
    mvp_opportunity: a.mvp_opportunity,
    modules: a.modules.join('; '),
    ai_terms: a.ai_terms.join('; '),
    constraints: a.constraints.join('; '),
    integrations: a.integrations.join('; '),
    complexity: a.complexity,
  };
}

function renderCard(row, docs, files, a) {
  const realDocs = (docs.docs || []).filter((doc) => isDownloadUrl(doc.url));
  const tzDocs = realDocs.filter((doc) => doc.is_tz);
  const otherDocs = realDocs.filter((doc) => !doc.is_tz);
  const downloaded = files.filter((file) => file.status === 'downloaded');
  const downloadedTz = downloaded.filter((file) => file.is_tz === 'yes');
  const downloadedOther = downloaded.filter((file) => file.is_tz !== 'yes');
  const lines = [];

  lines.push(`# ${a.opportunity_title}`);
  lines.push('');
  lines.push(`Тендер: \`${row.tender_num}\``);
  lines.push(`Заказчик: ${row.customer || '—'}`);
  lines.push(`Бюджет: ${row.price_rub ? fmtBudget(Number(row.price_rub)) : '—'}`);
  lines.push(`Релевантность DocAI: \`${row.docai_verdict}\``);
  lines.push(`Ниша: \`${a.niche}\``);
  lines.push(`Категория продукта: \`${a.product_category}\``);
  lines.push('');

  lines.push('## Предмет');
  lines.push('');
  lines.push(row.name || '—');
  lines.push('');

  lines.push('## Почему Релевантно');
  lines.push('');
  lines.push(a.problem);
  lines.push('');

  lines.push('## Что Хотят Купить');
  lines.push('');
  lines.push(a.requested_solution);
  lines.push('');

  lines.push('## Модули и Требования');
  lines.push('');
  for (const item of a.modules) lines.push(`- ${moduleLabel(item)}`);
  for (const item of a.integrations) lines.push(`- Интеграция/платформа: ${item}`);
  for (const item of a.constraints) lines.push(`- Ограничение: ${constraintLabel(item)}`);
  lines.push('');

  if (a.snippets.length) {
    lines.push('## Evidence Из Документов');
    lines.push('');
    for (const snippet of a.snippets.slice(0, 8)) lines.push(`- ${snippet}`);
    lines.push('');
  }

  lines.push('## MVP-Возможность');
  lines.push('');
  lines.push(a.mvp_opportunity);
  lines.push('');

  lines.push('## Кому Еще Продавать');
  lines.push('');
  for (const buyer of a.target_buyers) lines.push(`- ${buyer}`);
  lines.push('');

  lines.push('## Оценка');
  lines.push('');
  lines.push(`- Повторяемость: ${a.reuse_score}`);
  lines.push(`- Сложность: ${a.complexity}`);
  lines.push(`- DocAI hits: ${row.docai_hits || '—'}`);
  lines.push(`- Документов скачано: ${row.downloaded_docs || downloaded.length}`);
  lines.push('');

  if (downloadedTz.length) {
    lines.push('## Скачанные ТЗ');
    lines.push('');
    for (const file of downloadedTz) lines.push(`- ${basename(file.file_path)} (${formatBytes(Number(file.bytes))})`);
    lines.push('');
  }

  if (downloadedOther.length) {
    lines.push('## Скачанные Документы');
    lines.push('');
    for (const file of downloadedOther.slice(0, 20)) lines.push(`- ${basename(file.file_path)} (${formatBytes(Number(file.bytes))})`);
    if (downloadedOther.length > 20) lines.push(`- *(ещё ${downloadedOther.length - 20} документов)*`);
    lines.push('');
  }

  if (tzDocs.length) {
    lines.push('## Техническое Задание');
    lines.push('');
    for (const doc of tzDocs) lines.push(`- [${doc.name}](${doc.url})`);
    lines.push('');
  }

  if (otherDocs.length) {
    lines.push('## Документация');
    lines.push('');
    for (const doc of otherDocs.slice(0, 20)) lines.push(`- [${doc.name}](${doc.url})`);
    if (otherDocs.length > 20) lines.push(`- *(ещё ${otherDocs.length - 20} документов)*`);
    lines.push('');
  }

  lines.push('## Ссылки');
  lines.push('');
  if (row.tender_link) lines.push(`- [Карточка на ЕИС](${row.tender_link})`);
  if (docs.docs_url) lines.push(`- [Документы на ЕИС](${docs.docs_url})`);
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function classifyProduct(row, text) {
  const hits = row.docai_hits || '';
  if (/speech_to_text|распознаван.{0,30}реч|голосов.{0,30}ввод/i.test(`${hits} ${text}`)) return 'speech_to_text';
  if (/archive|pdf\/a|ретроконверс|электронн.{0,20}архив/i.test(`${hits} ${text}`)) return 'archive_digitization';
  if (/one_c|1с/i.test(`${hits} ${row.name}`)) return 'one_c_document_recognition';
  if (/field_extraction|classification/i.test(hits)) return 'intelligent_document_processing';
  if (/ocr|doc_recognition|распознаван/i.test(`${hits} ${row.name}`)) return 'ocr_document_recognition';
  return 'document_ai_solution';
}

function modulesFor(row, text) {
  const checks = [
    ['ocr', /ocr|распознаван.{0,40}(документ|текст)|pdf\/a/i],
    ['field_extraction', /извлечен.{0,30}(реквизит|данн|сведен)|распознаван.{0,30}реквизит/i],
    ['classification', /классификац.{0,40}документ|автоматическ.{0,30}классификац/i],
    ['speech_to_text', /распознаван.{0,30}реч|голосов.{0,30}ввод|преобразован.{0,30}реч.{0,30}текст/i],
    ['archive_digitization', /электронн.{0,20}архив|ретроконверс|сканирован/i],
    ['one_c_integration', /1с/i],
    ['cloud_platform', /облачн|вычислен|хранен|миграц/i],
    ['ai_ml', /искусственн.{0,20}интеллект|машинн.{0,20}обуч|нейросет|семантическ/i],
  ];
  const hay = `${row.docai_hits || ''}\n${row.name || ''}\n${text}`;
  return checks.filter(([, re]) => re.test(hay)).map(([name]) => name);
}

function constraintsFor(text) {
  const checks = [
    ['personal_data', /персональн/i],
    ['information_security', /защита информации|информационн.{0,20}безопас/i],
    ['healthcare_compliance', /медицинск|емиаc|емиаc|пациент/i],
    ['cloud_or_hosting', /облачн|центр обработки данных|цод/i],
  ];
  return checks.filter(([, re]) => re.test(text)).map(([name]) => name);
}

function integrationsFor(text) {
  const checks = [
    ['1С', /1с/i],
    ['ЕМИАС/медицинская ИС', /емиаc|емиаc|медицинск.{0,30}информац/i],
    ['электронный архив', /электронн.{0,20}архив/i],
    ['PDF/A', /pdf\/a/i],
    ['облачная платформа', /облачн/i],
    ['ГИС/АИС заказчика', /\bгис\b|\bаис\b|информационн.{0,20}систем/i],
  ];
  return checks.filter(([, re]) => re.test(text)).map(([name]) => name);
}

function aiTermsFor(row, text) {
  const checks = [
    ['OCR', /ocr|распознаван.{0,40}(документ|текст)/i],
    ['speech-to-text', /распознаван.{0,30}реч|голосов.{0,30}ввод/i],
    ['AI/ML', /искусственн.{0,20}интеллект|машинн.{0,20}обуч|нейросет/i],
    ['classification', /классификац/i],
    ['field extraction', /извлечен.{0,30}(реквизит|данн|сведен)/i],
  ];
  const hay = `${row.docai_hits || ''}\n${row.name || ''}\n${text}`;
  return checks.filter(([, re]) => re.test(hay)).map(([name]) => name);
}

function evidenceSnippets(text, hits) {
  const lines = cleanText(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map(cleanBullet)
    .filter((line) => line.length >= 45 && line.length <= 420);
  const keywords = ['распознаван', 'ocr', 'pdf/a', 'архив', 'документ', 'реквизит', 'классификац', 'искусственн', 'реч', 'голосов', '1с'];
  const result = lines.filter((line) => keywords.some((kw) => line.toLowerCase().includes(kw)));
  if (result.length) return [...new Set(result)].slice(0, 10);
  return hits ? [`Найдены признаки: ${hits}.`] : [];
}

function summarizeProblem(row, snippets, productCategory) {
  if (snippets.length) return snippets[0];
  if (productCategory === 'speech_to_text') return 'Нужно ускорить ввод или обработку текстовой информации за счет распознавания речи.';
  if (productCategory === 'archive_digitization') return 'Нужно перевести бумажные или сканированные документы в пригодный для поиска электронный архив.';
  return 'Нужно автоматизировать распознавание, обработку или извлечение данных из документов.';
}

function summarizeSolution(row, productCategory, modules) {
  const templates = {
    speech_to_text: 'Система распознавания речи и преобразования голосового ввода в текст, включая сопровождение и интеграцию с рабочими системами.',
    archive_digitization: 'Оцифровка, OCR/распознавание и размещение документов в электронном архиве с формированием пригодных для поиска копий.',
    one_c_document_recognition: 'Лицензии или внедрение 1С-модулей распознавания первичных документов с интеграцией в учетный контур.',
    intelligent_document_processing: 'Document AI/IDP: распознавание, извлечение данных, классификация документов и передача результатов в информационные системы.',
    ocr_document_recognition: 'OCR/распознавание документов и текста, включая ПО, аппаратный комплекс или облачный сервис.',
  };
  const base = templates[productCategory] || 'ПО или сервис для интеллектуальной обработки документов.';
  return modules.length ? `${base} Ключевые модули: ${modules.map(moduleLabel).join(', ')}.` : base;
}

function suggestMvp(productCategory) {
  const map = {
    speech_to_text: 'Speech-to-text pilot: подключение 1-2 сценариев ввода, оценка точности, словарь терминов, интеграция с формой документа.',
    archive_digitization: 'Archive OCR pilot: партия сканов, PDF/A, OCR-слой, индексация, контроль качества и выгрузка в архив.',
    one_c_document_recognition: '1С OCR pilot: загрузка первичных документов, распознавание реквизитов, сверка с учетными данными, кабинет проверки.',
    intelligent_document_processing: 'IDP pilot: классификация типов документов, извлечение полей, очередь ручной проверки, API интеграции.',
    ocr_document_recognition: 'OCR pilot: прием документов, распознавание текста, экспорт результатов и метрики точности.',
  };
  return map[productCategory] || 'Discovery pilot: выбрать один документный поток и измерить точность, скорость и экономию ручной обработки.';
}

function suggestBuyers(row, productCategory) {
  const buyers = ['госучреждения с бумажными архивами', 'МФЦ', 'региональные ведомства', 'компании с большим потоком первичных документов'];
  if (productCategory === 'speech_to_text') buyers.push('медицинские организации', 'контакт-центры');
  if (/медицин|здравоохран/i.test(`${row.customer} ${row.name}`)) buyers.push('медицинские ИТ-операторы');
  if (/1с/i.test(row.name)) buyers.push('бухгалтерии и финансовые службы');
  return [...new Set(buyers)];
}

function classifySphere(row) {
  const text = `${row.customer || ''} ${row.name || ''}`.toLowerCase();
  if (/медицин|здравоохран|пациент|емиаc|емиаc|стоматолог|реабилитац/i.test(text)) return 'healthcare';
  if (/культур|музей|библиотек|киностуд/i.test(text)) return 'culture_sport';
  if (/труд|социальн/i.test(text)) return 'social_services';
  if (/энергосбыт|энерго/i.test(text)) return 'industry_energy';
  if (/мфц|государственных и муниципальных услуг/i.test(text)) return 'public_admin';
  return 'it_internal';
}

function sphereLabel(sphere) {
  const map = {
    healthcare: 'Медицина',
    culture_sport: 'Культура / спорт / туризм',
    social_services: 'Социальная поддержка / занятость',
    industry_energy: 'Промышленность / энергетика',
    public_admin: 'Госуправление',
    it_internal: 'Внутренняя ИТ-автоматизация',
  };
  return map[sphere] || sphere;
}

function titleFor(productCategory) {
  const map = {
    speech_to_text: 'Распознавание речи и голосовой ввод документов',
    archive_digitization: 'OCR и ретроконверсия бумажного архива',
    one_c_document_recognition: '1С-распознавание первичных документов',
    intelligent_document_processing: 'Document AI для классификации и извлечения данных',
    ocr_document_recognition: 'OCR/распознавание документов',
  };
  return map[productCategory] || 'Document AI / OCR';
}

function reuseScore(productCategory, verdict) {
  if (verdict === 'high') return 'high';
  if (['ocr_document_recognition', 'archive_digitization', 'one_c_document_recognition'].includes(productCategory)) return 'high';
  return 'medium';
}

function complexityFor(files, constraints, productCategory) {
  let score = 0;
  if (files.length > 8) score += 1;
  if (constraints.length >= 2) score += 1;
  if (['intelligent_document_processing', 'speech_to_text'].includes(productCategory)) score += 1;
  if (productCategory === 'archive_digitization') score += 1;
  return score >= 3 ? 'high' : score >= 1 ? 'medium' : 'low';
}

function relevanceScore(verdict) {
  return { high: '90', medium: '70', 'medium-low': '55' }[verdict] || '30';
}

function moduleLabel(value) {
  const map = {
    ocr: 'OCR/распознавание текста',
    field_extraction: 'Извлечение полей и реквизитов',
    classification: 'Классификация документов',
    speech_to_text: 'Распознавание речи',
    archive_digitization: 'Оцифровка и электронный архив',
    one_c_integration: 'Интеграция с 1С',
    cloud_platform: 'Облачная платформа',
    ai_ml: 'AI/ML-компоненты',
  };
  return map[value] || value;
}

function constraintLabel(value) {
  const map = {
    personal_data: 'персональные данные',
    information_security: 'информационная безопасность',
    healthcare_compliance: 'медицинский контур',
    cloud_or_hosting: 'облако/хостинг',
  };
  return map[value] || value;
}

function cleanDocxXml(xml) {
  return cleanText(
    xml
      .replace(/<w:p[ >][^]*?<\/w:p>/g, (match) => `${match.replace(/<[^>]+>/g, '')}\n`)
      .replace(/<[^>]+>/g, ' '),
  );
}

function cleanBullet(value) {
  return cleanText(value).replace(/^[-•\d.\s]+/, '').replace(/\s+/g, ' ').trim();
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function fmtBudget(n) {
  if (!n) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} млрд ₽`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} млн ₽`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} тыс. ₽`;
  return `${n} ₽`;
}

function extractFz(fzFull) {
  if (!fzFull) return '';
  const match = fzFull.match(/\d{2,3}-ФЗ/);
  return match ? match[0] : fzFull.split(' ')[0];
}

function isDownloadUrl(url) {
  return /filestore|download\/priz|\/file\.html\?uid=|attachments\/download|download\/file/i.test(url || '');
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function readJsonl(path) {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function parseCsv(text) {
  const rows = [];
  let field = '';
  let record = [];
  let inQ = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const n = text[i + 1];
    if (inQ && c === '"' && n === '"') { field += '"'; i += 1; continue; }
    if (c === '"') { inQ = !inQ; continue; }
    if (!inQ && c === ',') { record.push(field); field = ''; continue; }
    if (!inQ && (c === '\n' || c === '\r')) {
      if (c === '\r' && n === '\n') i += 1;
      record.push(field); rows.push(record); field = ''; record = [];
      continue;
    }
    field += c;
  }
  if (field || record.length) { record.push(field); rows.push(record); }
  const [headers, ...data] = rows.filter((row) => row.some((value) => value !== ''));
  return data.map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i] || ''])));
}

function getArg(name, fallback = '') {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || fallback;
}
