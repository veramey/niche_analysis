import { readFileSync, existsSync } from 'node:fs';

/**
 * Загружает блок-лист нерелевантных тендеров (мусора) для указанной даты.
 * Файл: data/analysis/{date}/blocklist.txt — по одному tender_id в строке,
 * пустые строки и строки с '#' игнорируются.
 * Возвращает Set строк (tender_id / card_id).
 */
export function loadBlocklist(date) {
  const path = `data/analysis/${date}/blocklist.txt`;
  if (!existsSync(path)) return new Set();
  const ids = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
  return new Set(ids);
}

/** Отфильтровывает тендеры, чей tender_id или tenderguru_card_id попал в блок-лист. */
export function filterBlocked(tenders, blocklist) {
  if (!blocklist || !blocklist.size) return tenders;
  return tenders.filter(
    (t) => !blocklist.has(String(t.tender_id)) && !blocklist.has(String(t.tenderguru_card_id)),
  );
}
