#!/usr/bin/env node
import { loadDotEnv } from '../src/env.js';
import { TenderGuruClient } from '../src/tenderguru-client.js';
import {
  cleanText,
  ensureDir,
  parseApiTenderInfo,
  redactSecrets,
  writeCsv,
  writeJsonl,
  writeText,
} from '../src/export-utils.js';

loadDotEnv();

const runDate = getArg('date', '2026-05-28');
const pages = Number(getArg('pages', '2'));
const tenpage = Number(getArg('tenpage', '10'));
const categoryFilter = { c12: 1 };

const analysisDir = `data/analysis/${runDate}`;
ensureDir(analysisDir);

const client = new TenderGuruClient();

const hypotheses = [
  {
    id: 'citizen-appeals-ai',
    title: 'AI-диспетчер обращений граждан',
    queries: [
      'обращения граждан',
      'обработка обращений',
      'классификация обращений',
      'единая система обращений',
      'служба 122',
    ],
  },
  {
    id: 'npa-monitoring-ai',
    title: 'AI-мониторинг НПА и регуляторных изменений',
    queries: [
      'нормативных правовых актов',
      'мониторинг НПА',
      'анализ НПА',
      'правовой мониторинг',
      'regulation.gov.ru',
    ],
  },
  {
    id: 'document-intake-ocr',
    title: 'Document intake: OCR, проверка и автозаполнение документов',
    queries: [
      'распознавание документов',
      'автозаполнение документов',
      'извлечение данных из документов',
      'сканирование и распознавание документов',
      'OCR',
    ],
  },
  {
    id: 'municipal-chatbot-contact-center',
    title: 'AI-контакт-центр и чат-бот для муниципальных услуг',
    queries: [
      'чат-бот',
      'голосовой помощник',
      'виртуальный помощник',
      'контакт-центр',
      'единая система голосового обслуживания',
    ],
  },
];

const rawRows = [];
const tenderMap = new Map();
const queryRows = [];

for (const hypothesis of hypotheses) {
  for (const query of hypothesis.queries) {
    for (const source of ['search', 'documentation']) {
      for (let page = 1; page <= pages; page += 1) {
        const response = await requestSource(source, query, page);
        const items = responseItems(response);
        const total = responseTotal(response);

        queryRows.push({
          hypothesis_id: hypothesis.id,
          hypothesis_title: hypothesis.title,
          source,
          query,
          page,
          total,
          returned: items.length,
        });

        rawRows.push({
          hypothesis_id: hypothesis.id,
          source,
          query,
          page,
          total,
          response,
        });

        for (const item of items) {
          upsertTender(hypothesis, query, source, item, total);
        }
      }
    }
  }
}

const tenders = [...tenderMap.values()]
  .map((tender) => ({
    ...tender,
    queries: [...tender.queries].join('; '),
    sources: [...tender.sources].join('; '),
    max_query_total: tender.maxQueryTotal,
    score: tender.sources.size * 2 + tender.queries.size,
  }))
  .sort((a, b) => a.hypothesis_id.localeCompare(b.hypothesis_id) || b.score - a.score || b.price_num - a.price_num);

const summaries = hypotheses.map((hypothesis) => summarizeHypothesis(hypothesis, tenders, queryRows));

writeJsonl(`${analysisDir}/startup-niche-api-raw.jsonl`, rawRows);
writeCsv(`${analysisDir}/startup-niche-api-query-stats.csv`, queryRows);
writeCsv(`${analysisDir}/startup-niche-api-tenders.csv`, tenders.map(rowTender));
writeText(`${analysisDir}/startup-niche-api-summary.md`, renderSummary(summaries, tenders));

console.log(`Wrote ${analysisDir}/startup-niche-api-summary.md`);
console.log(`Wrote ${analysisDir}/startup-niche-api-tenders.csv`);

async function requestSource(source, query, page) {
  try {
    if (source === 'documentation') {
      return await client.request('/documentation', {
        kwords: query,
        page,
        tenpage,
        ...categoryFilter,
      }, {
        timeoutMs: 20000,
      });
    }

    return await client.searchTenders({
      kwords: query,
      page,
      tenpage,
      sort_by: 'by_date',
      sort_dest: 'desc',
      ...categoryFilter,
    });
  } catch (error) {
    return [{ error: cleanText(redactSecrets(error.message)) }];
  }
}

function responseItems(response) {
  return (Array.isArray(response) ? response : [])
    .filter((item) => item && item.ID && !item.Total && !item.error);
}

function responseTotal(response) {
  const totalItem = Array.isArray(response) ? response.find((item) => item && item.Total) : null;
  return Number(totalItem?.Total || 0);
}

function upsertTender(hypothesis, query, source, item, total) {
  const apiInfo = parseApiTenderInfo(item.ApiTenderInfo);
  const id = item.TenderNumOuter || apiInfo.tend_num || item.ID || item.TenderLinkInner || item.TenderName;
  const price = Number(String(item.Price || '').replace(/[^\d.]/g, '')) || 0;

  const current = tenderMap.get(`${hypothesis.id}:${id}`) || {
    hypothesis_id: hypothesis.id,
    hypothesis_title: hypothesis.title,
    tender_id: id,
    tenderguru_id: item.ID || apiInfo.id || '',
    date: item.Date || '',
    tender_name: '',
    customer: '',
    category: '',
    region: '',
    price: '',
    price_num: 0,
    fz: '',
    tender_link: '',
    tenderguru_link: '',
    search_fragment: '',
    queries: new Set(),
    sources: new Set(),
    maxQueryTotal: 0,
  };

  current.tender_name ||= cleanText(item.TenderName || '');
  current.customer ||= cleanText(item.Customer || '');
  current.category ||= cleanText(item.Category || '');
  current.region ||= cleanText(item.Region || '');
  current.price ||= item.Price || '';
  current.price_num = Math.max(current.price_num, price);
  current.fz ||= item.Fz || '';
  current.tender_link ||= item.TenderLink || '';
  current.tenderguru_link ||= item.TenderLinkInner || '';
  current.search_fragment ||= cleanText(JSON.stringify(item.searchFragmentXML || ''));
  current.queries.add(query);
  current.sources.add(source);
  current.maxQueryTotal = Math.max(current.maxQueryTotal, total);

  tenderMap.set(`${hypothesis.id}:${id}`, current);
}

function summarizeHypothesis(hypothesis, tenders, queryRows) {
  const rows = tenders.filter((row) => row.hypothesis_id === hypothesis.id);
  const priced = rows.filter((row) => row.price_num > 0);
  const queryStats = queryRows.filter((row) => row.hypothesis_id === hypothesis.id);
  const maxTotal = Math.max(0, ...queryStats.map((row) => Number(row.total || 0)));
  const totalBudget = priced.reduce((sum, row) => sum + row.price_num, 0);

  return {
    ...hypothesis,
    unique_tenders: rows.length,
    priced_count: priced.length,
    total_budget: totalBudget,
    median_budget: median(priced.map((row) => row.price_num)),
    max_query_total: maxTotal,
    examples: rows.slice(0, 5),
  };
}

function rowTender(row) {
  return {
    hypothesis_id: row.hypothesis_id,
    hypothesis_title: row.hypothesis_title,
    tender_id: row.tender_id,
    tenderguru_id: row.tenderguru_id,
    date: row.date,
    tender_name: row.tender_name,
    customer: row.customer,
    region: row.region,
    price: row.price,
    fz: row.fz,
    queries: row.queries,
    sources: row.sources,
    max_query_total: row.max_query_total,
    tender_link: row.tender_link,
    tenderguru_link: row.tenderguru_link,
    search_fragment: row.search_fragment,
  };
}

function renderSummary(summaries, tenders) {
  const lines = [
    '# API scan: startup нишы в TenderGuru',
    '',
    `Дата скана: ${runDate}`,
    `Источник: TenderGuru API v2.3 export + /documentation, c12=1, pages=${pages}, tenpage=${tenpage}`,
    '',
    '| Гипотеза | Уникальных тендеров | Max Total по запросу | С ценой | Сумма цен | Медиана цены |',
    '|---|---:|---:|---:|---:|---:|',
  ];

  for (const summary of summaries) {
    lines.push(`| ${summary.title} | ${summary.unique_tenders} | ${summary.max_query_total} | ${summary.priced_count} | ${Math.round(summary.total_budget)} | ${Math.round(summary.median_budget)} |`);
  }

  for (const summary of summaries) {
    lines.push('');
    lines.push(`## ${summary.title}`);
    lines.push('');
    lines.push(`- Query max Total: ${summary.max_query_total}`);
    lines.push(`- Unique tenders in sampled pages: ${summary.unique_tenders}`);
    lines.push(`- Priced sampled budget: ${Math.round(summary.total_budget)} RUB`);
    lines.push('- Examples:');

    const examples = tenders.filter((row) => row.hypothesis_id === summary.id).slice(0, 5);
    for (const row of examples) {
      lines.push(`  - ${row.date}: ${row.tender_name} — ${row.customer || 'unknown'}, ${row.region || 'unknown'}, ${row.price || 'no price'}, ${row.tenderguru_link}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}
