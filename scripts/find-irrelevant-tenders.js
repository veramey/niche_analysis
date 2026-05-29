/**
 * Поиск НЕРЕЛЕВАНТНЫХ тендеров в дашборде (проблема в данных, не в заголовке).
 *
 * Причина мусора: скорер засчитывал шаблонную юридическую фразу «технологии
 * искусственного интеллекта» из карточек закупок (нацрежим/приоритет) как AI-совпадение,
 * поэтому погрузчики, дизтопливо, оросители и т.п. получили class=ai_core, rel=20.
 *
 * Чистый сигнал — ПРЕДМЕТ закупки (tender_name): boilerplate-фразы в имени нет, а текст
 * карточки (API Info) тоже замусорен стандартными фразами про ЕИС/площадку, поэтому
 * вердикт строим ТОЛЬКО по имени. info_has_real_ai — справочно, для ручной проверки.
 *
 * Только отчёт. Использование: node scripts/find-irrelevant-tenders.js [--date=2026-05-25]
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanText, writeJsonl, writeCsv, writeText, ensureDir } from '../src/export-utils.js';

const argv = process.argv.slice(2);
const getArg = (n, d) => {
  const p = `--${n}`;
  for (const a of argv) { if (a === p) return true; if (a.startsWith(`${p}=`)) return a.slice(p.length + 1); }
  return d;
};
const DATE = String(getArg('date', '2026-05-25'));
const ROOT = process.cwd();
const TENDERS = join(ROOT, 'public/data/tenders.json');
const CACHE = join(ROOT, 'data/raw/tenderguru', DATE, 'api-retest');
const OUT = join(ROOT, 'data/analysis', DATE);

const lc = (s) => String(s ?? '').toLowerCase();
// Кириллица-aware: JS \w НЕ матчит кириллицу. Заменяем \w* на класс с кириллицей.
const S = '[а-яёa-z0-9]*';
const re = (src) => new RegExp(src.replace(/\\w\*?/g, S), 'i');

// Настоящий AI-предмет (НЕ общая фраза «искусственный интеллект»).
const STRONG_AI = re('(нейросет|нейронн\\w* сет|машинн\\w* обуч|machine learn|deep learn|\\bml\\b|\\bllm\\b|\\bgpt\\b|языков\\w* модел|компьютерн\\w* зрен|computer vision|распознав|детектир\\w* объект|видеоаналит|\\bocr\\b|чат-?бот|чатбот|голосов\\w*[ -](помощник|робот|ассистент|бот)|речев\\w*[ -](аналит|распознав|синтез)|биометри|предиктивн|рекомендательн\\w* систем|интеллектуальн\\w*[ -](анализ|систем|транспорт|видео|поиск)|больших данных|big data|обработк\\w* естественн\\w* язык|\\bnlp\\b)');

// IT/софт-предмет (тоже релевантный).
const SOFT_IT = re('(программн\\w* обеспечен|программн\\w*-аппаратн|software|информацион\\w*[ -]систем|\\bгис\\b|\\bаис\\b|\\bасу\\b|\\bпак\\b|платформ\\w|портал\\w|веб-сервис|мобильн\\w* приложен|разработк\\w*[^.]{0,30}(\\bпо\\b|систем|сервис|портал|сайт|приложен|платформ|модул)|интеграц\\w*[^.]{0,18}систем|\\bapi\\b|\\bcrm\\b|\\berp\\b|документооборот|\\bэдо\\b|роботизац\\w*[ -](процесс|бизнес)|\\brpa\\b|цифров\\w|дашборд|обработк\\w*[^.]{0,8}данн|баз\\w* данных|телемедицин|интернет вещей|\\biot\\b|умн\\w*[ -](город|дом|транспорт))');

// Явный физический/работы/товарный предмет (не IT).
const PHYSICAL = re('(погрузчик|топлив|дизельн|бензин|\\bгсм\\b|аккумулятор|батаре|оросител|насос|\\bтруб[аы ]|арматур|освещен|светильник|\\bремонт|\\bмонтаж|кровл|фасад|бетон|кирпич|\\bпесок|щебень|асфальт|дорожн|мебел|спецодежд|\\bодежд|\\bобув|питани|пищев|\\bмясо|молок|\\bовощ|канцеляр|\\bбумаг|картридж|\\bшин[аы]|запчаст|\\bзип\\b|грузов|аренд\\w*[^.]{0,12}(транспорт|автомобил|техник|помещен)|перевозк|уборк|клинин|вывоз|утилизац|благоустройств|озеленен|строительн|строительств|реконструкц|вентиляц|кондиционир|\\bлифт|разгруз|погруз|сантехн|электромонтаж|изготовлен\\w* и поставк|металлоконструкц|ограждени|\\bокна\\b|\\bдвери|\\bворота)');

// Только железо (без разработки/AI).
const HARDWARE = re('(систем\\w* блок|вычислительн\\w*[ -](узл|узел|стенд|платформ|мощност)|графическ\\w* ускорител|видеокарт|\\bgpu\\b|сервер\\w|сетев\\w* оборуд|коммутатор|маршрутизатор|\\bпланшет|ноутбук|\\bмонитор|сопроцессор|накопител|\\bсхд\\b|сканер|принтер|\\bмфу\\b)');

function boilerplateOnly(x) {
  const m = lc(x.matched_terms);
  if (!/искусственн/.test(m)) return false;
  const rest = m
    .replace(/технологи[а-яё]* искусственного интеллекта/g, '')
    .replace(/искусственн[а-яё]* интеллект[а-яё]*/g, '')
    .replace(/[;,\s]+/g, '');
  return rest.length === 0;
}

function infoHasRealAI(x) {
  const key = String(x.tenderguru_card_id || x.tender_id).replace(/[^\w.-]/g, '_');
  try {
    const api = JSON.parse(readFileSync(join(CACHE, `${key}.json`), 'utf8'));
    if (!api || api.__notfound) return null;
    const text = lc(cleanText(`${api.TenderName || ''} ${api.Info || ''}`));
    return STRONG_AI.test(text) || SOFT_IT.test(text);
  } catch { return null; }
}

// Фраза «искусственный интеллект» В НАЗВАНИИ — настоящий сигнал (boilerplate сидит в карточке, не в имени).
const AI_IN_NAME = /(искусственн[а-яё]* интеллект|\bии-|нейросет|machine learning)/i;

function classifyByName(name) {
  const n = lc(name);
  if (AI_IN_NAME.test(n)) return 'relevant_ai';
  if (STRONG_AI.test(n)) return 'relevant_ai';
  if (SOFT_IT.test(n)) return 'relevant_soft';
  if (PHYSICAL.test(n)) return 'irrelevant_physical';
  if (HARDWARE.test(n)) return 'hardware_only';
  return 'ambiguous';
}

const tenders = JSON.parse(readFileSync(TENDERS, 'utf8'));
const rows = tenders.map((x) => {
  const verdict = classifyByName(x.tender_name);
  const nonrel = verdict === 'irrelevant_physical' || verdict === 'hardware_only' || verdict === 'ambiguous';
  return {
    tender_id: x.tender_id,
    card_id: x.tenderguru_card_id || '',
    verdict,
    relevant: /^relevant/.test(verdict),
    boilerplate_only_ai: boilerplateOnly(x),
    info_has_real_ai: nonrel ? infoHasRealAI(x) : null, // справочно
    classification: x.classification || '',
    relevance_score: x.relevance_score || '',
    product_category: x.product_category || '',
    customer: cleanText(x.customer).slice(0, 60),
    tender_name: cleanText(x.tender_name).slice(0, 130),
  };
});

const counts = {};
for (const r of rows) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
const pick = (v) => rows.filter((r) => r.verdict === v);
const physical = pick('irrelevant_physical');
const hardware = pick('hardware_only');
const ambiguous = pick('ambiguous');
// Подозрение усиливается, если в реальном тексте API тоже нет AI/IT.
const ambiguousNoAI = ambiguous.filter((r) => r.info_has_real_ai === false);

ensureDir(OUT);
writeJsonl(join(OUT, 'irrelevant-tenders.jsonl'), rows);
writeCsv(join(OUT, 'irrelevant-tenders.csv'), rows);

const mean = {
  relevant_ai: 'в названии явный AI-предмет',
  relevant_soft: 'в названии IT/софт-предмет',
  ambiguous: 'имя без IT/AI-предмета — кандидат в мусор',
  hardware_only: 'только железо (серверы/GPU/планшеты) — не продукт',
  irrelevant_physical: 'физический/строительный/товарный предмет — МУСОР',
};
const md = (v, n = 80) => String(v ?? '').replace(/\|/g, '\\|').slice(0, n);
const lines = [];
lines.push('# Нерелевантные тендеры (проблема в данных)');
lines.push('');
lines.push(`Дата: ${DATE}. Всего: ${rows.length}.`);
lines.push('');
lines.push('Причина: скорер засчитывал шаблонную фразу «технологии искусственного интеллекта»');
lines.push('из карточек закупок как AI-совпадение → погрузчики/топливо/оросители попали в дашборд');
lines.push(`как ai_core. Тендеров, где AI-совпадение ТОЛЬКО по этой фразе: **${rows.filter((r) => r.boilerplate_only_ai).length}**.`);
lines.push('');
lines.push('Вердикт строится по ПРЕДМЕТУ (tender_name) — это единственный чистый сигнал');
lines.push('(текст карточки тоже замусорен фразами про ЕИС/площадку).');
lines.push('');
lines.push('| verdict | кол-во | значение |');
lines.push('|---------|-------:|----------|');
for (const k of ['relevant_ai', 'relevant_soft', 'ambiguous', 'hardware_only', 'irrelevant_physical']) {
  if (counts[k]) lines.push(`| \`${k}\` | ${counts[k]} | ${mean[k]} |`);
}
lines.push('');
const totalNonrel = physical.length + hardware.length + ambiguous.length;
lines.push(`**Нерелевантных кандидатов: ${totalNonrel} из ${rows.length}** ` +
  `(мусор-предмет ${physical.length} + железо ${hardware.length} + неоднозначные ${ambiguous.length}; ` +
  `из неоднозначных и в тексте API нет AI/IT: ${ambiguousNoAI.length}).`);
lines.push('');

function table(title, list) {
  lines.push(`## ${title} (${list.length})`);
  lines.push('');
  lines.push('| tender_id | категория в дашборде | название | заказчик |');
  lines.push('|-----------|----------------------|----------|----------|');
  for (const r of list) lines.push(`| \`${r.tender_id}\` | ${r.product_category || r.classification} | ${md(r.tender_name)} | ${md(r.customer, 40)} |`);
  lines.push('');
}
table('МУСОР — физический/товарный/строительный предмет', physical);
table('Только железо (серверы/GPU/планшеты/периферия)', hardware);
table('Неоднозначные — нет IT/AI в названии (на проверку)', ambiguous);

lines.push('## tender_id явного мусора (physical + hardware)');
lines.push('');
lines.push('```');
for (const r of [...physical, ...hardware]) lines.push(r.tender_id);
lines.push('```');
lines.push('');

writeText(join(OUT, 'irrelevant-tenders.md'), `${lines.join('\n')}\n`);

console.log('Всего:', rows.length, '|', Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '));
console.log(`Нерелевантных кандидатов: ${totalNonrel} (мусор ${physical.length}, железо ${hardware.length}, неоднозн. ${ambiguous.length}; из них без AI в API: ${ambiguousNoAI.length})`);
console.log('boilerplate-only AI-совпадение:', rows.filter((r) => r.boilerplate_only_ai).length);
console.log('Отчёт: data/analysis/' + DATE + '/irrelevant-tenders.{md,csv,jsonl}');
