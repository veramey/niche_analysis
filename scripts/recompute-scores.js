/**
 * Переразметка matched_terms / classification / reason для тендеров дашборда по ПРЕДМЕТУ
 * (название + категория) — без ре-прогона discovery и без обращения к API.
 *
 * Зачем: старое matched_terms часто = boilerplate-фраза «искусственный интеллект» (из карточки/
 * поискового запроса), что выглядело как ложное совпадение. Здесь пишем РЕАЛЬНЫЕ AI/IT-термины,
 * присутствующие в названии (через src/scoring.js: relabelTender / extractSubjectTerms).
 *
 * Та же логика встроена в build-static.js и serve-analysis.js, поэтому метки переживают пересборку.
 *
 * Использование: node scripts/recompute-scores.js [--dry-run]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { relabelTender } from '../src/scoring.js';
import { cleanText } from '../src/export-utils.js';

const DRY = process.argv.includes('--dry-run');
const PATH = join('public/data', 'tenders.json');
const tenders = JSON.parse(readFileSync(PATH, 'utf8'));

const before = {}; const after = {}; let changed = 0;
for (const t of tenders) {
  const prev = `${t.classification}|${t.matched_terms}`;
  before[t.classification || ''] = (before[t.classification || ''] || 0) + 1;
  relabelTender(t, cleanText);
  after[t.classification] = (after[t.classification] || 0) + 1;
  if (`${t.classification}|${t.matched_terms}` !== prev) changed += 1;
}

console.log(`Тендеров: ${tenders.length}. Изменено: ${changed}.`);
console.log('classification ДО :', JSON.stringify(before));
console.log('classification ПОСЛЕ:', JSON.stringify(after));
const r = tenders.find((x) => x.tender_id === '32616028314');
console.log('Референс Rosseti:', r ? `${r.classification} | ${r.matched_terms}` : 'нет');

if (DRY) console.log('\n[dry-run] Файл не изменён.');
else { writeFileSync(PATH, JSON.stringify(tenders)); console.log(`\nЗаписано в ${PATH}.`); }
