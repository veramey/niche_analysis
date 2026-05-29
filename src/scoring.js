// Единый источник правды для скоринга релевантности AI/automation-тендеров.
// Позитивные термины считаются ТОЛЬКО по предмету (название + категория) — см. find-ai-automation-tenders.js.

export const POSITIVE = [
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

export const NEGATIVE = [
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

/**
 * Считает позитивные термины ТОЛЬКО по предмету (subject = название + категория),
 * негативные — по полному тексту (haystack). Возвращает { score, matchedTerms }.
 * @param {string} subject  название + категория (нижний регистр не обязателен)
 * @param {string} haystack полный текст для негативных маркеров (по умолчанию = subject)
 * @param {boolean} hasDocumentation источник documentation → +2
 */
export function scoreSubject(subject, haystack = subject, hasDocumentation = false) {
  const subj = String(subject || '').toLowerCase();
  const hay = String(haystack || '').toLowerCase();
  const matchedTerms = [];
  let score = 0;

  for (const [points, term] of POSITIVE) {
    if (subj.includes(term)) { score += points; matchedTerms.push(term); }
  }
  for (const [points, term] of NEGATIVE) {
    if (hay.includes(term)) { score -= points; matchedTerms.push(`-${term}`); }
  }
  if (hasDocumentation) score += 2;

  return { score, matchedTerms };
}

// --- Переразметка matched_terms по ПРЕДМЕТУ (расширенный словарь синонимов) ---
// Используется для честных меток в карточках (а не как фильтр). \w → кириллица-aware.
const _S = '[а-яёa-z0-9]*';
const _rx = (s) => new RegExp(s.replace(/\\w\*?/g, _S), 'i');
export const SUBJECT_TERMS = [
  ['(искусственн\\w* интеллект|\\bии\\b|\\bии[- ]|на основе ии|с использованием ии)', 'искусственный интеллект', true],
  ['(машинн\\w* обуч|machine learning|\\bml\\b)', 'машинное обучение', true],
  ['(нейросет|нейронн\\w* сет)', 'нейросеть', true],
  ['(компьютерн\\w* зрен|computer vision)', 'компьютерное зрение', true],
  ['(больш\\w* языков\\w* модел|языков\\w* модел|\\bllm\\b|\\bgpt\\b)', 'большая языковая модель', true],
  ['(интеллектуальн\\w* помощник|чат-?бот|чатбот|виртуальн\\w* (помощник|ассистент))', 'чат-бот/ассистент', true],
  ['(голосов\\w*[ -](помощник|робот|ассистент|бот)|распознавани\\w* реч|синтез\\w* реч)', 'голосовой помощник', true],
  ['(распознавани)', 'распознавание', true],
  ['(видеоаналит)', 'видеоаналитика', true],
  ['(предиктивн|прогнозн\\w* модел)', 'предиктивная аналитика', true],
  ['(рекомендательн)', 'рекомендательная система', true],
  ['(\\brag\\b)', 'RAG', true],
  ['(\\bocr\\b|оцифров)', 'OCR/оцифровка', true],
  ['(биометри)', 'биометрия', true],
  ['(поддержк\\w*[ -]принятия[^.]{0,12}решени|поддержки врачебных решени)', 'поддержка принятия решений', true],
  ['(беспилотн|\\bбпла\\b)', 'беспилотные системы', true],
  ['(интеллектуальн\\w*[ -](анализ|транспорт|видео|поиск))', 'интеллектуальный анализ', true],
  ['(\\brpa\\b|роботизац\\w*[ -](процесс|бизнес))', 'RPA', false],
  ['(автоматизац\\w*[ -](процесс|бизнес)|автоматизац\\w* документооборот)', 'автоматизация процессов', false],
  ['(информацион\\w*[ -]систем|\\bаис\\b|\\bгис\\b|\\bасу\\b|\\bмис\\b|\\bеис\\b)', 'информационная система', false],
  ['(цифров\\w* платформ|цифров\\w* трансформац|цифровизац)', 'цифровизация', false],
  ['(больших данных|big data|обработк\\w*[ -]данных|аналитик\\w* данных)', 'аналитика данных', false],
  ['(программн\\w* обеспечен|программн\\w*-аппаратн|\\bпак\\b)', 'программное обеспечение', false],
  ['(телемедицин)', 'телемедицина', false],
].map(([s, label, ai]) => [_rx(s), label, ai]);

/** Извлекает реальные AI/IT-термины из предмета (название + категория). */
export function extractSubjectTerms(name, category = '') {
  const subject = `${name || ''} ${category || ''}`.toLowerCase();
  const terms = [];
  let core = false;
  for (const [re, label, ai] of SUBJECT_TERMS) {
    if (re.test(subject)) { terms.push(label); if (ai) core = true; }
  }
  return { terms, core };
}

export function classify(terms, score) {
  const joined = terms.join(' ');
  if (/(искусственный интеллект|машинное обучение|нейронная сеть|нейросеть|компьютерное зрение|распознавание|предиктивная аналитика|интеллектуальный анализ)/i.test(joined)) {
    return 'ai_core';
  }
  if (/(автоматизация|rpa|bpm|bpms|workflow|информационной системы)/i.test(joined)) {
    return 'automation_software';
  }
  return score >= 3 ? 'software_related' : 'noise';
}

/**
 * Переразмечает один тендер по предмету: matched_terms / classification / reason.
 * Мутирует и возвращает объект. Не понижает в noise (doc/has_card → минимум software_related).
 * @param {(name:string)=>string} clean функция очистки текста (например cleanText)
 */
export function relabelTender(t, clean = (x) => String(x ?? '')) {
  const { terms, core } = extractSubjectTerms(clean(t.tender_name), t.category || '');
  const hasDoc = /documentation/i.test(String(t.sources || ''));
  let cls;
  if (core) cls = 'ai_core';
  else if (terms.length) cls = 'automation_software';
  else cls = (hasDoc || t.has_card) ? 'software_related' : (t.classification || 'software_related');

  t.matched_terms = terms.join('; ');
  t.classification = cls;
  t.reason = terms.length
    ? `найдено в названии; совпадения: ${terms.slice(0, 5).join(', ')}`
    : (hasDoc ? 'найдено в документации; в названии AI-термин отсутствует'
      : 'AI-предмет не выявлен в названии (оставлен по прежней классификации)');
  return t;
}

/** Текст-обоснование для карточки. */
export function buildReason(matchedTerms, { hasDocumentation = false, infoLength = 0, subjectMatched = true } = {}) {
  const terms = matchedTerms.filter((t) => !t.startsWith('-')).slice(0, 4).join(', ');
  const source = !subjectMatched && hasDocumentation
    ? 'найдено в документации; в названии AI-термин отсутствует'
    : (hasDocumentation ? 'найдено также в документации' : 'найдено в карточке/названии');
  const context = infoLength ? `; карточка содержит ${Math.min(infoLength, 500)} символов описания` : '';
  return `${source}; совпадения: ${terms || 'нет'}${context}`;
}
