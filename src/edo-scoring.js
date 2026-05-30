const DOMAIN_TERMS = [
  ['электронный документооборот', 8],
  ['электронного документооборота', 8],
  ['система электронного документооборота', 9],
  ['сэд', 7],
  ['ecm', 6],
  ['делопроизводство', 6],
  ['документооборот', 6],
  ['архив документов', 6],
  ['электронный архив', 6],
  ['входящая корреспонденция', 5],
  ['исходящая корреспонденция', 5],
  ['регистрация документов', 5],
  ['маршрутизация документов', 5],
  ['согласование документов', 5],
  ['исполнение поручений', 4],
  ['канцелярия', 4],
  ['резолюция', 3],
];

const AI_AUTOMATION_TERMS = [
  ['искусственный интеллект', 10],
  ['технологии искусственного интеллекта', 10],
  ['машинное обучение', 9],
  ['нейронная сеть', 9],
  ['нейросеть', 9],
  ['llm', 8],
  ['большая языковая модель', 8],
  ['rag', 8],
  ['ocr', 8],
  ['распознавание документов', 9],
  ['распознавание текста', 8],
  ['извлечение реквизитов', 9],
  ['извлечение данных', 7],
  ['классификация документов', 9],
  ['автоматическая классификация', 8],
  ['интеллектуальный поиск', 8],
  ['семантический поиск', 8],
  ['суммаризация', 7],
  ['автоматизация документооборота', 8],
  ['автоматизации документооборота', 8],
  ['автоматизация делопроизводства', 8],
  ['автоматизации делопроизводства', 8],
  ['автоматизированная система', 6],
  ['автоматизированной системы', 6],
  ['автоматизация процессов', 6],
  ['автоматизация бизнес-процессов', 6],
  ['роботизация', 6],
  ['rpa', 6],
  ['workflow', 4],
  ['маршрутизация', 3],
];

const GENERIC_PLATFORM_TERMS = [
  ['внедрение', 3],
  ['развитие', 3],
  ['модернизация', 3],
  ['доработка', 3],
  ['сопровождение', 2],
  ['техническая поддержка', 2],
  ['лицензия', 1],
  ['право использования', 1],
];

const NEGATIVE_TERMS = [
  ['электронная площадка', 10],
  ['электронные торги', 10],
  ['заявка в электронной форме', 8],
  ['электронная подпись', 8],
  ['электронной подписи', 8],
  ['сертификат ключа', 8],
  ['оператор электронного документооборота', 7],
  ['обмен счетами-фактурами', 7],
  ['такском', 5],
  ['контур.диадок', 5],
  ['диадок', 5],
  ['сбис', 5],
  ['контур.экстерн', 5],
  ['эдо с контрагентами', 4],
  ['поставка лицензий', 4],
  ['продление лицензий', 4],
];

const STRONG_DOCUMENT_AI = [
  'ocr',
  'распознавание документов',
  'распознавание текста',
  'извлечение реквизитов',
  'классификация документов',
  'автоматическая классификация',
  'интеллектуальный поиск',
  'семантический поиск',
  'суммаризация',
  'rag',
  'llm',
  'большая языковая модель',
];

export const EDO_QUERIES = [
  { query: '"электронный документооборот"', group: 'edo_core' },
  { query: '"электронного документооборота"', group: 'edo_core' },
  { query: '"система электронного документооборота"', group: 'edo_core' },
  { query: 'СЭД', group: 'edo_core' },
  { query: 'ECM', group: 'edo_core' },
  { query: 'делопроизводство', group: 'edo_core' },
  { query: '"архив документов"', group: 'edo_archive' },
  { query: '"электронный архив"', group: 'edo_archive' },
  { query: '"согласование документов"', group: 'edo_workflow' },
  { query: '"маршрутизация документов"', group: 'edo_workflow' },
  { query: '"регистрация документов"', group: 'edo_workflow' },
  { query: '"распознавание документов"', group: 'document_ai' },
  { query: '"распознавание текста"', group: 'document_ai' },
  { query: '"извлечение реквизитов"', group: 'document_ai' },
  { query: '"классификация документов"', group: 'document_ai' },
  { query: '"автоматическая классификация"', group: 'document_ai' },
  { query: '"интеллектуальный поиск"', group: 'document_ai' },
  { query: '"автоматизация документооборота"', group: 'edo_automation' },
  { query: 'OCR', group: 'document_ai' },
  { query: 'RPA документооборот', group: 'edo_automation' },
  { query: 'LLM документы', group: 'document_ai' },
  { query: 'RAG документы', group: 'document_ai' },
];

export function scoreEdoCandidate(candidate) {
  const text = normalize([
    candidate.name,
    candidate.customer,
    candidate.fz,
    candidate.status,
    candidate.cardText,
    candidate.docsText,
  ].join('\n'));

  const domainMatches = collectMatches(text, DOMAIN_TERMS);
  const aiMatches = collectMatches(text, AI_AUTOMATION_TERMS);
  const platformMatches = collectMatches(text, GENERIC_PLATFORM_TERMS);
  const negativeMatches = collectMatches(text, NEGATIVE_TERMS);

  const domainScore = sumScores(domainMatches);
  const aiScore = sumScores(aiMatches);
  const platformScore = sumScores(platformMatches);
  const negativeScore = sumScores(negativeMatches);
  const strongAi = aiMatches.some((match) => STRONG_DOCUMENT_AI.includes(match.term));
  const hasDomain = domainScore > 0;
  const hasAiAutomation = aiScore > 0;

  let classification = 'noise';
  if (hasDomain && strongAi) {
    classification = 'document_ai';
  } else if (hasDomain && hasAiAutomation && hasAny(text, ['маршрутизация', 'согласование', 'workflow', 'исполнение поручений'])) {
    classification = 'edo_workflow_ai';
  } else if (hasDomain && hasAiAutomation) {
    classification = 'edo_automation';
  } else if (hasDomain && platformScore > 0) {
    classification = 'edo_platform_generic';
  } else if (!hasDomain && strongAi && hasAny(text, ['документ', 'текст', 'реквизит', 'архив'])) {
    classification = 'document_ai';
  }

  if (negativeScore >= 10 && !strongAi) {
    classification = ['edo_platform_generic', 'edo_automation'].includes(classification)
      ? 'integration_only'
      : 'noise';
  }

  const sourceBonus = hasAnySource(candidate.sources, 'attached_file') ? 3 : 0;
  const score = domainScore + aiScore + platformScore + sourceBonus - negativeScore;
  const positiveTerms = [...domainMatches, ...aiMatches, ...platformMatches].map((m) => m.term);
  const negativeTerms = negativeMatches.map((m) => m.term);

  return {
    score,
    classification,
    domain_terms: unique(domainMatches.map((m) => m.term)),
    ai_automation_terms: unique(aiMatches.map((m) => m.term)),
    platform_terms: unique(platformMatches.map((m) => m.term)),
    negative_terms: unique(negativeTerms),
    relevant: !['noise', 'integration_only'].includes(classification) && score >= 5,
    reason: buildReason(classification, positiveTerms, negativeTerms, candidate.sources),
  };
}

export function isEdoRelevant(scored) {
  return Boolean(scored?.relevant);
}

function buildReason(classification, positiveTerms, negativeTerms, sources) {
  const sourceText = hasAnySource(sources, 'attached_file')
    ? 'найдено в карточке/документах ЕИС'
    : 'найдено в карточке ЕИС';
  const pos = unique(positiveTerms).slice(0, 8).join(', ') || 'нет';
  const neg = unique(negativeTerms).slice(0, 4).join(', ');
  return `${sourceText}; класс=${classification}; совпадения: ${pos}${neg ? `; минус-слова: ${neg}` : ''}`;
}

function collectMatches(text, terms) {
  return terms
    .filter(([term]) => hasTerm(text, term))
    .map(([term, points]) => ({ term, points }));
}

function hasTerm(text, term) {
  const value = normalize(term).replace(/^"|"$/g, '');
  if (/^[a-z0-9]+$/i.test(value)) {
    return new RegExp(`(^|[^a-z0-9а-яё])${escapeRegExp(value)}([^a-z0-9а-яё]|$)`, 'i').test(text);
  }
  return text.includes(value);
}

function hasAny(text, terms) {
  return terms.some((term) => hasTerm(text, term));
}

function hasAnySource(sources, source) {
  return arrayValue(sources).includes(source);
}

function sumScores(matches) {
  return matches.reduce((sum, match) => sum + match.points, 0);
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function arrayValue(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return [...value];
  return [value];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
