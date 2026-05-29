#!/usr/bin/env node
import { loadDotEnv } from '../src/env.js';
import { TenderGuruClient } from '../src/tenderguru-client.js';
import {
  appendJsonl,
  cleanText,
  dateValue,
  ensureDir,
  redactSecrets,
  writeCsv,
  writeJsonl,
  writeText,
} from '../src/export-utils.js';

loadDotEnv();

const runDate = getArg('date', new Date().toISOString().slice(0, 10).replace(/-/g, '-'));
const limit = Number(getArg('limit', '200'));
const pages = Number(getArg('pages', '3'));

const paths = {
  rawDir: `data/raw/smeta/${runDate}`,
  processedDir: `data/processed/smeta-${runDate}`,
};

ensureDir(paths.rawDir);
ensureDir(paths.processedDir);

const rawSearchPath = `${paths.rawDir}/search-results.jsonl`;
const rawDocsPath = `${paths.rawDir}/documentation-results.jsonl`;
const candidatesCsvPath = `${paths.processedDir}/smeta-tenders.csv`;
const candidatesJsonlPath = `${paths.processedDir}/smeta-tenders.jsonl`;
const summaryPath = `${paths.processedDir}/smeta-summary.md`;

writeJsonl(rawSearchPath, []);
writeJsonl(rawDocsPath, []);

const client = new TenderGuruClient();
const candidates = new Map();

// No category filter — smeta tenders span construction + IT categories
const queries = [
  { query: '"сметное программное обеспечение"', group: 'smeta_software' },
  { query: '"сметная программа"',               group: 'smeta_software' },
  { query: '"Гранд-Смета"',                     group: 'smeta_software' },
  { query: '"Гранд Смета"',                     group: 'smeta_software' },
  { query: '"ABC-Смета"',                        group: 'smeta_software' },
  { query: '"1С:Смета"',                         group: 'smeta_software' },
  { query: '"Адепт:Смета"',                      group: 'smeta_software' },
  { query: '"Адепт смета"',                      group: 'smeta_software' },
  { query: '"сметчик"',                          group: 'smeta_profession' },
  { query: '"составление смет"',                 group: 'smeta_service' },
  { query: '"сметная документация"',             group: 'smeta_service' },
  { query: '"проверка сметной"',                 group: 'smeta_control' },
  { query: '"проверка смет"',                    group: 'smeta_control' },
  { query: '"экспертиза сметной стоимости"',     group: 'smeta_control' },
  { query: '"автоматизация сметных"',            group: 'smeta_ai' },
  { query: '"автоматизация составления смет"',   group: 'smeta_ai' },
  { query: '"ФГИС ЦС"',                          group: 'smeta_normative' },
  { query: '"ГЭСН"',                             group: 'smeta_normative' },
  { query: '"ФЕРы"',                             group: 'smeta_normative' },
  { query: '"ТЕРы"',                             group: 'smeta_normative' },
  { query: '"ценообразование в строительстве"',  group: 'smeta_normative' },
  { query: '"BIM смета"',                        group: 'bim_smeta' },
  { query: '"ТИМ смета"',                        group: 'bim_smeta' },
  { query: '"проектно-сметная документация"',    group: 'psd' },
  { query: '"разработка ПСД"',                   group: 'psd' },
];

console.log(`Запросов: ${queries.length}, страниц на запрос: ${pages}`);
console.log(`Дата: ${runDate}, лимит: ${limit}\n`);

for (const { query, group } of queries) {
  for (let page = 1; page <= pages; page++) {
    await collectSearch(query, group, page);
    await collectDocs(query, group, page);
  }
}

const allCandidates = [...candidates.values()].sort(
  (a, b) => b.price - a.price || dateValue(b.date) - dateValue(a.date),
);

const selected = allCandidates.slice(0, limit);

writeJsonl(candidatesJsonlPath, selected.map(rowOf));
writeCsv(candidatesCsvPath, selected.map(rowOf));
writeText(summaryPath, buildSummary(selected.map(rowOf)));

console.log(`\nУникальных тендеров найдено: ${candidates.size}`);
console.log(`Записано: ${selected.length}`);
console.log(`CSV: ${candidatesCsvPath}`);
console.log(`MD:  ${summaryPath}`);

// ─── helpers ───────────────────────────────────────────────────────────────

async function collectSearch(query, group, page) {
  try {
    const response = await client.searchTenders({
      kwords: query,
      sort_by: 'by_date',
      sort_dest: 'desc',
      page,
      tenpage: 10,
    });
    appendJsonl(rawSearchPath, { source: 'search', query, group, page, response });
    for (const item of items(response)) upsert(item, query, group, 'search');
    const count = items(response).length;
    if (count > 0) process.stdout.write(`  [search p${page}] ${query}: ${count} результатов\n`);
  } catch (e) {
    process.stdout.write(`  [search p${page}] ${query}: ошибка — ${e.message.slice(0, 60)}\n`);
  }
}

async function collectDocs(query, group, page) {
  try {
    const response = await client.request('/documentation', { kwords: query, page });
    appendJsonl(rawDocsPath, { source: 'documentation', query, group, page, response });
    for (const item of items(response)) upsert(item, query, group, 'documentation');
  } catch (_) {}
}

function items(response) {
  return (Array.isArray(response) ? response : []).filter((i) => i && i.ID && !i.Total);
}

function upsert(item, query, group, source) {
  const id = item.TenderNumOuter || item.ID || item.TenderName;
  const cur = candidates.get(id) || {
    id,
    queries: new Set(),
    groups: new Set(),
    sources: new Set(),
    price: 0,
  };

  Object.assign(cur, {
    date:      item.Date      || cur.date      || '',
    name:      cleanText(item.TenderName || cur.name || ''),
    customer:  cleanText(item.Customer   || cur.customer || ''),
    category:  cleanText(item.Category   || cur.category || ''),
    region:    cleanText(item.Region     || cur.region   || ''),
    price:     Math.max(cur.price, parseFloat(item.Price || 0)),
    endTime:   item.EndTime   || cur.endTime   || '',
    fz:        item.Fz        || cur.fz        || '',
    link:      item.TenderLinkInner || cur.link || '',
  });

  cur.queries.add(query);
  cur.groups.add(group);
  cur.sources.add(source);
  candidates.set(id, cur);
}

function rowOf(c) {
  return {
    tender_id:   c.id,
    date:        c.date,
    name:        c.name,
    customer:    c.customer,
    category:    c.category,
    region:      c.region,
    price_rub:   c.price || '',
    price_M:     c.price ? (Math.round(c.price / 1e5) / 10).toFixed(1) : '',
    end_time:    c.endTime,
    fz:          c.fz,
    groups:      [...c.groups].join('; '),
    queries:     [...c.queries].join('; '),
    sources:     [...c.sources].join('; '),
    link:        c.link,
  };
}

function buildSummary(rows) {
  const byGroup = {};
  for (const r of rows) {
    for (const g of r.groups.split('; ')) {
      if (!byGroup[g]) byGroup[g] = { count: 0, total: 0, priced: 0, examples: [] };
      byGroup[g].count++;
      if (r.price_rub) { byGroup[g].total += parseFloat(r.price_rub); byGroup[g].priced++; }
      if (byGroup[g].examples.length < 3) byGroup[g].examples.push(`${r.price_M}M | ${r.region} | ${r.name.slice(0, 70)}`);
    }
  }

  const lines = [
    `# Сметный рынок — обзор тендеров`,
    ``,
    `Дата: ${runDate} | Всего уникальных: ${rows.length}`,
    ``,
    `| Группа | Тендеров | С ценой | Суммарно | Среднее |`,
    `|---|---:|---:|---:|---:|`,
  ];

  for (const [g, v] of Object.entries(byGroup).sort((a, b) => b[1].total - a[1].total)) {
    const avg = v.priced ? Math.round(v.total / v.priced / 1e6) : 0;
    lines.push(`| ${g} | ${v.count} | ${v.priced} | ${Math.round(v.total / 1e6)}M | ${avg}M |`);
  }

  lines.push('', '## Примеры по группам', '');
  for (const [g, v] of Object.entries(byGroup).sort((a, b) => b[1].total - a[1].total)) {
    lines.push(`### ${g}`);
    v.examples.forEach((e) => lines.push(`- ${e}`));
    lines.push('');
  }

  const top20 = rows.filter((r) => r.price_rub).slice(0, 20);
  lines.push('## Топ-20 тендеров по бюджету', '');
  lines.push('| Бюджет | Регион | Категория | Название |');
  lines.push('|---:|---|---|---|');
  for (const r of top20) {
    lines.push(`| ${r.price_M}M | ${r.region} | ${r.category} | ${r.name.slice(0, 80)} |`);
  }

  return lines.join('\n') + '\n';
}

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}
