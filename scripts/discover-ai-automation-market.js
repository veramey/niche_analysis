#!/usr/bin/env node
import { loadDotEnv } from '../src/env.js';
import { TenderGuruClient } from '../src/tenderguru-client.js';
import {
  appendJsonl,
  cleanText,
  dateValue,
  ensureDir,
  normalizeDocs,
  parseApiTenderInfo,
  redactSecrets,
  writeCsv,
  writeJsonl,
  writeText,
} from '../src/export-utils.js';

loadDotEnv();

const runDate = getArg('date', '2026-05-25');
const limit = Number(getArg('limit', '50'));
const pages = Number(getArg('pages', '1'));
const categoryFilter = { c12: 1 };

const paths = {
  rawDir: `data/raw/tenderguru/${runDate}`,
  processedDir: `data/processed/${runDate}`,
  analysisDir: `data/analysis/${runDate}`,
};

ensureDir(paths.rawDir);
ensureDir(paths.processedDir);
ensureDir(paths.analysisDir);

const rawSearchPath = `${paths.rawDir}/search-results.jsonl`;
const rawDocsPath = `${paths.rawDir}/documentation-results.jsonl`;
const rawCardsPath = `${paths.rawDir}/tender-cards.jsonl`;
const candidatesJsonlPath = `${paths.processedDir}/candidates.jsonl`;
const candidatesCsvPath = `${paths.processedDir}/candidates.csv`;
const classifiedJsonlPath = `${paths.processedDir}/classified-tenders.jsonl`;
const classifiedCsvPath = `${paths.processedDir}/classified-tenders.csv`;
const summaryCsvPath = `${paths.analysisDir}/niches-summary.csv`;
const summaryMdPath = `${paths.analysisDir}/niches-summary.md`;
const opportunitiesMdPath = `${paths.analysisDir}/mvp-opportunities.md`;

writeJsonl(rawSearchPath, []);
writeJsonl(rawDocsPath, []);
writeJsonl(rawCardsPath, []);

const client = new TenderGuruClient();
const candidates = new Map();

const queries = [
  { query: '"искусственный интеллект"', group: 'ai_general' },
  { query: '"технологии искусственного интеллекта"', group: 'ai_general' },
  { query: '"машинное обучение"', group: 'ml' },
  { query: '"нейронная сеть"', group: 'ml' },
  { query: 'нейросеть', group: 'ml' },
  { query: '"компьютерное зрение"', group: 'computer_vision' },
  { query: '"распознавание документов"', group: 'document_ai' },
  { query: '"распознавание изображений"', group: 'computer_vision' },
  { query: '"интеллектуальный анализ данных"', group: 'analytics' },
  { query: '"предиктивная аналитика"', group: 'analytics' },
  { query: '"автоматизация бизнес-процессов"', group: 'process_automation' },
  { query: '"автоматизация процессов"', group: 'process_automation' },
  { query: '"роботизация бизнес-процессов"', group: 'process_automation' },
  { query: 'RPA', group: 'process_automation' },
  { query: 'BPM', group: 'process_automation' },
  { query: 'BPMS', group: 'process_automation' },
  { query: 'workflow', group: 'process_automation' },
  { query: '"разработка информационной системы"', group: 'custom_software' },
  { query: '"доработка информационной системы"', group: 'custom_software' },
  { query: '"внедрение программного обеспечения"', group: 'custom_software' },
  { query: '"интеллектуальный помощник"', group: 'llm_assistant' },
  { query: '"большой языковой модели"', group: 'llm_assistant' },
  { query: 'AIoT', group: 'aiot' },
];

for (const { query, group } of queries) {
  for (let page = 1; page <= pages; page += 1) {
    await collectSearchResults(query, group, page);
    await collectDocumentationResults(query, group, page);
  }
}

const scoredCandidates = [...candidates.values()]
  .map(scoreCandidate)
  .filter(isRelevantCandidate)
  .sort((a, b) => dateValue(b.date) - dateValue(a.date) || b.score - a.score);

const selectedCandidates = scoredCandidates.slice(0, limit);
writeJsonl(candidatesJsonlPath, selectedCandidates.map(rowCandidate));
writeCsv(candidatesCsvPath, selectedCandidates.map(rowCandidate));

const enrichedRows = [];

for (const candidate of selectedCandidates) {
  const row = await enrichCandidate(candidate);
  enrichedRows.push(row);
}

writeJsonl(classifiedJsonlPath, enrichedRows);
writeCsv(classifiedCsvPath, enrichedRows);

const summary = buildNicheSummary(enrichedRows);
writeCsv(summaryCsvPath, summary);
writeText(summaryMdPath, renderSummaryMarkdown(summary));
writeText(opportunitiesMdPath, renderOpportunitiesMarkdown(summary, enrichedRows));

console.log(`Collected ${candidates.size} unique candidates`);
console.log(`Selected ${selectedCandidates.length} candidates`);
console.log(`Wrote ${classifiedCsvPath}`);
console.log(`Wrote ${summaryCsvPath}`);

async function collectSearchResults(query, group, page) {
  try {
    const response = await client.searchTenders({
      kwords: query,
      sort_by: 'by_date',
      sort_dest: 'desc',
      page,
      tenpage: 10,
      ...categoryFilter,
    });

    appendJsonl(rawSearchPath, {
      source: 'search',
      query,
      group,
      page,
      response,
    });

    for (const item of responseItems(response)) {
      upsertCandidate(item, query, group, 'search');
    }
  } catch (error) {
    console.warn(`Skipped search query "${query}": ${cleanText(redactSecrets(error.message))}`);
  }
}

async function collectDocumentationResults(query, group, page) {
  try {
    const response = await client.request('/documentation', {
      kwords: query,
      page,
      ...categoryFilter,
    }, {
      timeoutMs: 15000,
    });

    appendJsonl(rawDocsPath, {
      source: 'documentation',
      query,
      group,
      page,
      response,
    });

    for (const item of responseItems(response)) {
      upsertCandidate(item, query, group, 'documentation');
    }
  } catch (error) {
    console.warn(`Skipped documentation query "${query}": ${cleanText(redactSecrets(error.message))}`);
  }
}

function responseItems(response) {
  return (Array.isArray(response) ? response : [])
    .filter((item) => item && item.ID && !item.Total);
}

function upsertCandidate(item, query, group, source) {
  const apiInfo = parseApiTenderInfo(item.ApiTenderInfo);
  const lookupTendNum = item.TenderNumOuter || apiInfo.tend_num || '';
  const lookupId = source === 'documentation' ? apiInfo.id || '' : item.ID || apiInfo.id || '';
  const id = lookupTendNum || lookupId || item.ID || item.TenderLinkInner || item.TenderName;
  const current = candidates.get(id) || {
    id,
    lookupId,
    lookupTendNum,
    rawDocumentationId: '',
    queries: new Set(),
    groups: new Set(),
    sources: new Set(),
    docLinks: new Set(),
  };

  Object.assign(current, {
    lookupId: current.lookupId || lookupId,
    lookupTendNum: current.lookupTendNum || lookupTendNum,
    rawDocumentationId: source === 'documentation' ? item.ID || current.rawDocumentationId || '' : current.rawDocumentationId || '',
    date: item.Date || current.date || '',
    name: cleanText(item.TenderName || current.name),
    customer: cleanText(item.Customer || current.customer),
    category: cleanText(item.Category || current.category),
    region: cleanText(item.Region || current.region),
    price: item.Price || current.price || '',
    endTime: item.EndTime || current.endTime || '',
    etp: cleanText(item.Etp || current.etp),
    tenderLink: item.TenderLink || current.tenderLink || '',
    tenderguruLink: item.TenderLinkInner || current.tenderguruLink || '',
    tenderNumOuter: item.TenderNumOuter || current.tenderNumOuter || '',
    fz: item.Fz || current.fz || '',
    apiTenderInfo: redactSecrets(item.ApiTenderInfo || current.apiTenderInfo || ''),
    searchFragment: cleanText(JSON.stringify(item.searchFragmentXML || '')),
  });

  current.queries.add(query);
  current.groups.add(group);
  current.sources.add(source);
  if (item.DocLink1) current.docLinks.add(item.DocLink1);
  if (item.DocLink2) current.docLinks.add(item.DocLink2);

  candidates.set(id, current);
}

function scoreCandidate(candidate) {
  const haystack = [
    candidate.name,
    candidate.category,
    candidate.searchFragment,
    [...candidate.queries].join(' '),
    [...candidate.groups].join(' '),
  ].join(' ').toLowerCase();

  const matchedTerms = [];
  let score = 0;

  const positive = [
    [10, 'искусственный интеллект'],
    [10, 'технологии искусственного интеллекта'],
    [9, 'машинное обучение'],
    [9, 'нейронная сеть'],
    [9, 'нейросеть'],
    [9, 'aiot'],
    [9, 'большой языковой модели'],
    [9, 'интеллектуальный помощник'],
    [9, 'компьютерное зрение'],
    [8, 'распознавание документов'],
    [8, 'распознавание изображений'],
    [8, 'предиктивная аналитика'],
    [7, 'интеллектуальный анализ данных'],
    [7, 'rpa'],
    [7, 'роботизация бизнес-процессов'],
    [6, 'автоматизация бизнес-процессов'],
    [5, 'автоматизация процессов'],
    [5, 'bpm'],
    [5, 'bpms'],
    [4, 'workflow'],
    [4, 'разработка информационной системы'],
    [4, 'доработка информационной системы'],
    [3, 'внедрение программного обеспечения'],
  ];

  const negative = [
    [12, 'консультант плюс'],
    [12, 'консультантплюс'],
    [10, 'рпа минюста'],
    [10, 'университет юстиции'],
    [8, 'пропускного режима'],
    [8, 'осуществлению круглосуточной охраны'],
    [8, 'бытовой техники'],
    [8, 'кухонная машина'],
    [8, 'картофелечистка'],
    [8, 'такелажных услуг'],
    [8, 'лекарственных средств'],
    [4, 'kaspersky'],
    [4, 'контур.экстерн'],
    [4, 'контур.диадок'],
    [3, 'антивирус'],
    [3, 'лицензионных прав'],
  ];

  for (const [points, term] of positive) {
    if (haystack.includes(term)) {
      score += points;
      matchedTerms.push(term);
    }
  }

  for (const [points, term] of negative) {
    if (haystack.includes(term)) {
      score -= points;
      matchedTerms.push(`-${term}`);
    }
  }

  if (candidate.sources.has('documentation')) score += 2;

  const niche = classifyNiche(candidate, matchedTerms);

  return {
    ...candidate,
    score,
    niche,
    classification: nicheToClassification(niche),
    matchedTerms,
  };
}

async function enrichCandidate(candidate) {
  let card = {};

  try {
    let response;
    if (candidate.lookupTendNum) {
      response = await client.getTenderByNumber(candidate.lookupTendNum);
    } else {
      response = await client.getTenderById(candidate.lookupId || candidate.id);
    }
    card = Array.isArray(response) ? response.find((item) => item && !item.Total) || {} : response || {};
    appendJsonl(rawCardsPath, {
      candidate_id: candidate.id,
      lookup_id: candidate.lookupId,
      lookup_tend_num: candidate.lookupTendNum,
      response,
    });
  } catch (error) {
    card = { enrichment_error: cleanText(redactSecrets(error.message)) };
  }

  const docs = normalizeDocs(card.docsXML);

  const rawDocSource = card.docsXML?.document ?? card.docsXML?.Doc ?? docs;
  const rawDocEntries = Array.isArray(rawDocSource) ? rawDocSource : (rawDocSource ? [rawDocSource] : []);
  for (const doc of rawDocEntries) {
    if (doc.link) {
      candidate.docLinks.add(
        `https://www.tenderguru.ru/docviewer/${Buffer.from(doc.link).toString('base64url')}`,
      );
    }
  }

  const infoText = cleanText(card.Info || '');

  return {
    tender_id: candidate.id,
    tenderguru_card_id: card.ID || candidate.lookupId,
    documentation_result_id: candidate.rawDocumentationId || '',
    date: candidate.date,
    niche: candidate.niche,
    classification: candidate.classification,
    relevance_score: candidate.score,
    matched_terms: candidate.matchedTerms.join('; '),
    matched_queries: [...candidate.queries].join('; '),
    query_groups: [...candidate.groups].join('; '),
    sources: [...candidate.sources].join('; '),
    reason: buildReason(candidate, infoText),
    tender_name: cleanText(card.TenderName || candidate.name),
    customer: cleanText(card.Customer || candidate.customer),
    customer_inn: card.CustomerINN || '',
    category: cleanText(card.Category || candidate.category),
    region: cleanText(card.Region || candidate.region),
    price: card.Price || candidate.price,
    end_time: card.EndTime || candidate.endTime,
    fz: card.Fz || candidate.fz,
    etp: cleanText(card.Etp || candidate.etp),
    tender_num_outer: card.TenderNumOuter || candidate.tenderNumOuter,
    tender_link: card.TenderLink || candidate.tenderLink,
    tenderguru_link: card.TenderLinkInner || candidate.tenderguruLink,
    doc_links_from_documentation_search: [...candidate.docLinks].map(redactSecrets).join(' | '),
    docs_count_in_card: docs.length,
    docs_status: docs.length > 0 ? 'docsXML available' : 'docsXML empty in tender card',
    docs_ai_api_url: `https://www.tenderguru.ru/api2.3/export?dtype=json&mode=ai&act=webhook&t=${encodeURIComponent(card.ID || candidate.lookupId || candidate.id)}&ff=a&drl=1`,
  };
}

function rowCandidate(candidate) {
  return {
    tender_id: candidate.id,
    lookup_id: candidate.lookupId,
    lookup_tend_num: candidate.lookupTendNum,
    date: candidate.date,
    niche: candidate.niche,
    classification: candidate.classification,
    relevance_score: candidate.score,
    matched_terms: candidate.matchedTerms.join('; '),
    matched_queries: [...candidate.queries].join('; '),
    query_groups: [...candidate.groups].join('; '),
    sources: [...candidate.sources].join('; '),
    tender_name: candidate.name,
    customer: candidate.customer,
    category: candidate.category,
    region: candidate.region,
    price: candidate.price,
    end_time: candidate.endTime,
    tender_link: candidate.tenderLink,
    tenderguru_link: candidate.tenderguruLink,
    doc_links_from_documentation_search: [...candidate.docLinks].map(redactSecrets).join(' | '),
  };
}

function classifyNiche(candidate, terms) {
  const text = [
    candidate.name,
    candidate.searchFragment,
    terms.join(' '),
    [...candidate.groups].join(' '),
  ].join(' ').toLowerCase();

  if (/(интеллектуальный помощник|большой языковой модели|\bllm\b|\brag\b|чат-бот|\bбот\b)/i.test(text)) return 'llm_assistant';
  if (/(aiot)/i.test(text)) return 'aiot';
  if (/(компьютерное зрение|распознавание изображений|видео|телевизионного наблюдения|камер|номеров)/i.test(text)) return 'computer_vision';
  if (/(распознавание документов|документооборот|извлечение данных|архив)/i.test(text)) return 'document_ai';
  if (/(предиктивная аналитика|интеллектуальный анализ данных|контент-анализ|мониторинг|аналитической системы)/i.test(text)) return 'analytics';
  if (/(rpa|bpm|bpms|workflow|автоматизация бизнес-процессов|роботизация бизнес-процессов|автоматизация процессов)/i.test(text)) return 'process_automation';
  if (/(разработка информационной системы|доработка информационной системы|внедрение программного обеспечения|интеграционная платформа|автоматизированных информационных систем)/i.test(text)) return 'custom_software';
  if (/(машинное обучение|нейронная сеть|нейросеть|искусственный интеллект|aiot)/i.test(text)) return 'ai_general';
  return 'software_related';
}

function nicheToClassification(niche) {
  if (['llm_assistant', 'computer_vision', 'document_ai', 'analytics', 'ai_general', 'aiot'].includes(niche)) return 'ai_core';
  if (['process_automation', 'custom_software'].includes(niche)) return 'automation_software';
  return 'software_related';
}

function isRelevantCandidate(candidate) {
  if (dateValue(candidate.date) > Date.UTC(2026, 4, 25)) return false;

  const onlyDocumentation = candidate.sources.size === 1 && candidate.sources.has('documentation');
  if (onlyDocumentation) return candidate.score >= 14;

  return candidate.score >= 6;
}

function buildReason(candidate, infoText) {
  const terms = candidate.matchedTerms.filter((term) => !term.startsWith('-')).slice(0, 4).join(', ');
  const source = candidate.sources.has('documentation') ? 'найдено также в документации' : 'найдено в карточке/названии';
  const context = infoText ? `; карточка содержит ${Math.min(infoText.length, 500)} символов описания` : '';
  return `${source}; совпадения: ${terms || 'нет'}${context}`;
}

function buildNicheSummary(rows) {
  const byNiche = new Map();

  for (const row of rows) {
    const current = byNiche.get(row.niche) || {
      niche: row.niche,
      tenders_count: 0,
      total_budget: 0,
      priced_count: 0,
      median_budget: 0,
      avg_budget: 0,
      top_regions: new Map(),
      top_customers: new Map(),
      examples: [],
    };

    current.tenders_count += 1;

    const price = Number(String(row.price || '').replace(/[^\d.]/g, ''));
    if (price > 0) {
      current.total_budget += price;
      current.priced_count += 1;
      current.prices = [...(current.prices || []), price];
    }

    increment(current.top_regions, row.region || 'unknown');
    increment(current.top_customers, row.customer || 'unknown');
    if (current.examples.length < 3) current.examples.push(row.tender_name);

    byNiche.set(row.niche, current);
  }

  return [...byNiche.values()]
    .map((item) => ({
      niche: item.niche,
      tenders_count: item.tenders_count,
      priced_count: item.priced_count,
      total_budget: Math.round(item.total_budget),
      avg_budget: item.priced_count ? Math.round(item.total_budget / item.priced_count) : '',
      median_budget: median(item.prices || []),
      top_regions: topEntries(item.top_regions).join('; '),
      top_customers: topEntries(item.top_customers).join('; '),
      examples: item.examples.join(' | '),
    }))
    .sort((a, b) => b.tenders_count - a.tenders_count || Number(b.total_budget) - Number(a.total_budget));
}

function renderSummaryMarkdown(summary) {
  const lines = [
    '# Niches Summary',
    '',
    `Run date: ${runDate}`,
    `Category filter: c12=1 (Системная интеграция, оргтехника / компьютеры и ПО)`,
    '',
    '| Niche | Count | Priced | Total Budget | Avg Budget | Median Budget | Top Regions |',
    '|---|---:|---:|---:|---:|---:|---|',
  ];

  for (const row of summary) {
    lines.push(`| ${row.niche} | ${row.tenders_count} | ${row.priced_count} | ${row.total_budget} | ${row.avg_budget} | ${row.median_budget} | ${row.top_regions} |`);
  }

  return `${lines.join('\n')}\n`;
}

function renderOpportunitiesMarkdown(summary, rows) {
  const lines = [
    '# MVP Opportunities',
    '',
    'Early notes from TenderGuru tender discovery. Treat as hypotheses until reviewed against tender docs.',
    '',
  ];

  for (const niche of summary.slice(0, 8)) {
    const examples = rows.filter((row) => row.niche === niche.niche).slice(0, 3);
    lines.push(`## ${niche.niche}`);
    lines.push('');
    lines.push(`- Tenders: ${niche.tenders_count}`);
    lines.push(`- Total priced budget: ${niche.total_budget}`);
    lines.push(`- Median budget: ${niche.median_budget || 'n/a'}`);
    lines.push(`- MVP hypothesis: ${mvpHypothesis(niche.niche)}`);
    lines.push('- Example tenders:');

    for (const row of examples) {
      lines.push(`  - ${row.tender_name} (${row.region}, ${row.price || 'no price'})`);
    }

    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function mvpHypothesis(niche) {
  const hypotheses = {
    llm_assistant: 'RAG/LLM assistant over internal documents, regulations, and knowledge bases.',
    computer_vision: 'Reusable video/image analysis module with domain adapters for inspection, surveillance, or recognition.',
    document_ai: 'Document ingestion, OCR, classification, field extraction, and workflow handoff.',
    analytics: 'Monitoring and analytics dashboard with automated classification and trend detection.',
    process_automation: 'Workflow automation layer for approvals, requests, and integrations.',
    custom_software: 'Template-based implementation kit for public-sector information systems and integrations.',
    ai_general: 'Discovery-led AI prototype package for a narrowly scoped operational task.',
  };

  return hypotheses[niche] || 'Validate repeated problem and build a focused prototype.';
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function topEntries(map) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, count]) => `${key} (${count})`);
}

function median(values) {
  if (values.length === 0) return '';
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return Math.round(sorted[middle]);
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || fallback;
}
