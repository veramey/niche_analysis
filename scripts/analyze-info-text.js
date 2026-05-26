#!/usr/bin/env node
/**
 * Second-pass analysis: extract product cards from info_text (TenderGuru HTML description)
 * for tenders that don't have downloaded documents.
 *
 * Reads:  data/processed/{date}/full-tenders.csv  (has info_text)
 *         data/analysis/{date}/tender-requirements.csv  (already analyzed — skip these)
 * Writes: data/analysis/{date}/product-cards/{id}.md  (one per tender)
 *         data/analysis/{date}/tender-requirements.csv  (merged/appended)
 *         data/analysis/{date}/tender-requirements.jsonl
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanText, ensureDir, writeCsv, writeJsonl } from '../src/export-utils.js';

const runDate = getArg('date', '2026-05-25');
const minInfoLen = Number(getArg('min-len', '500'));
const fullPath = `data/processed/${runDate}/full-tenders.csv`;
const outputDir = `data/analysis/${runDate}`;
const cardsDir = join(outputDir, 'product-cards');
const reqCsvPath = join(outputDir, 'tender-requirements.csv');
const reqJsonlPath = join(outputDir, 'tender-requirements.jsonl');
const maxChars = 60000;

ensureDir(outputDir);
ensureDir(cardsDir);

const fullTenders = parseCsv(await readFile(fullPath, 'utf8'));
console.log(`Loaded ${fullTenders.length} full tenders`);

// Which tenders already have a card?
const existingIds = new Set();
if (existsSync(reqCsvPath)) {
  const existing = parseCsv(await readFile(reqCsvPath, 'utf8'));
  for (const r of existing) {
    if (r.tender_id) existingIds.add(r.tender_id);
    if (r.tenderguru_card_id) existingIds.add(r.tenderguru_card_id);
  }
}
console.log(`Already analyzed: ${existingIds.size} tenders`);

// Filter candidates: no existing card, sufficient info_text
const candidates = fullTenders.filter(t => {
  const id = t.tender_id || t.tenderguru_card_id;
  if (!id) return false;
  if (existingIds.has(t.tender_id) || existingIds.has(t.tenderguru_card_id)) return false;
  const decoded = decodeEntities(t.info_text || '');
  const text = stripHtml(decoded);
  return text.length >= minInfoLen;
});
console.log(`Candidates for info_text analysis: ${candidates.length}`);

const TERM_GROUPS = {
  ai: [
    'искусственный интеллект', 'машинное обучение', 'нейронная сеть', 'llm',
    'большая языковая модель', 'rag', 'эмбеддинг', 'векторная база',
    'компьютерное зрение', 'распознавание', 'классификация', 'суммаризация', 'контент-анализ',
  ],
};

const newAnalyses = [];

for (const t of candidates) {
  const decoded = decodeEntities(t.info_text || '');
  const text = stripHtml(decoded).slice(0, maxChars);
  const tenderId = t.tender_id || t.tenderguru_card_id;
  const analysis = analyzeTender(tenderId, t, text);
  newAnalyses.push(analysis);
  await writeFile(join(cardsDir, `${safeName(tenderId)}.md`), renderCard(analysis), 'utf8');
}

console.log(`\nNew analyses: ${newAnalyses.length}`);

// Merge with existing and rewrite
let allAnalyses = newAnalyses;
if (existsSync(reqJsonlPath)) {
  const lines = (await readFile(reqJsonlPath, 'utf8')).trim().split('\n').filter(Boolean);
  const existing = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  allAnalyses = [...existing, ...newAnalyses];
}

const rows = allAnalyses.map(item => ({
  tender_id: item.tender_id,
  tenderguru_card_id: item.tenderguru_card_id,
  customer: item.customer,
  budget_rub: item.budget_rub,
  niche: item.niche,
  product_category: item.product_category,
  opportunity_title: item.opportunity_title,
  problem: item.problem,
  requested_solution: item.requested_solution,
  ai_terms: Array.isArray(item.ai_terms) ? item.ai_terms.join('; ') : item.ai_terms || '',
  modules: Array.isArray(item.modules) ? item.modules.join('; ') : item.modules || '',
  scenarios: Array.isArray(item.scenarios) ? item.scenarios.join(' | ') : item.scenarios || '',
  integrations: Array.isArray(item.integrations) ? item.integrations.join('; ') : item.integrations || '',
  constraints: Array.isArray(item.constraints) ? item.constraints.join('; ') : item.constraints || '',
  mvp_opportunity: item.mvp_opportunity,
  target_buyers: Array.isArray(item.target_buyers) ? item.target_buyers.join('; ') : item.target_buyers || '',
  reuse_score: item.reuse_score,
  complexity: item.complexity,
  evidence_files: Array.isArray(item.evidence_files) ? item.evidence_files.join(' | ') : item.evidence_files || '',
  product_card: item.product_card,
}));

writeCsv(reqCsvPath, rows);
writeJsonl(reqJsonlPath, allAnalyses);

console.log(`Total in tender-requirements: ${allAnalyses.length}`);
console.log(`Output: ${reqCsvPath}`);
console.log(`Cards dir: ${cardsDir}`);

// ─── Analysis pipeline ───────────────────────────────────────────────────────

function analyzeTender(tenderId, t, text) {
  const normalized = text.toLowerCase();
  const aiTerms = findTerms(normalized, TERM_GROUPS.ai);
  const modules = findModules(normalized);
  const integrations = findIntegrations(text);
  const constraints = findConstraints(normalized);
  const scenarios = findScenarios(text);
  const productCategory = classifyProduct(t, normalized, modules, aiTerms);
  const problem = summarizeProblem(t, text, productCategory);
  const requestedSolution = summarizeSolution(t, productCategory, modules, aiTerms);
  const mvpOpportunity = suggestMvp(productCategory, modules, aiTerms);
  const targetBuyers = suggestBuyers(productCategory, t);
  const reuseScore = scoreReuse(productCategory, modules, constraints);
  const complexity = scoreComplexity(modules, constraints, integrations, normalized);
  const opportunityTitle = titleFor(productCategory, t);
  const cardPath = join(cardsDir, `${safeName(tenderId)}.md`);

  return {
    tender_id: tenderId,
    tenderguru_card_id: t.tenderguru_card_id || '',
    tender_name: cleanText(t.tender_name || ''),
    customer: cleanText(t.customer || ''),
    budget_rub: t.price || t.ob_price || '',
    niche: t.niche || '',
    product_category: productCategory,
    opportunity_title: opportunityTitle,
    problem,
    requested_solution: requestedSolution,
    ai_terms: aiTerms,
    modules,
    scenarios,
    integrations,
    constraints,
    mvp_opportunity: mvpOpportunity,
    target_buyers: targetBuyers,
    reuse_score: reuseScore,
    complexity,
    evidence_files: ['info_text'],
    evidence_snippets: buildEvidence(text),
    product_card: cardPath,
  };
}

function classifyProduct(t, text, modules, aiTerms) {
  const name = `${t.tender_name || ''} ${t.niche || ''}`.toLowerCase();
  const combined = `${name}\n${text}`;

  if (hasAny(name, ['голосовой помощник', 'речевого взаимодействия', 'речевое взаимодействие'])
    || hasAny(text.slice(0, 50000), ['голосовой помощник', 'цифровой голосовой помощник', 'речевого взаимодействия'])) {
    return 'voice_assistant_healthcare';
  }
  if (hasAny(combined, ['антикартель', 'dbscan', 'ограничивающих конкуренцию'])) {
    return 'gov_regulatory_analytics';
  }
  if (hasAny(combined, ['llm', 'большая языковая модель', 'rag', 'база знаний', 'чат-бот', 'интеллектуальный помощник'])) {
    return 'enterprise_rag_llm_assistant';
  }
  if (hasAny(combined, ['маммограф', 'dicom', 'медицинск', 'здравоохран', 'пациент', 'лабораторн'])) {
    return 'medical_ai_support';
  }
  if (hasAny(combined, ['компьютерн', 'изображени', 'видеонаблюдени', 'распознаван'])) {
    return 'computer_vision';
  }
  if (hasAny(combined, ['контент-анализ', 'аналитическ', 'мониторинг', 'сбор', 'обработк'])) {
    return 'analytics_monitoring';
  }
  if (modules.includes('process_automation') || hasAny(combined, ['автоматизация процессов', 'бизнес-процесс'])) {
    return 'process_automation';
  }
  if (aiTerms.length > 0) return 'ai_software_services';
  return 'software_services';
}

function summarizeProblem(t, text, productCategory) {
  const snippets = [
    ...keywordLines(text, ['для сотрудников', 'для клиентов', 'проект направлен', 'целями выполнения', 'целью выполнения', 'повышение', 'сокращение', 'автоматизация'], 10),
    ...sectionLines(text, ['ЦЕЛИ И ЗАДАЧИ', 'Цели и задачи', 'Цель оказания услуг']),
  ].filter(isUsefulLine).filter(l => !/техническое задание.*определяет|термины.*сокращения/i.test(l));
  const compact = snippets.map(cleanBullet).filter(Boolean).slice(0, 5).join(' ');
  if (compact) return compact;

  const fallback = {
    enterprise_rag_llm_assistant: 'Нужен быстрый и управляемый доступ к знаниям и документам через AI-канал.',
    medical_ai_support: 'Нужно обеспечить бесперебойную работу медицинского AI-компонента.',
    gov_regulatory_analytics: 'Нужно сопровождать аналитическую государственную систему.',
    analytics_monitoring: 'Нужно собирать, обрабатывать и анализировать информацию для управленческих решений.',
  };
  return fallback[productCategory] || cleanText(t.reason || t.tender_name || 'Проблема уточняется.');
}

function summarizeSolution(t, productCategory, modules, aiTerms) {
  const templates = {
    enterprise_rag_llm_assistant: 'LLM/RAG-помощник с чат-интерфейсом, базами знаний, document QA, суммаризацией и интеграциями.',
    medical_ai_support: 'Сопровождение медицинского AI: мониторинг, обновления, диагностика, обучение пользователей.',
    gov_regulatory_analytics: 'Эксплуатация аналитической ГИС: поддержка, мониторинг, обработка запросов, защита информации.',
    voice_assistant_healthcare: 'Голосовой AI-помощник: распознавание речи, сценарии диалога, интеграция с расписанием.',
    computer_vision: 'Решение для обработки изображений/видео с AI/CV-компонентами.',
    analytics_monitoring: 'Сервис сбора, контент-анализа и сопровождения аналитических модулей.',
    process_automation: 'ПО для автоматизации процессов, интеграции данных и цифровых сценариев.',
  };
  const base = templates[productCategory] || cleanText(t.tender_name || 'ПО/услуги по ИИ.');
  const suffix = (modules.length || aiTerms.length)
    ? ` Ключевые элементы: ${[...modules, ...aiTerms].slice(0, 8).join(', ')}.`
    : '';
  return `${base}${suffix}`;
}

function suggestMvp(productCategory, modules, aiTerms) {
  const suggestions = {
    enterprise_rag_llm_assistant: 'Secure RAG assistant: загрузка документов, векторная база, чат с источниками, summary, feedback и API для портала.',
    medical_ai_support: 'Managed AI support desk: мониторинг, SLA, база знаний ошибок, обучение и compliance-пакет.',
    gov_regulatory_analytics: 'AI operations cockpit: мониторинг моделей, обработка обращений, объяснимые отчеты, база знаний.',
    voice_assistant_healthcare: 'Voice appointment assistant: запись/отмена, маршрутизация, интеграция с расписанием.',
    computer_vision: 'CV pilot kit: приём изображений/видео, модель, кабинет проверки, отчёт качества и API.',
    analytics_monitoring: 'AI monitoring workspace: сбор источников, классификация, дашборд инсайтов и отчёты.',
    process_automation: 'Process automation assistant: приём заявок, классификация, маршрутизация, генерация документов.',
  };
  return suggestions[productCategory] || 'Discovery MVP: быстрый пилот на одном процессе с замером эффекта.';
}

function suggestBuyers(productCategory, t) {
  const map = {
    enterprise_rag_llm_assistant: ['энергетика', 'инфраструктура', 'телеком', 'банки', 'промышленные холдинги', 'госуслуги'],
    medical_ai_support: ['региональные минздравы', 'медицинские ИТ-операторы', 'клиники с PACS/RIS/LIS'],
    gov_regulatory_analytics: ['федеральные ведомства', 'регуляторы', 'контрольно-надзорные органы'],
    voice_assistant_healthcare: ['региональные минздравы', 'медицинские ИАЦ', 'контакт-центры клиник'],
    computer_vision: ['промышленность', 'безопасность', 'медицина', 'транспорт', 'ритейл'],
    analytics_monitoring: ['муниципалитеты', 'PR/GR-службы', 'ситуационные центры'],
    process_automation: ['крупные операционные компании', 'госучреждения', 'банки', 'логистика'],
  };
  const buyers = map[productCategory] || ['компании с ИИ/автоматизацией в закупках'];
  if (/москва|област|муницип/i.test(t.customer || '')) buyers.push('региональные и муниципальные заказчики');
  return [...new Set(buyers)];
}

function scoreReuse(productCategory, modules, constraints) {
  let score = 0;
  if (['enterprise_rag_llm_assistant', 'analytics_monitoring', 'process_automation', 'voice_assistant_healthcare'].includes(productCategory)) score += 2;
  if (modules.includes('rag') || modules.includes('document_ai') || modules.includes('chat_ui')) score += 1;
  if (constraints.includes('closed_contour') || constraints.includes('information_security')) score -= 0.5;
  if (productCategory === 'medical_ai_support') score -= 0.5;
  if (score >= 2.5) return 'high';
  if (score >= 1) return 'medium';
  return 'low';
}

function scoreComplexity(modules, constraints, integrations, text) {
  let score = 0;
  score += integrations.length >= 3 ? 2 : integrations.length > 0 ? 1 : 0;
  score += constraints.includes('closed_contour') ? 1 : 0;
  score += constraints.includes('information_security') ? 1 : 0;
  score += /критическ|гис|исспдн|персональн|скзи|vipnet/i.test(text) ? 1 : 0;
  score += modules.includes('on_prem_llm') ? 1 : 0;
  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

function titleFor(productCategory, t) {
  const titles = {
    enterprise_rag_llm_assistant: 'Защищенный корпоративный RAG/LLM-помощник',
    medical_ai_support: 'Сопровождение медицинских AI-компонентов',
    gov_regulatory_analytics: 'Эксплуатация аналитической ГИС с AI/ML',
    voice_assistant_healthcare: 'Голосовой AI-помощник',
    computer_vision: 'Computer Vision решение для распознавания и анализа',
    analytics_monitoring: 'AI-сервис мониторинга и контент-анализа',
    process_automation: 'Автоматизация процессов и цифровых сценариев',
  };
  return titles[productCategory] || cleanText(t.tender_name || 'AI/software opportunity').slice(0, 120);
}

function findModules(text) {
  const checks = [
    ['rag', ['rag', 'retrieval augmented', 'база знаний', 'векторн', 'эмбеддинг']],
    ['llm_pipeline', ['пайплайн', 'промпт', 'большая языковая модель', 'llm']],
    ['chat_ui', ['чат', 'чат-бот', 'диалог', 'мессенджер']],
    ['document_ai', ['анализ документов', 'суммаризац', 'извлечение фактов', 'классификац', 'сравнение документов']],
    ['integration', ['интеграц', 'api', 'sdk', 'информационное взаимодействие']],
    ['knowledge_base', ['база знаний']],
    ['monitoring_support', ['мониторинг', 'техническая поддержка', 'сопровожд', 'эксплуатац']],
    ['information_security', ['информационной безопасности', 'защита информации', 'скзи', 'vipnet']],
    ['on_prem_llm', ['закрытом контуре', 'без обращения в интернет', 'gpu']],
    ['process_automation', ['автоматизация процессов', 'бизнес-процесс', 'workflow']],
    ['computer_vision', ['dicom', 'маммограф', 'снимк', 'видеонаблюд', 'компьютерное зрение']],
  ];
  return checks.filter(([, terms]) => hasAny(text, terms)).map(([name]) => name);
}

function findIntegrations(text) {
  const patterns = [
    ['корпоративный портал', /корпоративн\w*\s+портал/i],
    ['корпоративный мессенджер', /мессенджер|система объединенных коммуникаций/i],
    ['интеграционная шина', /интеграционн\w*\s+шин/i],
    ['ЕГИСЗ/медицинские подсистемы', /\bегисз\b|\bлис\b|\bцами\b|\bpacs\b|\bris\b/i],
    ['система техподдержки', /служб[аы] технической поддержки|система стп/i],
    ['портал/внешний сайт', /портал|сайт/i],
    ['1С', /\b1с\b|1с:/i],
    ['ERP/CRM', /\berp\b|\bcrm\b/i],
  ];
  return patterns.filter(([, re]) => re.test(text)).map(([name]) => name).slice(0, 8);
}

function findConstraints(text) {
  const checks = [
    ['closed_contour', ['закрытом контуре', 'без обращения в интернет', 'ит-инфраструктуре заказчика']],
    ['information_security', ['информационной безопасности', 'защита информации', 'модель угроз', 'скзи', 'vipnet']],
    ['personal_data', ['персональн', 'испдн']],
    ['critical_infrastructure', ['критическ', 'кии', 'значимым объектом']],
    ['domestic_registry', ['реестр российских программ', 'реестровая запись']],
    ['sla_24x7', ['24х7', '24x7', 'круглосуточно']],
    ['on_prem_hardware', ['gpu', 'a100', 'стойк']],
  ];
  return checks.filter(([, terms]) => hasAny(text, terms)).map(([name]) => name);
}

function findScenarios(text) {
  const lines = [
    ...sectionLines(text, ['Сценарии применения', 'Сценарий ', 'Требования к проверке']),
    ...keywordLines(text, ['сценарий «', 'сценар', 'чат-бот', 'суммаризац', 'сравнение документов', 'мониторинг работоспособности'], 18),
  ].map(cleanBullet).filter(l => l.length > 30 && l.length < 320).filter(isUsefulLine);
  return [...new Set(lines)].slice(0, 8);
}

function buildEvidence(text) {
  return keywordLines(text, ['цель', 'задач', 'сценар', 'интеграц', 'база знаний', 'llm', 'rag', 'требования'], 10)
    .map(cleanBullet).filter(Boolean).slice(0, 12);
}

function findTerms(text, terms) {
  return terms.filter(t => text.includes(t.toLowerCase()));
}

function sectionLines(text, headings) {
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    if (headings.some(h => lines[i].toLowerCase().includes(h.toLowerCase())) && !/PAGEREF|TOC/i.test(lines[i])) {
      result.push(...lines.slice(i, i + 10).filter(isUsefulLine));
    }
  }
  return result;
}

function keywordLines(text, keywords, limit) {
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const result = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (keywords.some(k => lower.includes(k)) && isUsefulLine(line)) {
      result.push(line);
      if (result.length >= limit) break;
    }
  }
  return result;
}

function isUsefulLine(line) {
  const v = String(line || '').trim();
  if (v.length < 25) return false;
  if (/PAGEREF|_Toc|MERGEFORMAT/i.test(v)) return false;
  return true;
}

function cleanBullet(v) {
  return cleanText(v).replace(/^[-•\d.\s]+/, '').replace(/\s+/g, ' ').trim();
}

// ─── HTML helpers ────────────────────────────────────────────────────────────

function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripHtml(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ─── Render ──────────────────────────────────────────────────────────────────

function renderCard(item) {
  return `# ${item.opportunity_title}

Тендер: \`${item.tender_id}\`
Карточка TenderGuru: \`${item.tenderguru_card_id || '-'}\`
Заказчик: ${item.customer || '-'}
Бюджет: ${item.budget_rub || '-'} руб.
Ниша: \`${item.niche || '-'}\`
Категория продукта: \`${item.product_category}\`
Источник: \`info_text\`

## Предмет

${item.tender_name}

## Бизнес-Боль

${item.problem}

## Что Хотят Купить

${item.requested_solution}

## Модули И Технологии

${bulletList([...item.modules, ...item.ai_terms])}

## Сценарии

${bulletList(item.scenarios)}

## Интеграции

${bulletList(item.integrations)}

## Ограничения

${bulletList(item.constraints)}

## MVP-Возможность

${item.mvp_opportunity}

## Кому Еще Продавать

${bulletList(item.target_buyers)}

## Оценка

- Повторяемость: ${item.reuse_score}
- Сложность: ${item.complexity}

## Evidence (из описания тендера)

${bulletList(item.evidence_snippets)}
`;
}

function bulletList(items) {
  const values = [...new Set((items || []).filter(Boolean))];
  return values.length ? values.map(i => `- ${i}`).join('\n') : '- Не найдено в описании.';
}

function hasAny(text, terms) {
  return terms.some(t => text.includes(t.toLowerCase()));
}

function safeName(v) {
  return String(v || 'unknown').replace(/[^a-zA-Zа-яА-Я0-9_.-]+/g, '_');
}

// ─── CSV parser ──────────────────────────────────────────────────────────────

function parseCsv(content) {
  const records = [];
  let field = '', record = [], inQ = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i], n = content[i + 1];
    if (inQ && c === '"' && n === '"') { field += '"'; i++; continue; }
    if (c === '"') { inQ = !inQ; continue; }
    if (!inQ && c === ',') { record.push(field); field = ''; continue; }
    if (!inQ && (c === '\n' || c === '\r')) {
      if (c === '\r' && n === '\n') i++;
      record.push(field); records.push(record); field = ''; record = [];
      continue;
    }
    field += c;
  }
  if (field || record.length) { record.push(field); records.push(record); }
  const [headers, ...data] = records.filter(r => r.some(v => v !== ''));
  if (!headers) return [];
  return data.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] || ''])));
}

function getArg(name, def) {
  const prefix = `--${name}=`;
  return process.argv.find(a => a.startsWith(prefix))?.slice(prefix.length) || def;
}
