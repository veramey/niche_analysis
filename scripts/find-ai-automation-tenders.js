#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadDotEnv } from '../src/env.js';
import { TenderGuruClient } from '../src/tenderguru-client.js';

loadDotEnv();

const client = new TenderGuruClient();
const limit = Number(process.argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || 10);
const pages = Number(process.argv.find((arg) => arg.startsWith('--pages='))?.split('=')[1] || 1);
const categoryFilter = { c12: 1 };

const queries = [
  '"искусственный интеллект"',
  '"технологии искусственного интеллекта"',
  '"машинное обучение"',
  '"нейронная сеть"',
  'нейросеть',
  '"компьютерное зрение"',
  '"распознавание документов"',
  '"распознавание изображений"',
  '"интеллектуальный анализ данных"',
  '"предиктивная аналитика"',
  '"автоматизация бизнес-процессов"',
  '"автоматизация процессов"',
  '"роботизация бизнес-процессов"',
  'RPA',
  'BPM',
  'BPMS',
  'workflow',
  '"разработка информационной системы"',
  '"доработка информационной системы"',
  '"внедрение программного обеспечения"',
];

const candidates = new Map();

for (const query of queries) {
  for (let page = 1; page <= pages; page += 1) {
    await collectSearchResults(query, page);
    await collectDocumentationResults(query, page);
  }
}

const ranked = [...candidates.values()]
  .map(scoreCandidate)
  .filter(isRelevantCandidate)
  .sort((a, b) => dateValue(b.date) - dateValue(a.date) || b.score - a.score)
  .slice(0, limit);

const enriched = [];

for (const candidate of ranked) {
  enriched.push(await enrichCandidate(candidate));
}

mkdirSync('exports', { recursive: true });
const outputPath = 'exports/ai-automation-system-integration-first-10.csv';
writeFileSync(outputPath, toCsv(enriched), 'utf8');

console.log(`Collected ${candidates.size} unique candidates`);
console.log(`Exported ${enriched.length} rows to ${outputPath}`);

async function collectSearchResults(query, page) {
  try {
    const response = await client.searchTenders({
      kwords: query,
      sort_by: 'by_date',
      sort_dest: 'desc',
      page,
      tenpage: 10,
      ...categoryFilter,
    });

    for (const item of responseItems(response)) {
      upsertCandidate(item, query, 'search');
    }
  } catch (error) {
    console.warn(`Skipped search query "${query}": ${clean(redact(error.message))}`);
  }
}

async function collectDocumentationResults(query, page) {
  try {
    const response = await client.request('/documentation', {
      kwords: query,
      page,
      ...categoryFilter,
    }, {
      timeoutMs: 15000,
    });

    for (const item of responseItems(response)) {
      upsertCandidate(item, query, 'documentation');
    }
  } catch (error) {
    console.warn(`Skipped documentation query "${query}": ${clean(redact(error.message))}`);
  }
}

function responseItems(response) {
  return (Array.isArray(response) ? response : [])
    .filter((item) => item && item.ID && !item.Total);
}

function upsertCandidate(item, query, source) {
  const apiInfo = parseApiTenderInfo(item.ApiTenderInfo);
  const lookupTendNum = item.TenderNumOuter || apiInfo.tend_num || '';
  const lookupId = source === 'documentation' ? apiInfo.id || '' : item.ID || apiInfo.id || '';
  const id = lookupTendNum || lookupId || item.ID || item.TenderLinkInner || item.TenderName;
  const current = candidates.get(id) || {
    id,
    lookupId,
    lookupTendNum,
    queries: new Set(),
    sources: new Set(),
    docLinks: new Set(),
  };

  Object.assign(current, {
    lookupId: current.lookupId || lookupId,
    lookupTendNum: current.lookupTendNum || lookupTendNum,
    rawDocumentationId: source === 'documentation' ? item.ID || current.rawDocumentationId || '' : current.rawDocumentationId || '',
    date: item.Date || current.date || '',
    name: clean(item.TenderName || current.name),
    customer: clean(item.Customer || current.customer),
    category: clean(item.Category || current.category),
    region: clean(item.Region || current.region),
    price: item.Price || current.price || '',
    endTime: item.EndTime || current.endTime || '',
    etp: clean(item.Etp || current.etp),
    tenderLink: item.TenderLink || current.tenderLink || '',
    tenderguruLink: item.TenderLinkInner || current.tenderguruLink || '',
    tenderNumOuter: item.TenderNumOuter || current.tenderNumOuter || '',
    fz: item.Fz || current.fz || '',
    apiTenderInfo: redact(item.ApiTenderInfo || current.apiTenderInfo || ''),
    searchFragment: clean(JSON.stringify(item.searchFragmentXML || '')),
  });

  current.queries.add(query);
  current.sources.add(source);
  if (item.DocLink1) current.docLinks.add(item.DocLink1);
  if (item.DocLink2) current.docLinks.add(item.DocLink2);

  candidates.set(id, current);
}

function scoreCandidate(candidate) {
  // Полный текст — только для НЕГАТИВНЫХ маркеров.
  const haystack = [
    candidate.name,
    candidate.category,
    candidate.searchFragment,
    [...candidate.queries].join(' '),
  ].join(' ').toLowerCase();

  // Позитивные AI/IT-термины считаем ТОЛЬКО по предмету закупки (название + категория).
  // Иначе совпадал сам поисковый запрос («искусственный интеллект») и/или boilerplate-фраза
  // «технологии искусственного интеллекта» из карточки — из-за этого погрузчики/топливо/
  // оросители проходили как ai_core. Предмет в названии — единственный чистый сигнал.
  const subject = [candidate.name, candidate.category].join(' ').toLowerCase();

  const matchedTerms = [];
  let score = 0;

  const positive = [
    [10, 'искусственный интеллект'],
    [10, 'технологии искусственного интеллекта'],
    [9, 'машинное обучение'],
    [9, 'нейронная сеть'],
    [9, 'нейросеть'],
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
    [10, 'рпа минюста'],
    [10, 'университет юстиции'],
    [8, 'пропускного режима'],
    [8, 'осуществлению круглосуточной охраны'],
    [8, 'бытовой техники'],
    [8, 'кухонная машина'],
    [8, 'картофелечистка'],
    [8, 'такелажных услуг'],
    [8, 'лекарственных средств'],
    [5, 'консультантплюс'],
    [4, 'kaspersky'],
    [4, 'контур.экстерн'],
    [4, 'контур.диадок'],
    [3, 'антивирус'],
    [3, 'лицензионных прав'],
  ];

  for (const [points, term] of positive) {
    if (subject.includes(term)) {
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

  return {
    ...candidate,
    score,
    classification: classify(matchedTerms, score),
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
  } catch (error) {
    card = { enrichment_error: error.message };
  }

  const docs = normalizeDocs(card.docsXML);
  const infoText = clean(card.Info || '');

  return {
    tender_id: candidate.id,
    tenderguru_card_id: card.ID || candidate.lookupId,
    documentation_result_id: candidate.rawDocumentationId || '',
    date: candidate.date,
    classification: candidate.classification,
    relevance_score: candidate.score,
    matched_terms: candidate.matchedTerms.join('; '),
    matched_queries: [...candidate.queries].join('; '),
    sources: [...candidate.sources].join('; '),
    reason: buildReason(candidate, infoText),
    tender_name: candidate.name,
    customer: clean(card.Customer || candidate.customer),
    customer_inn: card.CustomerINN || '',
    category: clean(card.Category || candidate.category),
    region: clean(card.Region || candidate.region),
    price: card.Price || candidate.price,
    end_time: card.EndTime || candidate.endTime,
    fz: card.Fz || candidate.fz,
    etp: clean(card.Etp || candidate.etp),
    tender_num_outer: card.TenderNumOuter || candidate.tenderNumOuter,
    tender_link: card.TenderLink || candidate.tenderLink,
    tenderguru_link: card.TenderLinkInner || candidate.tenderguruLink,
    doc_links_from_documentation_search: [...candidate.docLinks].map(redact).join(' | '),
    docs_count_in_card: docs.length,
    docs_status: docs.length > 0 ? 'docsXML available' : 'docsXML empty in tender card',
    docs_ai_api_url: `https://www.tenderguru.ru/api2.3/export?dtype=json&mode=ai&act=webhook&t=${encodeURIComponent(card.ID || candidate.lookupId || candidate.id)}&ff=a&drl=1`,
  };
}

function classify(terms, score) {
  const joined = terms.join(' ');
  if (/(искусственный интеллект|машинное обучение|нейронная сеть|нейросеть|компьютерное зрение|распознавание|предиктивная аналитика|интеллектуальный анализ)/i.test(joined)) {
    return 'ai_core';
  }
  if (/(автоматизация|rpa|bpm|bpms|workflow|информационной системы)/i.test(joined)) {
    return 'automation_software';
  }
  return score >= 3 ? 'software_related' : 'noise';
}

function isRelevantCandidate(candidate) {
  if (dateValue(candidate.date) > Date.UTC(2026, 4, 25)) return false;

  const onlyDocumentation = candidate.sources.size === 1 && candidate.sources.has('documentation');
  if (onlyDocumentation) return candidate.score >= 20;

  return candidate.score >= 6;
}

function buildReason(candidate, infoText) {
  const terms = candidate.matchedTerms.filter((term) => !term.startsWith('-')).slice(0, 4).join(', ');
  const source = candidate.sources.has('documentation') ? 'найдено также в документации' : 'найдено в карточке/названии';
  const context = infoText ? `; карточка содержит ${Math.min(infoText.length, 500)} символов описания` : '';
  return `${source}; совпадения: ${terms || 'нет'}${context}`;
}

function normalizeDocs(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(normalizeDocs);
  if (typeof value !== 'object') return [{ raw: value }];
  if (Array.isArray(value.Doc)) return value.Doc;
  if (Array.isArray(value.Item)) return value.Item;
  if (Array.isArray(value.Document)) return value.Document;
  if (Array.isArray(value.file)) return value.file;
  return Object.keys(value).length === 0 ? [] : [value];
}

function toCsv(data) {
  const headers = Object.keys(data[0] || {});
  return `${[headers.join(','), ...data.map((row) => headers.map((header) => csvCell(row[header])).join(','))].join('\n')}\n`;
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function clean(value) {
  return String(value ?? '')
    .replace(/!\[CDATA\[/g, '')
    .replace(/\]\]/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\[B\]|\[\/B\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function redact(value) {
  return String(value ?? '').replace(/(api_code=)[^&"'\s]+/gi, '$1<redacted>');
}

function parseApiTenderInfo(value) {
  if (!value) return {};

  try {
    const url = new URL(redact(value));
    return {
      id: url.searchParams.get('id') || '',
      tend_num: url.searchParams.get('tend_num') || '',
    };
  } catch {
    return {};
  }
}

function dateValue(value) {
  const [day, month, year] = String(value || '').split('-').map(Number);
  return year && month && day ? new Date(year, month - 1, day).getTime() : 0;
}
