/**
 * Полный ретест соответствия тендеров референсу (data-fidelity audit).
 *
 * Для каждого тендера из public/data/tenders.json берём эталон из TenderGuru API
 * и сверяем, что показанное в карточке дашборда (имя, заказчик, бюджет, ссылки,
 * описание/AI-анализ) соответствует реальному тендеру на сайте.
 *
 * Источник эталона — только API. Результат — только отчёт; данные приложения не трогаем.
 *
 * Использование:
 *   node scripts/retest-tender-fidelity.js                 # все тендеры
 *   node scripts/retest-tender-fidelity.js --limit=10      # первые 10
 *   node scripts/retest-tender-fidelity.js --only=<id>     # один тендер
 *   node scripts/retest-tender-fidelity.js --delay=800     # пауза между запросами, мс
 *   node scripts/retest-tender-fidelity.js --no-cache      # игнорировать кэш ответов API
 *   node scripts/retest-tender-fidelity.js --date=2026-05-25
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadDotEnv } from '../src/env.js';
import { TenderGuruClient } from '../src/tenderguru-client.js';
import {
  cleanText,
  writeJsonl,
  writeCsv,
  writeText,
  ensureDir,
  redactSecretsDeep,
} from '../src/export-utils.js';

loadDotEnv();

// --- args ---------------------------------------------------------------
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
const LIMIT = Number(getArg('limit', 0)) || 0;
const ONLY = String(getArg('only', '') || '');
const DELAY = Number(getArg('delay', 800)) || 0;
const NO_CACHE = getArg('no-cache', false) === true || String(getArg('no-cache', '')) === 'true';

// Пороги сходства (стартовые, подстраиваются по результатам узкого прогона).
const NAME_MISMATCH = 0.30; // < — имя не совпадает
const CUSTOMER_MATCH = 0.50; // >= — заказчик совпадает
const DESC_MISMATCH = 0.50; // < — сохранённый info_text не соответствует живому API Info
//                              (у корректных тендеров info_corr ≈ 0.98–0.997)

const ROOT = process.cwd();
const TENDERS_PATH = join(ROOT, 'public/data/tenders.json');
const CACHE_DIR = join(ROOT, 'data/raw/tenderguru', DATE, 'api-retest');
const OUT_DIR = join(ROOT, 'data/analysis', DATE);

const client = new TenderGuruClient();
ensureDir(CACHE_DIR);
ensureDir(OUT_DIR);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- text helpers -------------------------------------------------------
function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?34;/g, '"')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#\d+;/g, ' ');
}

function tokenize(value) {
  const text = cleanText(decodeEntities(value)).toLowerCase();
  return new Set(
    text
      .replace(/[^a-zа-яё0-9 ]+/gi, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function normField(value) {
  return cleanText(decodeEntities(value)).toLowerCase().replace(/\s+/g, ' ').trim();
}

// Целая часть суммы в рублях (для сравнения бюджета).
function intRub(value) {
  const m = String(value ?? '').replace(/\s/g, '').match(/\d+/);
  return m ? String(parseInt(m[0], 10)) : '';
}

function cardIdFromLink(link) {
  const m = String(link ?? '').match(/tenderguru\.ru\/tender\/(\d+)/i);
  return m ? m[1] : '';
}

function regNumFromLink(link) {
  const m = String(link ?? '').match(/regNumber=([0-9A-Za-zА-Яа-я]+)/);
  return m ? m[1] : '';
}

function snippet(value, n = 80) {
  return cleanText(decodeEntities(value)).slice(0, n);
}

// --- API fetch with disk cache -----------------------------------------
function cacheKey(t) {
  const key = t.tenderguru_card_id || t.tender_id || t.tender_num || 'unknown';
  return String(key).replace(/[^\w.-]/g, '_');
}

function pickRecord(res) {
  const arr = Array.isArray(res) ? res : res && typeof res === 'object' ? [res] : [];
  for (const item of arr) {
    if (item && (item.ID || item.TenderName)) return item;
  }
  return null;
}

async function fetchApi(t) {
  const cacheFile = join(CACHE_DIR, `${cacheKey(t)}.json`);
  if (!NO_CACHE && existsSync(cacheFile)) {
    try {
      return { record: JSON.parse(readFileSync(cacheFile, 'utf8')), cached: true };
    } catch {
      /* fall through to refetch */
    }
  }

  // Кандидаты EIS-номера: сырой + дополненный ведущими нулями до 19 знаков
  // (в дашборде у части тендеров ведущий ноль потерян, напр. 811…023 → 0811…023).
  const eisCandidates = new Set();
  for (const raw of [t.tender_num, t.tender_id]) {
    const s = String(raw || '');
    if (/^\d{15,20}$/.test(s)) {
      eisCandidates.add(s);
      if (s.length < 19) eisCandidates.add(s.padStart(19, '0'));
    }
  }

  const attempts = [];
  if (t.tenderguru_card_id) attempts.push(() => client.getTenderById(t.tenderguru_card_id));
  for (const num of eisCandidates) attempts.push(() => client.getTenderByNumber(num));
  if (t.tender_id && t.tender_id !== t.tenderguru_card_id) {
    attempts.push(() => client.getTenderById(t.tender_id));
  }

  let record = null;
  let lastErr = '';
  for (let i = 0; i < attempts.length; i += 1) {
    try {
      const res = await attempts[i]();
      record = pickRecord(res);
      if (record) break;
    } catch (err) {
      lastErr = String(err?.message || err);
    }
    if (i < attempts.length - 1) await sleep(DELAY);
  }

  const out = record
    ? redactSecretsDeep(record)
    : { __notfound: true, __error: lastErr };
  try {
    writeText(cacheFile, `${JSON.stringify(out, null, 1)}\n`);
  } catch {
    /* ignore cache write errors */
  }
  return { record: out, cached: false };
}

// --- comparison ---------------------------------------------------------
function compare(t, api) {
  const checks = {};
  const mismatches = [];

  if (!api || api.__notfound) {
    return {
      status: 'api_not_found',
      checks: { api_error: api?.__error || '' },
      mismatches: ['api_not_found'],
    };
  }

  // 1. Link integrity (главный источник багов).
  const apiCard = String(api.ID || '') || cardIdFromLink(api.TenderLinkInner);
  const apiReg = regNumFromLink(api.TenderLink) || regNumFromLink(api.EisLink);
  const dashCard = String(t.tenderguru_card_id || '');
  const dashReg =
    regNumFromLink(t.tender_link) || regNumFromLink(t.eis_link)
    || (/^\d{19}$/.test(String(t.tender_id)) ? String(t.tender_id) : '');

  checks.card_id_match = dashCard && apiCard ? dashCard === apiCard : null;
  checks.reg_num_match = dashReg && apiReg ? dashReg === apiReg : null;
  if (checks.card_id_match === false) mismatches.push('card_id');
  if (checks.reg_num_match === false) mismatches.push('reg_num');

  // 2. Поля.
  const nameScore = jaccard(tokenize(t.tender_name), tokenize(api.TenderName));
  checks.name_score = Number(nameScore.toFixed(3));
  if (nameScore < NAME_MISMATCH) mismatches.push('name');

  if (normField(t.customer) && normField(api.Customer)) {
    const custScore = jaccard(tokenize(t.customer), tokenize(api.Customer));
    checks.customer_score = Number(custScore.toFixed(3));
    checks.customer_match = custScore >= CUSTOMER_MATCH;
    if (!checks.customer_match) mismatches.push('customer');
  } else {
    checks.customer_match = null;
  }

  const dPrice = intRub(t.price || t.budget_rub);
  const aPrice = intRub(api.Price);
  // ±1 ₽ допуск — округление копеек (напр. 975133187 vs 975133186).
  checks.price_match = dPrice && aPrice ? Math.abs(Number(dPrice) - Number(aPrice)) <= 1 : null;
  checks.price_dash = dPrice;
  checks.price_api = aPrice;
  if (checks.price_match === false) mismatches.push('price');

  checks.region_match =
    normField(t.region) && normField(api.Region)
      ? normField(t.region) === normField(api.Region)
      : null;
  if (checks.region_match === false) mismatches.push('region');

  // 3. Соответствие описания: сохранённый info_text против живого API Info.
  //    Один источник (TenderGuru), поэтому у корректных тендеров пересечение ~0.99;
  //    низкое значение = в дашборде показано чужое/устаревшее описание.
  const apiInfoTokens = tokenize(cleanText(decodeEntities(api.Info)));
  if (normField(t.info_text) && apiInfoTokens.size) {
    const infoCorr = jaccard(tokenize(t.info_text), apiInfoTokens);
    checks.info_corr = Number(infoCorr.toFixed(3));
    if (infoCorr < DESC_MISMATCH) mismatches.push('description');
  }

  //    AI-анализ карточки против тендера — справочно (paraphrase, не влияет на вердикт).
  if (t.has_card && (t.opportunity_title || t.problem)) {
    const apiText = tokenize(`${api.TenderName || ''} ${cleanText(decodeEntities(api.Info))}`);
    const analysis = `${t.opportunity_title || ''} ${t.problem || ''} ${t.requested_solution || ''}`;
    checks.analysis_score = Number(jaccard(tokenize(analysis), apiText).toFixed(3));
  }

  // 4. Вердикт (по приоритету).
  let status = 'ok';
  if (mismatches.includes('card_id') || mismatches.includes('reg_num')) {
    status = 'link_mismatch';
  } else if (['name', 'customer', 'price', 'region'].some((m) => mismatches.includes(m))) {
    status = 'field_mismatch';
  } else if (mismatches.includes('description')) {
    status = 'desc_mismatch';
  }

  return { status, checks, mismatches };
}

// --- main ---------------------------------------------------------------
async function main() {
  if (!existsSync(TENDERS_PATH)) {
    console.error(`Не найден ${TENDERS_PATH}. Сначала собери дашборд (npm run build).`);
    process.exit(1);
  }

  let tenders = JSON.parse(readFileSync(TENDERS_PATH, 'utf8'));
  if (ONLY) tenders = tenders.filter((t) => String(t.tender_id) === ONLY || String(t.tenderguru_card_id) === ONLY);
  if (LIMIT > 0) tenders = tenders.slice(0, LIMIT);

  console.log(`Ретест соответствия: ${tenders.length} тендеров, эталон = TenderGuru API.`);
  console.log(`Кэш ответов: ${CACHE_DIR}${NO_CACHE ? ' (отключён)' : ''}`);

  const results = [];
  let liveCalls = 0;
  for (let i = 0; i < tenders.length; i += 1) {
    const t = tenders[i];
    const { record, cached } = await fetchApi(t);
    const cmp = compare(t, record);

    results.push({
      tender_id: t.tender_id,
      card_id: t.tenderguru_card_id || '',
      status: cmp.status,
      mismatches: cmp.mismatches,
      checks: cmp.checks,
      has_card: !!t.has_card,
      dashboard: {
        name: snippet(t.tender_name, 140),
        customer: snippet(t.customer, 100),
        price: intRub(t.price || t.budget_rub),
        region: normField(t.region),
        tenderguru_link: t.tenderguru_link || '',
      },
      api: record && !record.__notfound
        ? {
          id: record.ID || '',
          name: snippet(record.TenderName, 140),
          customer: snippet(record.Customer, 100),
          price: intRub(record.Price),
          region: normField(record.Region),
          link: record.TenderLinkInner || '',
        }
        : { __notfound: true, error: record?.__error || '' },
    });

    if (!cached) {
      liveCalls += 1;
      if (i < tenders.length - 1) await sleep(DELAY);
    }
    if ((i + 1) % 25 === 0 || i === tenders.length - 1) {
      console.log(`  ${i + 1}/${tenders.length} (live ${liveCalls})…`);
    }
  }

  writeReports(results);
}

function writeReports(results) {
  const jsonlPath = join(OUT_DIR, 'tender-fidelity-retest.jsonl');
  const csvPath = join(OUT_DIR, 'tender-fidelity-retest.csv');
  const mdPath = join(OUT_DIR, 'tender-fidelity-retest.md');

  writeJsonl(jsonlPath, results);

  const csvRows = results.map((r) => ({
    tender_id: r.tender_id,
    card_id: r.card_id,
    status: r.status,
    mismatches: r.mismatches.join(';'),
    name_score: r.checks.name_score ?? '',
    customer_score: r.checks.customer_score ?? '',
    info_corr: r.checks.info_corr ?? '',
    analysis_score: r.checks.analysis_score ?? '',
    price_dash: r.checks.price_dash ?? r.dashboard.price ?? '',
    price_api: r.checks.price_api ?? '',
    card_id_match: r.checks.card_id_match ?? '',
    reg_num_match: r.checks.reg_num_match ?? '',
    has_card: r.has_card,
    dash_name: r.dashboard.name,
    api_name: r.api.__notfound ? '(not found)' : r.api.name,
    dash_customer: r.dashboard.customer,
    api_customer: r.api.__notfound ? '' : r.api.customer,
    tenderguru_link: r.dashboard.tenderguru_link,
  }));
  writeCsv(csvPath, csvRows);

  // --- summary ---
  const order = ['ok', 'desc_mismatch', 'field_mismatch', 'link_mismatch', 'api_not_found'];
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  const total = results.length;

  const lines = [];
  lines.push('# Ретест соответствия тендеров референсу (data-fidelity)');
  lines.push('');
  lines.push(`Дата данных: ${DATE}. Эталон: TenderGuru API. Проверено тендеров: **${total}**.`);
  lines.push('');
  lines.push('Проверка: совпадает ли то, что показано в карточке дашборда (имя, заказчик, бюджет,');
  lines.push('ссылки, описание/AI-анализ), с реальным тендером из API.');
  lines.push('');
  lines.push('## Распределение по статусам');
  lines.push('');
  lines.push('| Статус | Кол-во | Доля | Значение |');
  lines.push('|--------|-------:|-----:|----------|');
  const meaning = {
    ok: 'карточка соответствует реальному тендеру',
    desc_mismatch: 'описание/AI-анализ не про этот тендер',
    field_mismatch: 'расходятся имя/заказчик/бюджет/регион',
    link_mismatch: 'ссылка ведёт на чужой тендер (card_id/regNumber)',
    api_not_found: 'API не вернул тендер',
  };
  for (const s of order) {
    if (!counts[s]) continue;
    const pct = ((counts[s] / total) * 100).toFixed(1);
    lines.push(`| \`${s}\` | ${counts[s]} | ${pct}% | ${meaning[s]} |`);
  }
  lines.push('');
  const problems = results.filter((r) => r.status !== 'ok');
  lines.push(`**Требуют внимания: ${problems.length} из ${total}.**`);
  lines.push('');

  for (const s of order.filter((x) => x !== 'ok')) {
    const rows = results.filter((r) => r.status === s);
    if (!rows.length) continue;
    lines.push(`## ${s} (${rows.length})`);
    lines.push('');
    lines.push('| tender_id | поля | дашборд | API | score |');
    lines.push('|-----------|------|---------|-----|------:|');
    for (const r of rows.slice(0, 60)) {
      const apiName = r.api.__notfound ? `(нет: ${r.api.error || 'n/a'})` : r.api.name;
      const score = s === 'desc_mismatch'
        ? `info_corr=${r.checks.info_corr ?? ''}`
        : (r.checks.name_score ?? '');
      lines.push(
        `| \`${r.tender_id}\` | ${r.mismatches.join(', ')} | ${mdCell(r.dashboard.name)} | ${mdCell(apiName)} | ${score} |`,
      );
    }
    if (rows.length > 60) lines.push(`| … | ещё ${rows.length - 60} | | | |`);
    lines.push('');
  }

  lines.push('## tender_id, требующие исправления');
  lines.push('');
  lines.push('```');
  for (const r of problems) lines.push(`${r.tender_id}\t${r.status}\t${r.mismatches.join(',')}`);
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

function mdCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 70);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
