#!/usr/bin/env node
/**
 * Builds dashboard records and markdown cards for EDO/document automation
 * tenders discovered on zakupki.gov.ru.
 *
 * Usage:
 *   node scripts/build-edo-dashboard-cards.js --date=2026-05-30
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { promisify } from 'node:util';
import { cleanText, ensureDir } from '../src/export-utils.js';

const execFileAsync = promisify(execFile);

const DATE = getArg('date', '2026-05-30');
const INPUT_CSV = getArg('input', `data/processed/${DATE}/zakupki-edo-ai-relevant.csv`);
const DOCS_JSONL = getArg('docs', `data/processed/${DATE}/zakupki-edo-docs.jsonl`);
const FILES_MANIFEST = getArg('files', `data/processed/${DATE}/zakupki-edo-doc-files-browser-manifest.jsonl`);
const OUT_DIR = 'public/data';
const CARDS_DIR = `${OUT_DIR}/cards`;

ensureDir(CARDS_DIR);

const tenders = parseCsv(readFileSync(INPUT_CSV, 'utf8'));
const docsMap = new Map(readJsonl(DOCS_JSONL).map((row) => [row.tender_num, row]));
const filesByTender = groupBy(readJsonl(FILES_MANIFEST), (row) => row.tender_num);

const records = [];
let cardsWritten = 0;

for (const tender of tenders) {
  const docs = docsMap.get(tender.tender_num) || {};
  const files = filesByTender.get(tender.tender_num) || [];
  const analysis = await analyzeTender(tender, docs, files);
  records.push(toDashboardRecord(tender, docs, files, analysis));
  writeFileSync(`${CARDS_DIR}/${tender.tender_num}.md`, renderCard(tender, docs, files, analysis), 'utf8');
  cardsWritten += 1;
}

const tendersPath = `${OUT_DIR}/tenders.json`;
const existing = existsSync(tendersPath)
  ? JSON.parse(readFileSync(tendersPath, 'utf8'))
  : [];
const recordIds = new Set(records.map((row) => row.tender_num));
const merged = [
  ...existing.filter((row) => !recordIds.has(row.tender_num || row.tender_id)),
  ...records,
];

writeFileSync(tendersPath, JSON.stringify(merged));
writeFileSync(`${OUT_DIR}/meta.json`, JSON.stringify({ date: DATE }));

console.log(`tenders.json: ${merged.length} total (${records.length} EDO records added/updated)`);
console.log(`cards: ${cardsWritten} files written to ${CARDS_DIR}`);

async function analyzeTender(tender, docs, files) {
  const tzFiles = files.filter((file) => file.is_tz === 'yes' && file.status === 'downloaded');
  const primaryFiles = tzFiles.length ? tzFiles : files.filter((file) => file.status === 'downloaded').slice(0, 3);
  const textParts = [];

  for (const file of primaryFiles) {
    const text = await extractText(file.file_path);
    if (text) textParts.push({ file, text });
  }

  const fullText = cleanText(textParts.map((part) => part.text).join('\n\n')).slice(0, 300_000);
  const combined = `${tender.name || ''}\n${fullText}`.toLowerCase();
  const modules = findModules(combined);
  const constraints = findConstraints(combined);
  const integrations = findIntegrations(combined);
  const snippets = evidenceSnippets(fullText);
  const productCategory = classifyProduct(tender, combined, modules);

  return {
    fullText,
    textParts,
    snippets,
    modules,
    constraints,
    integrations,
    product_category: productCategory,
    niche: productCategory === 'edo_platform_generic' ? 'edo_platform' : 'edo_automation',
    sphere: classifySphere(tender),
    sphere_label: sphereLabel(classifySphere(tender)),
    opportunity_title: titleFor(productCategory, tender),
    problem: summarizeProblem(tender, fullText, productCategory),
    requested_solution: summarizeSolution(tender, productCategory, modules, integrations),
    mvp_opportunity: suggestMvp(productCategory, modules),
    target_buyers: suggestBuyers(productCategory, tender),
    reuse_score: scoreReuse(productCategory, modules, constraints),
    complexity: scoreComplexity(files, modules, constraints, integrations),
    relevance_score: tender.score || '',
    ai_terms: findAiTerms(combined),
  };
}

async function extractText(path) {
  if (!path || !existsSync(path)) return '';
  const ext = extname(path).toLowerCase();
  try {
    if (ext === '.docx') {
      const { stdout } = await execFileAsync('unzip', ['-p', path, 'word/document.xml'], { maxBuffer: 20 * 1024 * 1024 });
      return cleanDocxXml(stdout);
    }
    if (ext === '.doc' || ext === '.rtf') {
      const { stdout } = await execFileAsync('textutil', ['-convert', 'txt', '-stdout', path], { maxBuffer: 20 * 1024 * 1024 });
      return cleanText(stdout);
    }
    if (ext === '.pdf') {
      const { stdout } = await execFileAsync('pdftotext', [path, '-'], { maxBuffer: 20 * 1024 * 1024 });
      return cleanText(stdout);
    }
  } catch {
    return '';
  }
  return '';
}

function toDashboardRecord(t, docs, files, a) {
  const realDocs = (docs.docs || []).filter((doc) => isDownloadUrl(doc.url));
  const tzDocs = realDocs.filter((doc) => doc.is_tz);
  return {
    tender_id: t.tender_num,
    tender_num: t.tender_num,
    tender_name: t.name,
    customer: t.customer,
    budget_rub: t.price_rub ? String(parseFloat(t.price_rub)) : '',
    date: t.publish_date?.replace(/\./g, '-') || '',
    end_time: t.deadline?.replace(/\./g, '-') || '',
    fz: extractFz(t.fz),
    status: t.status || '',
    eis_link: t.tender_link || '',
    tender_link: t.tender_link || '',
    docs_count: realDocs.length,
    tz_count: tzDocs.length,
    evidence_files: files.some((file) => file.status === 'downloaded') ? 'docs' : '',
    has_card: true,
    doc_links: tzDocs.map((doc) => doc.url).join(' | '),
    source: 'eis',
    source_segment: 'zakupki_edo_ai',
    classification: t.classification || '',
    matched_terms: [t.domain_terms, t.ai_automation_terms, t.platform_terms].filter(Boolean).join('; '),
    reason: t.reason || '',
    relevance_score: a.relevance_score,
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

function renderCard(t, docs, files, a) {
  const realDocs = (docs.docs || []).filter((doc) => isDownloadUrl(doc.url));
  const tzDocs = realDocs.filter((doc) => doc.is_tz);
  const otherDocs = realDocs.filter((doc) => !doc.is_tz);
  const downloadedTz = files.filter((file) => file.is_tz === 'yes' && file.status === 'downloaded');
  const downloadedOther = files.filter((file) => file.is_tz !== 'yes' && file.status === 'downloaded');
  const lines = [];

  lines.push(`# ${a.opportunity_title}`);
  lines.push('');
  lines.push(`Тендер: \`${t.tender_num}\``);
  lines.push(`Заказчик: ${t.customer || '—'}`);
  lines.push(`Бюджет: ${t.price_rub ? fmtBudget(Number(t.price_rub)) : '—'}`);
  lines.push(`Ниша: \`${a.niche}\``);
  lines.push(`Категория продукта: \`${a.product_category}\``);
  lines.push('');

  lines.push('## Предмет');
  lines.push('');
  lines.push(t.name || '—');
  lines.push('');

  lines.push('## Бизнес-Боль');
  lines.push('');
  lines.push(a.problem);
  lines.push('');

  lines.push('## Что Хотят Купить');
  lines.push('');
  lines.push(a.requested_solution);
  lines.push('');

  if (a.modules.length || a.integrations.length || a.constraints.length) {
    lines.push('## Модули и Требования');
    lines.push('');
    for (const item of a.modules) lines.push(`- ${moduleLabel(item)}`);
    for (const item of a.integrations) lines.push(`- Интеграция: ${item}`);
    for (const item of a.constraints) lines.push(`- Ограничение: ${constraintLabel(item)}`);
    lines.push('');
  }

  if (a.snippets.length) {
    lines.push('## Evidence Из ТЗ');
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
  lines.push(`- Релевантность первичного скоринга: ${t.score || '—'}`);
  lines.push(`- Класс поиска: ${t.classification || '—'}`);
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
  if (t.tender_link) lines.push(`- [Карточка на ЕИС](${t.tender_link})`);
  if (docs.docs_url) lines.push(`- [Документы на ЕИС](${docs.docs_url})`);
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function classifyProduct(tender, text, modules) {
  const cls = tender.classification || '';
  if (cls === 'edo_platform_generic') return 'edo_platform_generic';
  if (modules.includes('integration_medo') || modules.includes('platform_migration') || modules.includes('workflow')) return 'edo_automation';
  if (/автоматизированн|автоматизац/i.test(text)) return 'edo_automation';
  return 'edo_platform_generic';
}

function findModules(text) {
  const checks = [
    ['integration_medo', ['мэдо', 'межведомственного электронного документооборота']],
    ['sed_platform', ['сэд дело', 'directum', 'тезис', '1с: документооборот', 'система электронного документооборота']],
    ['workflow', ['маршрутизац', 'согласован', 'исполнение поручений', 'резолюц']],
    ['platform_migration', ['миграц', 'postgres', 'ред ос', 'импорт данных', 'перенос данных']],
    ['licensing', ['неисключительных прав', 'лицензи', 'право использования']],
    ['support', ['сопровожд', 'техническая поддержка', 'консультац']],
    ['document_archive', ['архив', 'хранени', 'база данных']],
  ];
  return checks.filter(([, terms]) => terms.some((term) => text.includes(term))).map(([name]) => name);
}

function findConstraints(text) {
  const checks = [
    ['compatibility_existing_sed', ['совместимост', 'имеющейся', 'эксплуатируемой', 'сэд дело']],
    ['domestic_stack', ['отечественн', 'реестр российских программ', 'postgres pro', 'ред ос']],
    ['information_security', ['защита информации', 'информационной безопасности', 'сертифицированн']],
    ['on_prem', ['на сервере заказчика', 'инфраструктур', 'локальн']],
    ['personal_data', ['персональн']],
  ];
  return checks.filter(([, terms]) => terms.some((term) => text.includes(term))).map(([name]) => name);
}

function findIntegrations(text) {
  const checks = [
    ['МЭДО', ['мэдо', 'межведомственного электронного документооборота']],
    ['СЭД Дело', ['сэд дело', 'дело']],
    ['Directum RX', ['directum']],
    ['Тезис', ['тезис']],
    ['Postgres Pro / РЕД ОС', ['postgres pro', 'ред ос']],
    ['1С: Документооборот', ['1с: документооборот']],
  ];
  return checks.filter(([, terms]) => terms.some((term) => text.includes(term))).map(([name]) => name);
}

function findAiTerms(text) {
  const terms = ['ocr', 'искусственный интеллект', 'машинное обучение', 'нейросеть', 'распознавание документов', 'классификация документов', 'извлечение реквизитов'];
  return terms.filter((term) => text.includes(term));
}

function summarizeProblem(tender, text, productCategory) {
  const lines = evidenceSnippets(text);
  if (lines.length) return lines[0];
  if (productCategory === 'edo_automation') return 'Нужно развить или адаптировать существующий электронный документооборот без остановки текущего делопроизводства.';
  return 'Нужно обеспечить работу существующей СЭД, лицензий или сопровождения документооборота.';
}

function summarizeSolution(tender, productCategory, modules, integrations) {
  const parts = [];
  if (productCategory === 'edo_automation') parts.push('Развитие, адаптация или миграция СЭД/ЭДО с настройкой процессов делопроизводства.');
  else parts.push('Поставка лицензий, сопровождение или поддержка платформы электронного документооборота.');
  if (integrations.length) parts.push(`Интеграции/платформы: ${integrations.join(', ')}.`);
  if (modules.length) parts.push(`Ключевые модули: ${modules.map(moduleLabel).join(', ')}.`);
  return parts.join(' ');
}

function suggestMvp(productCategory, modules) {
  if (modules.includes('platform_migration')) return 'Migration pilot: инвентаризация базы СЭД, тестовый перенос, проверка прав доступа, регламент отката и контроль качества данных.';
  if (modules.includes('integration_medo')) return 'MЭДО integration kit: подключение обмена, журналирование, контроль статусов, диагностика ошибок и отчеты по доставке документов.';
  if (productCategory === 'edo_automation') return 'EDO workflow pilot: карта маршрутов документов, роли, статусы, контроль поручений, шаблоны отчетов и метрики SLA.';
  return 'EDO support pack: регламент сопровождения, база типовых обращений, мониторинг доступности и план обновлений.';
}

function suggestBuyers(productCategory, tender) {
  const base = ['федеральные ведомства', 'региональные органы власти', 'территориальные фонды ОМС', 'госучреждения с СЭД'];
  if (/медицин|здравоохран|\bомс\b/i.test(`${tender.customer} ${tender.name}`)) base.push('медицинские организации');
  if (productCategory === 'edo_automation') base.push('крупные организации с распределенным делопроизводством');
  return [...new Set(base)];
}

function scoreReuse(productCategory, modules, constraints) {
  let score = productCategory === 'edo_automation' ? 2 : 1;
  if (modules.includes('integration_medo') || modules.includes('workflow')) score += 1;
  if (constraints.includes('compatibility_existing_sed')) score -= 0.5;
  return score >= 2.5 ? 'high' : score >= 1.5 ? 'medium' : 'low';
}

function scoreComplexity(files, modules, constraints, integrations) {
  let score = 0;
  if (files.length >= 8) score += 1;
  if (modules.includes('platform_migration')) score += 2;
  if (modules.includes('integration_medo')) score += 1;
  if (integrations.length >= 2) score += 1;
  if (constraints.includes('information_security') || constraints.includes('domestic_stack')) score += 1;
  return score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low';
}

function titleFor(productCategory, tender) {
  if (productCategory === 'edo_automation') return 'Автоматизация и развитие электронного документооборота';
  return 'Сопровождение платформы электронного документооборота';
}

function classifySphere(tender) {
  const customer = `${tender.customer || ''}`.toLowerCase();
  const name = `${tender.name || ''}`.toLowerCase();
  if (/\bомс\b|медицин|здравоохран|поликлиник|больниц|скорой медицинской/i.test(customer)) return 'healthcare';
  if (/медицинск|здравоохран|реанимационно-анестезиолог/i.test(name)) return 'healthcare';
  if (/культур|библиотек/i.test(customer)) return 'culture_sport';
  if (/сельского хозяйства/i.test(customer)) return 'agriculture_ecology';
  return 'public_admin';
}

function sphereLabel(sphere) {
  const labels = {
    healthcare: 'Медицина',
    culture_sport: 'Культура / спорт / туризм',
    agriculture_ecology: 'АПК / экология',
    public_admin: 'Госуправление',
  };
  return labels[sphere] || sphere;
}

function evidenceSnippets(text) {
  const lines = cleanText(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => cleanBullet(line))
    .filter((line) => line.length >= 50 && line.length <= 420);
  const keywords = ['объект закупки', 'цель', 'сэд', 'мэдо', 'электронного документооборота', 'автоматизац', 'маршрутизац', 'согласован', 'миграц', 'совместим'];
  return [...new Set(lines.filter((line) => keywords.some((kw) => line.toLowerCase().includes(kw))))].slice(0, 10);
}

function cleanDocxXml(xml) {
  return cleanText(
    xml
      .replace(/<w:p[ >][^]*?<\/w:p>/g, (match) => `${match.replace(/<[^>]+>/g, '')}\n`)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '),
  );
}

function cleanBullet(value) {
  return cleanText(value)
    .replace(/^[-•\d.\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function moduleLabel(value) {
  const labels = {
    integration_medo: 'Интеграция с МЭДО',
    sed_platform: 'Платформа СЭД/ЭДО',
    workflow: 'Маршрутизация, согласование и поручения',
    platform_migration: 'Миграция платформы или данных',
    licensing: 'Лицензии и права использования',
    support: 'Сопровождение и техническая поддержка',
    document_archive: 'Архив и хранение документов',
  };
  return labels[value] || value;
}

function constraintLabel(value) {
  const labels = {
    compatibility_existing_sed: 'совместимость с существующей СЭД',
    domestic_stack: 'отечественный стек или реестр российского ПО',
    information_security: 'требования информационной безопасности',
    on_prem: 'контур или инфраструктура заказчика',
    personal_data: 'персональные данные',
  };
  return labels[value] || value;
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
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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
      record.push(field);
      rows.push(record);
      field = '';
      record = [];
      continue;
    }
    field += c;
  }
  if (field || record.length) {
    record.push(field);
    rows.push(record);
  }
  const [headers, ...data] = rows.filter((row) => row.some((value) => value !== ''));
  return data.map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i] || ''])));
}

function getArg(name, fallback = '') {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || fallback;
}
