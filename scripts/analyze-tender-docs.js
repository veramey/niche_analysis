#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  cleanText,
  ensureDir,
  writeCsv,
  writeJsonl,
} from '../src/export-utils.js';

const runDate = getArg('date', '2026-05-25');
const classifiedPath = getArg('classified', `data/processed/${runDate}/classified-tenders.csv`);
const manifestPath = getArg('manifest', `data/raw/tenderguru/${runDate}/docs-manifest.csv`);
const docsDir = getArg('docs-dir', `data/raw/tenderguru/${runDate}/docs`);
const outputDir = getArg('output', `data/analysis/${runDate}`);
const cardsDir = join(outputDir, 'product-cards');
const maxCharsPerTender = Number(getArg('max-chars', '600000'));
const TERM_GROUPS = {
  ai: [
    'искусственный интеллект',
    'машинное обучение',
    'нейронная сеть',
    'llm',
    'большая языковая модель',
    'rag',
    'эмбеддинг',
    'векторная база',
    'компьютерное зрение',
    'распознавание',
    'классификация',
    'суммаризация',
    'контент-анализ',
  ],
};

ensureDir(outputDir);
ensureDir(cardsDir);

const tenders = parseCsv(await readFile(classifiedPath, 'utf8'));
const manifestRows = existsSync(manifestPath) ? parseCsv(await readFile(manifestPath, 'utf8')) : [];
const manifestByTender = groupManifest(manifestRows);
const tenderRowsById = buildTenderLookup(tenders);
const textPathsByTender = await discoverTextPaths(manifestByTender);

const analyses = [];

for (const [tenderId, textPaths] of [...textPathsByTender.entries()].sort()) {
  const tender = tenderRowsById.get(tenderId) || {};
  const docs = await readTenderDocs(textPaths);
  const analysis = analyzeTender(tenderId, tender, docs);
  analyses.push(analysis);
  await writeFile(join(cardsDir, `${safeName(tenderId)}.md`), renderCard(analysis), 'utf8');
}

const rows = analyses.map((item) => ({
  tender_id: item.tender_id,
  tenderguru_card_id: item.tenderguru_card_id,
  customer: item.customer,
  budget_rub: item.budget_rub,
  niche: item.niche,
  product_category: item.product_category,
  opportunity_title: item.opportunity_title,
  problem: item.problem,
  requested_solution: item.requested_solution,
  ai_terms: item.ai_terms.join('; '),
  modules: item.modules.join('; '),
  scenarios: item.scenarios.join(' | '),
  integrations: item.integrations.join('; '),
  constraints: item.constraints.join('; '),
  mvp_opportunity: item.mvp_opportunity,
  target_buyers: item.target_buyers.join('; '),
  reuse_score: item.reuse_score,
  complexity: item.complexity,
  evidence_files: item.evidence_files.join(' | '),
  product_card: item.product_card,
}));

writeCsv(join(outputDir, 'tender-requirements.csv'), rows);
writeJsonl(join(outputDir, 'tender-requirements.jsonl'), analyses);
await writeFile(join(outputDir, 'mvp-shortlist.md'), renderShortlist(analyses), 'utf8');

console.log(`Analyzed tenders: ${analyses.length}`);
console.log(`Product cards: ${cardsDir}`);
console.log(`CSV: ${join(outputDir, 'tender-requirements.csv')}`);
console.log(`Shortlist: ${join(outputDir, 'mvp-shortlist.md')}`);

function analyzeTender(tenderId, tender, docs) {
  const allText = docs.map((doc) => doc.text).join('\n\n').slice(0, maxCharsPerTender);
  const normalized = allText.toLowerCase();
  const aiTerms = findTerms(normalized, TERM_GROUPS.ai);
  const modules = findModules(normalized);
  const integrations = findIntegrations(allText);
  const constraints = findConstraints(normalized);
  const scenarios = findScenarios(allText);
  const productCategory = classifyProduct(tender, normalized, modules, aiTerms);
  const problem = summarizeProblem(tender, allText, productCategory);
  const requestedSolution = summarizeSolution(tender, productCategory, modules, aiTerms);
  const mvpOpportunity = suggestMvp(productCategory, modules, aiTerms);
  const targetBuyers = suggestBuyers(productCategory, tender);
  const reuseScore = scoreReuse(productCategory, modules, constraints);
  const complexity = scoreComplexity(modules, constraints, integrations, normalized);
  const opportunityTitle = titleFor(productCategory, tender);
  const cardPath = join(cardsDir, `${safeName(tenderId)}.md`);

  return {
    tender_id: tenderId,
    tenderguru_card_id: tender.tenderguru_card_id || '',
    tender_name: tender.tender_name || firstMeaningfulLine(allText),
    customer: cleanText(tender.customer || ''),
    budget_rub: tender.price || '',
    niche: tender.niche || '',
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
    evidence_files: docs.map((doc) => doc.path),
    evidence_snippets: buildEvidence(allText),
    product_card: cardPath,
  };
}

function classifyProduct(tender, text, modules, aiTerms) {
  const name = `${tender.tender_name || ''} ${tender.niche || ''}`.toLowerCase();
  const combined = `${name}\n${text}`;

  if (
    hasAny(name, ['голосовой помощник', 'речевого взаимодействия', 'речевое взаимодействие'])
    || hasAny(text.slice(0, 50000), ['голосовой помощник', 'цифровой голосовой помощник', 'речевого взаимодействия'])
  ) {
    return 'voice_assistant_healthcare';
  }

  if (hasAny(combined, ['антикартель', 'dbscan', 'ограничивающих конкуренцию', 'пресечению ограничивающих конкуренцию'])) {
    return 'gov_regulatory_analytics';
  }

  // CV checked before RAG/LLM — strong name-level signals take priority
  if (hasAny(name, ['фотовидеофиксаци', 'видеофиксаци', 'распознавани', 'компьютерное зрение', 'dicom', 'маммограф'])) {
    return 'computer_vision';
  }

  // Medical: require at least one AI signal alongside medical term to avoid false positives on physical goods
  if (
    hasAny(combined, ['маммограф', 'dicom', 'пациент'])
    || (hasAny(combined, ['медицинск', 'здравоохран', 'лабораторн'])
        && hasAny(combined, ['искусственн', 'нейросет', 'диагностик', 'поддержки принятия', 'клинических решени', 'lims', 'ehr', 'emr']))
  ) {
    return 'medical_ai_support';
  }

  // Use word-boundary match for short terms to avoid substring false positives (e.g. load_amperage → rag)
  if (
    hasWord(combined, 'llm') || hasWord(combined, 'rag')
    || hasAny(combined, ['большая языковая модель', 'база знаний', 'чат-бот', 'интеллектуальный помощник'])
  ) {
    return 'enterprise_rag_llm_assistant';
  }

  // 'компьютерн' removed — matches OKPD2 "разработка компьютерного ПО"; 'изображени' narrowed — matches monitors/TVs
  if (hasAny(combined, ['компьютерное зрение', 'обработка изображени', 'анализ изображени', 'распознавани изображени', 'видеонаблюдени', 'распознаван'])) {
    return 'computer_vision';
  }

  // 'сбор' and 'обработк' removed — too generic (standard procurement boilerplate)
  // 'мониторинг' kept but only when not about price monitoring
  if (hasAny(combined, ['контент-анализ', 'аналитическ'])
    || (combined.includes('мониторинг') && !combined.includes('мониторинг цен'))) {
    return 'analytics_monitoring';
  }

  if (modules.includes('process_automation') || hasAny(combined, ['автоматизация процессов', 'бизнес-процесс'])) {
    return 'process_automation';
  }

  if (aiTerms.length > 0) return 'ai_software_services';
  return 'software_services';
}

function summarizeProblem(tender, text, productCategory) {
  const snippets = [
    ...keywordLines(text, ['для сотрудников', 'для клиентов', 'проект направлен', 'целями выполнения', 'целью выполнения', 'для достижения', 'повышение', 'сокращение', 'автоматизация'], 10),
    ...sectionLines(text, ['ЦЕЛИ И ЗАДАЧИ', 'Цели и задачи Проекта', 'Цель оказания услуг']),
  ].filter(isUsefulAnalysisLine).filter((line) => !/техническое задание.*определяет|термины.*сокращения|таблица.*используемые термины/i.test(line));
  const compact = snippets.map(cleanBullet).filter(Boolean).slice(0, 5).join(' ');

  if (compact) return compact;

  const fallback = {
    enterprise_rag_llm_assistant: 'Нужен быстрый и управляемый доступ сотрудников/клиентов к знаниям, документам и сервисной информации через AI-канал.',
    medical_ai_support: 'Нужно обеспечить бесперебойную работу медицинского AI-компонента и поддержку пользователей.',
    gov_regulatory_analytics: 'Нужно сопровождать аналитическую государственную систему для выявления нарушений и обработки обращений.',
    analytics_monitoring: 'Нужно собирать, обрабатывать и анализировать информацию для управленческих решений.',
  };

  return fallback[productCategory] || cleanText(tender.reason || tender.tender_name || 'Проблема требует уточнения по документам.');
}

function summarizeSolution(tender, productCategory, modules, aiTerms) {
  const name = cleanText(tender.tender_name || '');

  const templates = {
    enterprise_rag_llm_assistant: 'LLM/RAG-помощник с чат-интерфейсом, базами знаний, document QA, суммаризацией, интеграциями с порталами/мессенджерами, closed-contour deployment и ИБ.',
    medical_ai_support: 'Сопровождение и поддержка медицинского AI-компонента: мониторинг, обновления, диагностика, исправление ошибок, обучение пользователей и соблюдение требований защищенного контура.',
    gov_regulatory_analytics: 'Эксплуатация и развитие аналитической ГИС: поддержка пользователей, мониторинг, администрирование, обработка запросов, защита информации и сопровождение ML/RAG/аналитических компонентов.',
    voice_assistant_healthcare: 'Голосовой AI-помощник для медицинских сервисов: распознавание речи, сценарии диалога, запись/отмена записи, вызов врача, интеграция с расписанием и электронной регистратурой.',
    computer_vision: 'Решение/оборудование для обработки изображений или видеоданных с использованием AI/CV-компонентов.',
    analytics_monitoring: 'Сервис сбора, обработки, контент-анализа и сопровождения аналитических модулей с AI/automation элементами.',
    process_automation: 'ПО или услуги для автоматизации процессов, интеграции данных и поддержки цифровых рабочих сценариев.',
  };

  const base = templates[productCategory] || name || 'ПО/услуги по ИИ и автоматизации.';
  const suffix = modules.length || aiTerms.length
    ? ` Ключевые элементы: ${[...modules, ...aiTerms].slice(0, 8).join(', ')}.`
    : '';
  return `${base}${suffix}`;
}

function suggestMvp(productCategory, modules, aiTerms) {
  const suggestions = {
    enterprise_rag_llm_assistant: 'Secure RAG assistant: загрузка документов, векторная база, чат с источниками, summary/comparison/fact extraction, feedback, админка обновления базы и API для портала/мессенджера.',
    medical_ai_support: 'Managed AI support desk for healthcare AI systems: мониторинг, SLA, база знаний ошибок, регламент обновлений, обучение пользователей и compliance-пакет для защищенных медсистем.',
    gov_regulatory_analytics: 'AI operations cockpit for regulatory analytics: мониторинг моделей/правил, обработка обращений, объяснимые отчеты, контроль SLA и база знаний по эксплуатации ГИС.',
    voice_assistant_healthcare: 'Voice appointment assistant: голосовой бот для записи/отмены записи, вызова врача, маршрутизации звонков, интеграции с расписанием и контроля качества диалогов.',
    computer_vision: 'CV pilot kit: прием изображений/видео, модель распознавания, кабинет проверки результатов, отчет качества и API для интеграции.',
    analytics_monitoring: 'AI monitoring workspace: сбор источников, классификация/контент-анализ, дашборд инсайтов, отчеты и workflow проверки.',
    process_automation: 'Process automation assistant: сбор заявок, классификация, маршрутизация, генерация документов и аналитика исполнения.',
  };

  if (modules.includes('document_ai') && !suggestions[productCategory]) {
    return 'Document AI MVP: загрузка документов, извлечение фактов, классификация, поиск противоречий и экспорт структурированных данных.';
  }

  return suggestions[productCategory] || 'Discovery MVP: быстрый пилот на одном процессе с измерением экономического эффекта и повторяемости.';
}

function suggestBuyers(productCategory, tender) {
  const categoryBuyers = {
    enterprise_rag_llm_assistant: ['энергетика', 'инфраструктура', 'телеком', 'банки', 'страхование', 'промышленные холдинги', 'госуслуги'],
    medical_ai_support: ['региональные минздравы', 'медицинские ИТ-операторы', 'клиники с PACS/RIS/LIS', 'разработчики медицинского ПО'],
    gov_regulatory_analytics: ['федеральные ведомства', 'регуляторы', 'контрольно-надзорные органы', 'госоператоры аналитических ГИС'],
    voice_assistant_healthcare: ['региональные минздравы', 'медицинские ИАЦ', 'контакт-центры клиник', 'операторы электронной регистратуры'],
    computer_vision: ['промышленность', 'безопасность', 'медицина', 'транспорт', 'ритейл'],
    analytics_monitoring: ['муниципалитеты', 'PR/GR-службы', 'ситуационные центры', 'аналитические департаменты'],
    process_automation: ['крупные операционные компании', 'госучреждения', 'банки', 'логистика', 'сервисные центры'],
  };

  const buyers = categoryBuyers[productCategory] || ['компании с ИИ/автоматизацией в закупках'];
  if (/москва|област|муницип/i.test(tender.customer || '')) buyers.push('региональные и муниципальные заказчики');
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

function titleFor(productCategory, tender) {
  const titles = {
    enterprise_rag_llm_assistant: 'Защищенный корпоративный RAG/LLM-помощник',
    medical_ai_support: 'Сопровождение медицинских AI-компонентов в защищенном контуре',
    gov_regulatory_analytics: 'Эксплуатация и развитие аналитической ГИС с AI/ML',
    voice_assistant_healthcare: 'Голосовой AI-помощник для медицинской записи',
    computer_vision: 'Computer Vision решение для распознавания и анализа',
    analytics_monitoring: 'AI-сервис мониторинга и контент-анализа',
    process_automation: 'Автоматизация процессов и цифровых рабочих сценариев',
  };

  return titles[productCategory] || cleanText(tender.tender_name || 'AI/software opportunity').slice(0, 120);
}

function findModules(text) {
  const modules = [];
  const checks = [
    ['rag', ['retrieval augmented', 'база знаний', 'векторн', 'эмбеддинг']], // 'rag' checked below with word boundary
    ['llm_pipeline', ['пайплайн', 'промпт', 'большая языковая модель']], // 'llm' checked below
    ['chat_ui', ['чат', 'чат-бот', 'диалог', 'мессенджер']],
    ['document_ai', ['анализ документов', 'суммаризац', 'извлечение фактов', 'классификация документов', 'классификация обращений', 'автоматическая классификац', 'сравнение документов']],
    ['integration', ['интеграц', 'api', 'sdk', 'информационное взаимодействие']],
    ['knowledge_base', ['база знаний', 'документы базы знаний']],
    ['monitoring_support', ['мониторинг', 'техническая поддержка', 'сопровожд', 'эксплуатац']],
    ['information_security', ['информационной безопасности', 'защита информации', 'скзи', 'vipnet']],
    ['on_prem_llm', ['закрытом контуре', 'без обращения в интернет', 'gpu']],
    ['process_automation', ['автоматизация процессов', 'бизнес-процесс', 'workflow']],
    ['computer_vision', ['dicom', 'маммограф', 'снимк', 'видеонаблюд', 'компьютерное зрение']],
  ];

  for (const [name, terms] of checks) {
    if (hasAny(text, terms)) modules.push(name);
  }
  if (hasWord(text, 'rag') && !modules.includes('rag')) modules.push('rag');
  if (hasWord(text, 'llm') && !modules.includes('llm_pipeline')) modules.push('llm_pipeline');

  return modules;
}

function findIntegrations(text) {
  const lines = keywordLines(text, ['интеграц', 'смежн', 'api', 'sdk', 'мессенджер', 'портал', 'шина'], 18)
    .filter(isUsefulAnalysisLine);
  const systems = [];
  const patterns = [
    ['Портал ЭСУ', /портал\s+эсу/i],
    ['корпоративный портал', /корпоративн\w*\s+портал/i],
    ['корпоративный мессенджер', /мессенджер|система объединенных коммуникаций/i],
    ['интеграционная шина', /интеграционн\w*\s+шин/i],
    ['ЕГИСЗ/медицинские подсистемы', /\bегисз\b|\bлис\b|\bцами\b|\bpacs\b|\bris\b/i],
    ['система техподдержки заказчика', /система стп|служб[аы] технической поддержки/i],
    ['портал/внешний сайт', /портал|сайт/i],
  ];

  const haystack = lines.join('\n') || text.slice(0, 20000);
  for (const [name, pattern] of patterns) {
    if (pattern.test(haystack)) systems.push(name);
  }

  return [...new Set(systems)].slice(0, 8);
}

function findConstraints(text) {
  const constraints = [];
  const checks = [
    ['closed_contour', ['закрытом контуре', 'без обращения в интернет', 'ит-инфраструктуре заказчика']],
    ['information_security', ['информационной безопасности', 'защита информации', 'модель угроз', 'скзи', 'vipnet']],
    ['personal_data', ['персональн', 'испдн']],
    ['critical_infrastructure', ['критическ', 'кии', 'значимым объектом']],
    ['domestic_registry', ['реестр российских программ', 'российской промышленной продукции', 'реестровая запись']],
    ['sla_24x7', ['24х7', '24x7', 'круглосуточно', 'семь дней в неделю']],
    ['on_prem_hardware', ['серверного обеспечения', 'gpu', 'a100', 'стойк']],
  ];

  for (const [name, terms] of checks) {
    if (hasAny(text, terms)) constraints.push(name);
  }

  return constraints;
}

function findScenarios(text) {
  const scenarioSection = sectionLines(text, ['Сценарии применения ИТ-решения', 'Сценарий ', 'Требования к проверке'])
    .filter((line) => /сценар|чат|помощник|суммаризац|сравнение|расчет|клиент|пользователь|llm|rag|поддержк/i.test(line));
  const lines = [
    ...scenarioSection,
    ...keywordLines(text, ['сценарий «', 'сценар', 'чат-бот', 'суммаризац', 'сравнение документов', 'расчет стоимости', 'мониторинг работоспособности', 'технической поддержки'], 18),
  ]
    .map(cleanBullet)
    .filter((line) => line.length > 30 && line.length < 320)
    .filter(isUsefulScenarioLine);
  return [...new Set(lines)].slice(0, 8);
}

function findTerms(text, terms) {
  return terms.filter((term) => {
    const t = term.toLowerCase();
    // Short English terms checked with word boundary to avoid substring matches
    if (/^[a-z]{2,4}$/.test(t)) return hasWord(text, t);
    return text.includes(t);
  });
}

function buildEvidence(text) {
  return [
    ...keywordLines(text, ['цель', 'задач', 'сценар', 'интеграц', 'база знаний', 'llm', 'rag', 'требования'], 10),
  ].map(cleanBullet).filter(Boolean).slice(0, 12);
}

function sectionLines(text, headings) {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const result = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (
      headings.some((heading) => lines[index].toLowerCase().includes(heading.toLowerCase()))
      && !/PAGEREF|TOC|\\h/i.test(lines[index])
    ) {
      result.push(...lines.slice(index, index + 10).filter(isUsefulAnalysisLine));
    }
  }

  return result;
}

function keywordLines(text, keywords, limit) {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const result = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (keywords.some((keyword) => lower.includes(keyword.toLowerCase())) && isUsefulAnalysisLine(line)) {
      result.push(line);
      if (result.length >= limit) break;
    }
  }

  return result;
}

function isUsefulAnalysisLine(line) {
  const value = String(line || '').trim();
  if (value.length < 25) return false;
  if (/PAGEREF| TOC |\\h|_Toc|MERGEFORMAT/i.test(value)) return false;
  if (/^\d+(\.\d+)*\.?\s+[А-ЯA-Z].{0,80}\s+\d{1,3}$/.test(value)) return false;
  if (/^(форма|приложение|таблица)\s+\d/i.test(value.toLowerCase())) return false;
  return true;
}

function isUsefulScenarioLine(line) {
  const lower = String(line || '').toLowerCase();
  if (/(заявк|гарант|обеспечени[ея] заяв|конкурсн|оферт|порядок расчет|плательщика|лицевой счет|термин|сокращени|корпоративное наименование|работник заказчика)/i.test(lower)) {
    return false;
  }
  return true;
}

function cleanBullet(value) {
  return cleanText(value)
    .replace(/^[-•\d.\s]+/, '')
    .replace(/PAGEREF\s+\S+\s+\\h\d*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderCard(item) {
  return `# ${item.opportunity_title}

Тендер: \`${item.tender_id}\`
Карточка TenderGuru: \`${item.tenderguru_card_id || '-'}\`
Заказчик: ${item.customer || '-'}
Бюджет: ${item.budget_rub || '-'} руб.
Ниша: \`${item.niche || '-'}\`
Категория продукта: \`${item.product_category}\`

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

## Evidence

${bulletList(item.evidence_snippets)}

## Файлы

${bulletList(item.evidence_files)}
`;
}

function renderShortlist(items) {
  const sorted = [...items].sort((a, b) => scoreRank(b) - scoreRank(a));
  const top = sorted.slice(0, 10);

  return `# MVP Shortlist

Generated from extracted TenderGuru documents for ${runDate}.

## Top Opportunities

${top.map((item, index) => `${index + 1}. **${item.opportunity_title}**  
   Tender: \`${item.tender_id}\`, budget: ${item.budget_rub || '-'} RUB, reuse: ${item.reuse_score}, complexity: ${item.complexity}  
   MVP: ${item.mvp_opportunity}  
   Card: \`${item.product_card}\``).join('\n\n')}

## Category Counts

${Object.entries(countBy(items, 'product_category')).map(([key, value]) => `- ${key}: ${value}`).join('\n')}
`;
}

function scoreRank(item) {
  const reuse = { high: 3, medium: 2, low: 1 }[item.reuse_score] || 0;
  const complexity = { low: 3, medium: 2, high: 1 }[item.complexity] || 0;
  const budget = Number(String(item.budget_rub || '').replace(/[^\d.]/g, '')) || 0;
  return reuse * 10 + complexity * 3 + Math.min(budget / 10000000, 10);
}

function bulletList(items) {
  const values = [...new Set((items || []).filter(Boolean))];
  return values.length ? values.map((item) => `- ${item}`).join('\n') : '- Не найдено в извлеченном тексте.';
}

async function readTenderDocs(paths) {
  const docs = [];

  for (const path of [...paths].sort((a, b) => docPriority(a) - docPriority(b))) {
    try {
      docs.push({ path, text: await readFile(path, 'utf8') });
    } catch {
      // Keep the analyzer tolerant: one broken document should not block the run.
    }
  }

  return docs;
}

function docPriority(path) {
  const name = basename(path).toLowerCase();
  if (/tehnich|техническ|opisanie|описание|tz|тз|zadanie|задани/.test(name)) return 0;
  if (/obekt|объект|predmet|предмет|trebovan|требован/.test(name)) return 1;
  if (/izvesch|извещ|nmc|нмц|obosnov|обоснов/.test(name)) return 3;
  if (/dogovor|договор|kontrakt|контракт|poryadok|порядок|ocenk|оценк|forma|форма/.test(name)) return 5;
  return 2;
}

async function discoverTextPaths(manifestByTender) {
  const result = new Map();

  for (const [tenderId, rows] of manifestByTender.entries()) {
    const paths = rows
      .filter((row) => /^text_(exists|extracted)$/i.test(row.status || ''))
      .map((row) => row.file_path)
      .filter((path) => path && existsSync(path));

    if (paths.length > 0) result.set(tenderId, [...new Set(paths)]);
  }

  if (result.size > 0) return result;

  // Fallback for a missing manifest.
  const { stdout } = await import('node:child_process')
    .then(({ execFile }) => new Promise((resolve, reject) => {
      execFile('find', [docsDir, '-name', '*.txt', '-print'], (error, out, err) => (
        error ? reject(error) : resolve({ stdout: out, stderr: err })
      ));
    }));

  for (const path of stdout.split('\n').filter(Boolean)) {
    const tenderId = basename(dirname(path));
    if (!result.has(tenderId)) result.set(tenderId, []);
    result.get(tenderId).push(path);
  }

  return result;
}

function groupManifest(rows) {
  const map = new Map();

  for (const row of rows) {
    const tenderId = row.tender_id || row.tenderguru_card_id || '';
    if (!tenderId) continue;
    if (!map.has(tenderId)) map.set(tenderId, []);
    map.get(tenderId).push(row);
  }

  return map;
}

function buildTenderLookup(rows) {
  const map = new Map();

  for (const row of rows) {
    for (const id of [row.tender_id, row.tenderguru_card_id, row.tender_num_outer].filter(Boolean)) {
      if (!map.has(id)) map.set(id, row);
    }
  }

  return map;
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    acc[item[key]] = (acc[item[key]] || 0) + 1;
    return acc;
  }, {});
}

function firstMeaningfulLine(text) {
  return text.split(/\n+/).map(cleanText).find((line) => line.length > 20) || '';
}

function hasAny(text, terms) {
  return terms.some((term) => text.includes(term.toLowerCase()));
}

// Word-boundary match for short/ambiguous terms (rag, llm, api, sdk)
function hasWord(text, word) {
  return new RegExp(`(?<![a-zа-я])${word}(?![a-zа-я])`, 'i').test(text);
}

function safeName(value) {
  return String(value || 'unknown').replace(/[^a-zA-Zа-яА-Я0-9_.-]+/g, '_');
}

function parseCsv(content) {
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
  if (!headers) return [];

  return data.map((item) => Object.fromEntries(headers.map((header, index) => [header, item[index] || ''])));
}

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || fallback;
}
