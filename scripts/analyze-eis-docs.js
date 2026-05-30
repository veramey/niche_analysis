#!/usr/bin/env node
/**
 * Downloads TZ documents for EIS tenders and runs the same rule-based
 * analysis as analyze-tender-docs.js. Produces product cards in
 * data/analysis/2026-05-29/product-cards/ and rebuilds dashboard data.
 *
 * Usage:
 *   node scripts/analyze-eis-docs.js
 *   node scripts/analyze-eis-docs.js --only=32616004003
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { loadDotEnv } from '../src/env.js';
import { cleanText, ensureDir, writeCsv, writeJsonl } from '../src/export-utils.js';

loadDotEnv();

const execFileAsync = promisify(execFile);
const DATE     = '2026-05-29';
const ONLY     = getArg('only', '');
const DOCS_JSONL  = `data/processed/${DATE}/zakupki-docs.jsonl`;
const TENDERS_JSON = 'public/data/tenders.json';
const CARDS_OUT   = `data/analysis/${DATE}/product-cards`;
const RAW_DOCS    = `data/raw/zakupki-docs/${DATE}`;
const REQS_CSV    = `data/analysis/${DATE}/tender-requirements.csv`;

ensureDir(CARDS_OUT);
ensureDir(RAW_DOCS);
ensureDir(`data/analysis/${DATE}`);

const AI_TERMS = ['искусственный интеллект','машинное обучение','нейронная сеть','llm','большая языковая модель','rag','эмбеддинг','векторная база','компьютерное зрение','распознавание','классификация','суммаризация'];

// Proxy from .env
const pm = (process.env.ALL_PROXY || '').match(/socks5h?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)/);
const PROXY = pm ? `socks5h://${pm[1]}:${pm[2]}@${pm[3]}:${pm[4]}` : '';

// ── load input data ───────────────────────────────────────────────────────────

const docsRows = readFileSync(DOCS_JSONL, 'utf8').trim().split('\n')
  .filter(Boolean).map(l => JSON.parse(l));

let tenders = JSON.parse(readFileSync(TENDERS_JSON, 'utf8'));
const eisMap = new Map(tenders.filter(t => t.source === 'eis').map(t => [t.tender_num, t]));

const targets = ONLY
  ? docsRows.filter(r => r.tender_num === ONLY)
  : docsRows.filter(r => eisMap.has(r.tender_num));

console.log(`Processing ${targets.length} tenders…\n`);

const analyses = [];

for (let i = 0; i < targets.length; i++) {
  const row = targets[i];
  const tender = eisMap.get(row.tender_num) || {};
  process.stdout.write(`[${i + 1}/${targets.length}] ${row.tender_num} … `);

  // Collect TZ + documentation files with real download URLs
  const realDocs = (row.docs || []).filter(d =>
    d.url && (d.url.includes('filestore') || d.url.includes('download')) &&
    !/etprf|tektorg|roseltorg|lot-online|sberbank-ast|fabrikant|astgoz/i.test(d.url)
  );
  const tzDocs   = realDocs.filter(d => d.is_tz);
  const allDocs  = [...tzDocs, ...realDocs.filter(d => !d.is_tz)].slice(0, 6);

  // Download & extract text
  const texts = [];
  const dir = `${RAW_DOCS}/${row.tender_num}`;
  ensureDir(dir);

  for (const doc of allDocs) {
    const text = await fetchDocText(doc.url, dir, doc.name);
    if (text) texts.push(text);
  }

  const fullText = texts.join('\n\n').slice(0, 400_000);

  // Run analysis
  const analysis = analyzeTender(row.tender_num, tender, fullText, tzDocs, realDocs);
  analyses.push(analysis);

  // Write product card
  const cardPath = `${CARDS_OUT}/${row.tender_num}.md`;
  writeFileSync(cardPath, renderCard(analysis, tzDocs, realDocs.filter(d => !d.is_tz)), 'utf8');

  // Copy card to public
  const pubCardPath = `public/data/cards/${row.tender_num}.md`;
  writeFileSync(pubCardPath, renderCard(analysis, tzDocs, realDocs.filter(d => !d.is_tz)), 'utf8');

  console.log(`ok (${texts.length} docs, ${fullText.length} chars)`);
}

// ── update tenders.json with analysis fields ──────────────────────────────────

const analysisMap = new Map(analyses.map(a => [a.tender_id, a]));
tenders = tenders.map(t => {
  const a = analysisMap.get(t.tender_num);
  if (!a) return t;
  return {
    ...t,
    opportunity_title:  a.opportunity_title,
    problem:            a.problem,
    requested_solution: a.requested_solution,
    mvp_opportunity:    a.mvp_opportunity,
    modules:            a.modules.join('; '),
    ai_terms:           a.ai_terms.join('; '),
    constraints:        a.constraints.join('; '),
    integrations:       a.integrations.join('; '),
    complexity:         a.complexity,
    has_card:           true,
    evidence_files:     tzDocs(a) ? 'docs' : '',
  };
});

writeFileSync(TENDERS_JSON, JSON.stringify(tenders));
writeCsv(REQS_CSV, analyses.map(flatAnalysis));

console.log(`\nCards written: ${analyses.length}`);
console.log(`tenders.json updated`);
console.log(`${REQS_CSV}`);

// ── document fetch ────────────────────────────────────────────────────────────

async function fetchDocText(url, dir, name) {
  const safe = (name || 'doc').replace(/[^a-zA-Zа-яА-Я0-9._-]/g, '_').slice(0, 80);
  const filePath = `${dir}/${safe}`;
  const txtPath  = `${filePath}.txt`;

  if (existsSync(txtPath)) {
    return readFileSync(txtPath, 'utf8');
  }

  try {
    const curlArgs = ['-sL', '--max-time', '30', '-o', filePath, url];
    if (PROXY) curlArgs.splice(0, 0, '--proxy', PROXY);
    await execFileAsync('curl', curlArgs);

    if (!existsSync(filePath)) return null;

    const magic = readFileSync(filePath).slice(0, 4);
    if (magic.toString('hex') === '504b0304') {
      // DOCX (ZIP)
      const { stdout } = await execFileAsync('unzip', ['-p', filePath, 'word/document.xml'], { maxBuffer: 10 * 1024 * 1024 });
      const text = cleanDocxXml(stdout);
      if (text) writeFileSync(txtPath, text, 'utf8');
      return text || null;
    }

    // PDF or unknown — skip text extraction for now
    return null;
  } catch {
    return null;
  }
}

function cleanDocxXml(xml) {
  return cleanText(
    xml
      .replace(/<w:p[ >][^]*?<\/w:p>/g, m => m.replace(/<[^>]+>/g, '') + '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
  );
}

// ── analysis (mirrors analyze-tender-docs.js) ─────────────────────────────────

function analyzeTender(tenderId, tender, text, tzDocs, allDocs) {
  const norm = text.toLowerCase();
  const aiTerms    = findTerms(norm, AI_TERMS);
  const modules    = findModules(norm);
  const integrations = findIntegrations(text);
  const constraints  = findConstraints(norm);
  const scenarios    = findScenarios(text);
  const productCategory = tender.product_category || classifyProduct(tender, norm, modules, aiTerms);
  const problem    = summarizeProblem(tender, text, productCategory);
  const requestedSolution = summarizeSolution(tender, productCategory, modules, aiTerms);
  const mvpOpportunity = suggestMvp(productCategory, modules, aiTerms);
  const targetBuyers   = suggestBuyers(productCategory, tender);
  const reuseScore  = tender.reuse_score || scoreReuse(productCategory, modules, constraints);
  const complexity  = scoreComplexity(modules, constraints, integrations, norm);
  const opportunityTitle = titleFor(productCategory, tender);

  return {
    tender_id: tenderId, tender_name: tender.tender_name || '', customer: tender.customer || '',
    budget_rub: tender.budget_rub || '', niche: tender.niche || '',
    product_category: productCategory, opportunity_title: opportunityTitle,
    problem, requested_solution: requestedSolution, ai_terms: aiTerms, modules,
    scenarios, integrations, constraints, mvp_opportunity: mvpOpportunity,
    target_buyers: targetBuyers, reuse_score: reuseScore, complexity,
    evidence_files: tzDocs.map(d => d.url),
    evidence_snippets: buildEvidence(text),
  };
}

function classifyProduct(tender, text, modules, aiTerms) {
  const name = `${tender.tender_name || ''} ${tender.niche || ''}`.toLowerCase();
  const combined = `${name}\n${text}`;
  if (hasAny(name, ['голосовой помощник','речевого взаимодействия'])) return 'voice_assistant_healthcare';
  if (hasAny(combined, ['антикартель','dbscan'])) return 'gov_regulatory_analytics';
  if (hasAny(name, ['фотовидеофиксаци','видеофиксаци','распознавани','dicom','маммограф'])) return 'computer_vision';
  if (hasAny(combined, ['маммограф','dicom','пациент']) || (hasAny(combined, ['медицинск','здравоохран']) && hasAny(combined, ['искусственн','нейросет','диагностик','поддержки принятия']))) return 'medical_ai_support';
  if (hasWord(combined, 'llm') || hasWord(combined, 'rag') || hasAny(combined, ['большая языковая модель','база знаний','чат-бот'])) return 'enterprise_rag_llm_assistant';
  if (hasAny(combined, ['компьютерное зрение','обработка изображени','анализ изображени','распознавани'])) return 'computer_vision';
  if (hasAny(combined, ['контент-анализ','аналитическ']) || (combined.includes('мониторинг') && !combined.includes('мониторинг цен'))) return 'analytics_monitoring';
  if (modules.includes('process_automation') || hasAny(combined, ['автоматизация процессов','бизнес-процесс'])) return 'process_automation';
  if (aiTerms.length > 0) return 'software_services';
  return 'software_services';
}

function summarizeProblem(tender, text, cat) {
  const snippets = [
    ...keywordLines(text, ['проект направлен','целями выполнения','целью выполнения','для достижения','повышение','сокращение','автоматизация'], 8),
    ...sectionLines(text, ['ЦЕЛИ И ЗАДАЧИ','Цели и задачи','Цель оказания услуг']),
  ].filter(isUsefulLine);
  const compact = snippets.map(cleanBullet).filter(Boolean).slice(0, 4).join(' ');
  if (compact) return compact;
  const fallback = { enterprise_rag_llm_assistant:'Нужен управляемый доступ к знаниям и документам через AI-канал.', medical_ai_support:'Нужна бесперебойная работа медицинского AI-компонента и поддержка пользователей.', gov_regulatory_analytics:'Нужно сопровождать аналитическую ГИС для выявления нарушений.', analytics_monitoring:'Нужно собирать и анализировать информацию для управленческих решений.' };
  return fallback[cat] || cleanText(tender.tender_name || 'Проблема требует уточнения по документам.');
}

function summarizeSolution(tender, cat, modules, aiTerms) {
  const templates = { enterprise_rag_llm_assistant:'LLM/RAG-помощник с чат-интерфейсом, базами знаний, document QA, суммаризацией, интеграциями и ИБ.', medical_ai_support:'Сопровождение медицинского AI: мониторинг, обновления, диагностика, обучение пользователей и compliance.', gov_regulatory_analytics:'Эксплуатация аналитической ГИС: поддержка пользователей, мониторинг, ML/RAG-компоненты, защита информации.', voice_assistant_healthcare:'Голосовой AI-помощник: распознавание речи, сценарии диалога, интеграция с расписанием.', computer_vision:'CV-решение для обработки изображений/видео с AI-компонентами.', analytics_monitoring:'Сервис сбора, контент-анализа и аналитических модулей с AI/automation.', process_automation:'ПО для автоматизации процессов, интеграции данных и цифровых сценариев.' };
  const base = templates[cat] || cleanText(tender.tender_name || 'ПО/услуги по ИИ и автоматизации.');
  const suffix = [...modules, ...aiTerms].length ? ` Ключевые элементы: ${[...modules, ...aiTerms].slice(0, 7).join(', ')}.` : '';
  return `${base}${suffix}`;
}

function suggestMvp(cat, modules, aiTerms) {
  const mvps = { enterprise_rag_llm_assistant:'Secure RAG: загрузка документов, векторная база, чат с источниками, API для портала.', medical_ai_support:'AI support desk: мониторинг, SLA, база знаний ошибок, обучение пользователей и compliance-пакет.', gov_regulatory_analytics:'AI ops cockpit: мониторинг моделей, обработка обращений, объяснимые отчёты, контроль SLA.', voice_assistant_healthcare:'Voice bot: запись к врачу, маршрутизация звонков, интеграция с расписанием.', computer_vision:'CV pilot: приём изображений, модель, кабинет проверки, отчёт качества, API.', analytics_monitoring:'AI monitoring workspace: сбор источников, классификация, дашборд инсайтов, отчёты.', process_automation:'Process automation: сбор заявок, классификация, маршрутизация, генерация документов.' };
  return mvps[cat] || 'Discovery MVP: быстрый пилот на одном процессе с измерением экономического эффекта.';
}

function suggestBuyers(cat, tender) {
  const buyers = { enterprise_rag_llm_assistant:['энергетика','телеком','банки','страхование','промышленные холдинги','госуслуги'], medical_ai_support:['региональные минздравы','медицинские ИТ-операторы','клиники с PACS/RIS/LIS'], gov_regulatory_analytics:['федеральные ведомства','регуляторы','контрольно-надзорные органы'], computer_vision:['промышленность','безопасность','медицина','транспорт'], analytics_monitoring:['муниципалитеты','ситуационные центры','аналитические департаменты'], process_automation:['госучреждения','банки','логистика','сервисные центры'] };
  const list = buyers[cat] || ['компании с ИИ/автоматизацией в закупках'];
  if (/москва|областн|муницип/i.test(tender.customer || '')) list.push('региональные заказчики');
  return [...new Set(list)];
}

function scoreReuse(cat, modules, constraints) {
  let s = 0;
  if (['enterprise_rag_llm_assistant','analytics_monitoring','process_automation','voice_assistant_healthcare'].includes(cat)) s += 2;
  if (modules.includes('rag') || modules.includes('document_ai') || modules.includes('chat_ui')) s += 1;
  if (constraints.includes('closed_contour') || constraints.includes('information_security')) s -= 0.5;
  if (cat === 'medical_ai_support') s -= 0.5;
  return s >= 2.5 ? 'high' : s >= 1 ? 'medium' : 'low';
}

function scoreComplexity(modules, constraints, integrations, text) {
  let s = 0;
  s += integrations.length >= 3 ? 2 : integrations.length > 0 ? 1 : 0;
  s += constraints.includes('closed_contour') ? 1 : 0;
  s += constraints.includes('information_security') ? 1 : 0;
  s += /критическ|исспдн|скзи|vipnet/i.test(text) ? 1 : 0;
  s += modules.includes('on_prem_llm') ? 1 : 0;
  return s >= 4 ? 'high' : s >= 2 ? 'medium' : 'low';
}

function titleFor(cat, tender) {
  const titles = { enterprise_rag_llm_assistant:'Защищенный корпоративный RAG/LLM-помощник', medical_ai_support:'Сопровождение медицинских AI-компонентов', gov_regulatory_analytics:'Эксплуатация и развитие аналитической ГИС с AI/ML', voice_assistant_healthcare:'Голосовой AI-помощник для медицинской записи', computer_vision:'Computer Vision: распознавание и анализ изображений', analytics_monitoring:'AI-сервис мониторинга и контент-анализа', process_automation:'Автоматизация процессов и цифровых рабочих сценариев' };
  return titles[cat] || cleanText(tender.tender_name || 'AI/software opportunity').slice(0, 120);
}

function findModules(text) {
  const checks = [['rag',['retrieval augmented','база знаний','векторн','эмбеддинг']],['llm_pipeline',['пайплайн','промпт','большая языковая модель']],['chat_ui',['чат','чат-бот','диалог','мессенджер']],['document_ai',['анализ документов','суммаризац','извлечение фактов','классификация документов','классификация обращений']],['integration',['интеграц','api','sdk','информационное взаимодействие']],['monitoring_support',['мониторинг','техническая поддержка','сопровожд','эксплуатац']],['information_security',['информационной безопасности','защита информации','скзи','vipnet']],['on_prem_llm',['закрытом контуре','без обращения в интернет','gpu']],['process_automation',['автоматизация процессов','бизнес-процесс','workflow']],['computer_vision',['dicom','маммограф','снимк','видеонаблюд','компьютерное зрение']]];
  const modules = [];
  for (const [name, terms] of checks) if (hasAny(text, terms)) modules.push(name);
  if (hasWord(text, 'rag') && !modules.includes('rag')) modules.push('rag');
  if (hasWord(text, 'llm') && !modules.includes('llm_pipeline')) modules.push('llm_pipeline');
  return modules;
}

function findIntegrations(text) {
  const patterns = [['Портал ЭСУ',/портал\s+эсу/i],['корпоративный портал',/корпоративн\w*\s+портал/i],['корпоративный мессенджер',/мессенджер|система объединенных коммуникаций/i],['интеграционная шина',/интеграционн\w*\s+шин/i],['ЕГИСЗ/медицинские подсистемы',/\bегисз\b|\bлис\b|\bцами\b|\bpacs\b|\bris\b/i],['портал/внешний сайт',/портал|сайт/i]];
  const hay = keywordLines(text, ['интеграц','смежн','api','sdk','мессенджер','портал','шина'], 18).join('\n') || text.slice(0,20000);
  return [...new Set(patterns.filter(([,re]) => re.test(hay)).map(([n]) => n))].slice(0,8);
}

function findConstraints(text) {
  const checks = [['closed_contour',['закрытом контуре','без обращения в интернет','ит-инфраструктуре заказчика']],['information_security',['информационной безопасности','защита информации','модель угроз','скзи','vipnet']],['personal_data',['персональн','испдн']],['critical_infrastructure',['критическ','кии']],['domestic_registry',['реестр российских программ','реестровая запись']],['sla_24x7',['24х7','24x7','круглосуточно']],['on_prem_hardware',['серверного обеспечения','gpu','a100']]];
  return checks.filter(([,terms]) => hasAny(text, terms)).map(([name]) => name);
}

function findScenarios(text) {
  const lines = [...sectionLines(text,['Сценарии применения','Сценарий ','Требования к проверке']), ...keywordLines(text,['сценарий «','сценар','чат-бот','суммаризац','сравнение документов'],18)].map(cleanBullet).filter(l => l.length > 30 && l.length < 320).filter(isUsefulLine);
  return [...new Set(lines)].slice(0,8);
}

function findTerms(text, terms) {
  return terms.filter(t => /^[a-z]{2,4}$/.test(t) ? hasWord(text, t) : text.includes(t));
}

function buildEvidence(text) {
  return keywordLines(text,['цель','задач','сценар','интеграц','база знаний','llm','rag','требования'],10).map(cleanBullet).filter(Boolean).slice(0,12);
}

function sectionLines(text, headings) {
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    if (headings.some(h => lines[i].toLowerCase().includes(h.toLowerCase())) && !/PAGEREF|TOC/i.test(lines[i])) {
      result.push(...lines.slice(i, i+10).filter(isUsefulLine));
    }
  }
  return result;
}

function keywordLines(text, keywords, limit) {
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const result = [];
  for (const line of lines) {
    if (keywords.some(k => line.toLowerCase().includes(k.toLowerCase())) && isUsefulLine(line)) {
      result.push(line);
      if (result.length >= limit) break;
    }
  }
  return result;
}

function isUsefulLine(line) {
  const v = String(line||'').trim();
  return v.length >= 25 && !/PAGEREF| TOC |\\h|_Toc/i.test(v) && !/^\d+(\.\d+)*\.?\s+[А-ЯA-Z].{0,80}\s+\d{1,3}$/.test(v);
}

function cleanBullet(v) { return cleanText(v).replace(/^[-•\d.\s]+/,'').replace(/\s+/g,' ').trim(); }
function hasAny(text, terms) { return terms.some(t => text.includes(t)); }
function hasWord(text, word) { return new RegExp(`\\b${word}\\b`,'i').test(text); }
function bulletList(items) { return items.length ? items.map(i => `- ${i}`).join('\n') : '—'; }
function tzDocs(a) { return (a.evidence_files || []).length > 0; }

// ── card renderer ─────────────────────────────────────────────────────────────

function renderCard(item, tzDocs, otherDocs) {
  const lines = [];
  lines.push(`# ${item.opportunity_title}`);
  lines.push('');
  lines.push(`Тендер: \`${item.tender_id}\``);
  lines.push(`Заказчик: ${item.customer || '—'}`);
  lines.push(`Бюджет: ${item.budget_rub ? fmtBudget(Number(item.budget_rub)) : '—'}`);
  lines.push(`Ниша: \`${item.niche || '—'}\``);
  lines.push(`Категория продукта: \`${item.product_category}\``);
  lines.push('');

  lines.push('## Предмет');
  lines.push('');
  lines.push(item.tender_name || '—');
  lines.push('');

  lines.push('## Бизнес-Боль');
  lines.push('');
  lines.push(item.problem || '—');
  lines.push('');

  lines.push('## Что Хотят Купить');
  lines.push('');
  lines.push(item.requested_solution || '—');
  lines.push('');

  if (item.modules?.length || item.ai_terms?.length) {
    lines.push('## Модули И Технологии');
    lines.push('');
    lines.push(bulletList([...(item.modules||[]), ...(item.ai_terms||[])]));
    lines.push('');
  }

  if (item.scenarios?.length) {
    lines.push('## Сценарии');
    lines.push('');
    lines.push(bulletList(item.scenarios));
    lines.push('');
  }

  if (item.integrations?.length) {
    lines.push('## Интеграции');
    lines.push('');
    lines.push(bulletList(item.integrations));
    lines.push('');
  }

  if (item.constraints?.length) {
    lines.push('## Ограничения');
    lines.push('');
    lines.push(bulletList(item.constraints));
    lines.push('');
  }

  lines.push('## MVP-Возможность');
  lines.push('');
  lines.push(item.mvp_opportunity || '—');
  lines.push('');

  if (item.target_buyers?.length) {
    lines.push('## Кому Еще Продавать');
    lines.push('');
    lines.push(bulletList(item.target_buyers));
    lines.push('');
  }

  lines.push('## Оценка');
  lines.push('');
  lines.push(`- Повторяемость: ${item.reuse_score}`);
  lines.push(`- Сложность: ${item.complexity}`);
  lines.push('');

  if (item.evidence_snippets?.length) {
    lines.push('## Evidence');
    lines.push('');
    lines.push(bulletList(item.evidence_snippets));
    lines.push('');
  }

  if (tzDocs.length) {
    lines.push('## Техническое задание');
    lines.push('');
    tzDocs.forEach(d => lines.push(`- [${d.name}](${d.url})`));
    lines.push('');
  }

  if (otherDocs.length) {
    lines.push('## Документация');
    lines.push('');
    otherDocs.slice(0, 15).forEach(d => lines.push(`- [${d.name}](${d.url})`));
    if (otherDocs.length > 15) lines.push(`- *(ещё ${otherDocs.length - 15} документов)*`);
    lines.push('');
  }

  return lines.join('\n');
}

function flatAnalysis(a) {
  return { tender_id: a.tender_id, tender_name: a.tender_name, customer: a.customer, budget_rub: a.budget_rub, niche: a.niche, product_category: a.product_category, opportunity_title: a.opportunity_title, problem: a.problem.slice(0,300), requested_solution: a.requested_solution.slice(0,300), modules: a.modules.join('; '), ai_terms: a.ai_terms.join('; '), mvp_opportunity: a.mvp_opportunity, reuse_score: a.reuse_score, complexity: a.complexity };
}

function fmtBudget(n) {
  if (!n) return '—';
  if (n >= 1e9) return (n/1e9).toFixed(2)+' млрд ₽';
  if (n >= 1e6) return (n/1e6).toFixed(2)+' млн ₽';
  if (n >= 1e3) return Math.round(n/1e3)+' тыс. ₽';
  return n+' ₽';
}

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find(a => a.startsWith(prefix))?.slice(prefix.length) || fallback;
}
