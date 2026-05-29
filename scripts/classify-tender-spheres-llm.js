#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { loadDotEnv } from '../src/env.js';
import {
  appendJsonl,
  cleanText,
  ensureDir,
  writeCsv,
  writeJsonl,
  writeText,
} from '../src/export-utils.js';

loadDotEnv();

const runDate = getArg('date', '2026-05-25');
const limit = Number(getArg('limit', '0'));
const offset = Number(getArg('offset', '0'));
const model = getArg('model', process.env.OPENAI_MODEL || 'gpt-4.1-mini');
const force = getFlag('force');
const dryRun = getFlag('dry-run');
const refreshOnly = getFlag('refresh-only');
const localFill = getFlag('local-fill');
const rebuildLocal = getFlag('rebuild-local');

const processedDir = `data/processed/${runDate}`;
const analysisDir = `data/analysis/${runDate}`;
const classifiedPath = getArg('input', `${processedDir}/classified-tenders.csv`);
const fullPath = getArg('full-input', `${processedDir}/full-tenders.csv`);
const outJsonl = getArg('output', `${analysisDir}/sphere-classifications.jsonl`);
const outCsv = getArg('csv-output', `${analysisDir}/sphere-classifications.csv`);
const mergedCsv = getArg('merged-output', `${processedDir}/classified-tenders-with-spheres.csv`);
const summaryPath = getArg('summary-output', `${analysisDir}/sphere-classifications-summary.md`);

const sphereLabels = {
  healthcare: 'Медицина',
  construction: 'Строительство',
  transport_logistics: 'Транспорт / логистика',
  utilities: 'ЖКХ / коммунальная инфраструктура',
  security: 'Безопасность',
  education_science: 'Образование / наука',
  industry_energy: 'Промышленность / энергетика',
  finance_insurance: 'Финансы / страхование',
  retail_commerce: 'Ритейл / коммерция',
  telecom_media: 'Телеком / медиа / связь',
  culture_sport: 'Культура / спорт / туризм',
  agriculture_ecology: 'АПК / экология',
  social_services: 'Социальная поддержка / занятость',
  public_admin: 'Госуправление',
  it_internal: 'Внутренняя ИТ-автоматизация',
  other: 'Другое / неясно',
};

const sphereCodes = Object.keys(sphereLabels);
const confidenceValues = ['high', 'medium', 'low'];

ensureDir(analysisDir);

const classifiedRows = parseCsv(await readFile(classifiedPath, 'utf8'));
const fullRows = existsSync(fullPath) ? parseCsv(await readFile(fullPath, 'utf8')) : [];
const fullLookup = buildLookup(fullRows);
const rows = classifiedRows.map((row) => mergeTender(row, fullLookup));
const cache = readJsonlMap(outJsonl);
if (rebuildLocal) {
  for (const [key, item] of [...cache.entries()]) {
    if (item.source === 'codex_local_classifier') cache.delete(key);
  }
}
const pendingRows = rows
  .slice(offset, limit > 0 ? offset + limit : undefined)
  .filter((row) => force || !cache.has(rowKey(row)));

console.log(`Dataset: ${classifiedPath}`);
console.log(`Rows: ${rows.length}`);
console.log(`Full enrichment rows: ${fullRows.length}`);
console.log(`Cached classifications: ${cache.size}`);
console.log(`Pending in this run: ${pendingRows.length}`);
console.log(`Model: ${model}`);

if (dryRun) {
  const sample = pendingRows[0] || rows[offset] || rows[0];
  if (!sample) throw new Error('No rows found.');
  console.log('\n--- Dry-run prompt sample ---\n');
  console.log(buildUserPrompt(sample));
  process.exit(0);
}

if (refreshOnly) {
  writeOutputs(rows, cache);
  process.exit(0);
}

if (localFill) {
  for (const row of pendingRows) {
    const classification = classifyTenderLocally(row);
    cache.set(rowKey(row), classification);
    appendJsonl(outJsonl, classification);
  }

  writeOutputs(rows, cache);
  process.exit(0);
}

if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is required. Add it to .env or export it in the shell.');
}

for (let index = 0; index < pendingRows.length; index += 1) {
  const row = pendingRows[index];
  const key = rowKey(row);
  process.stdout.write(`[${index + 1}/${pendingRows.length}] ${key}... `);

  try {
    const classification = await classifyTender(row);
    cache.set(key, classification);
    appendJsonl(outJsonl, classification);
    process.stdout.write(`${classification.sphere} ${classification.confidence}\n`);
  } catch (error) {
    const failed = fallbackClassification(row, error);
    cache.set(key, failed);
    appendJsonl(outJsonl, failed);
    process.stdout.write(`failed: ${cleanText(error.message)}\n`);
  }
}

writeOutputs(rows, cache);

function writeOutputs(allRows, classifications) {
  const ordered = allRows
    .map((row) => classifications.get(rowKey(row)))
    .filter(Boolean);
  const compact = ordered.map(compactClassification);

  writeJsonl(outJsonl, ordered);
  writeCsv(outCsv, compact);

  const mergedRows = allRows.map((row) => {
    const classification = classifications.get(rowKey(row));
    const {
      info_text: _infoText,
      products_text: _productsText,
      delivery_place: _deliveryPlace,
      region_id: _regionId,
      ...outputRow
    } = row;

    return {
      ...outputRow,
      sphere: classification?.sphere || '',
      sphere_label: classification?.sphere_label || '',
      sphere_confidence: classification?.confidence || '',
      sphere_evidence: classification?.evidence || '',
      secondary_spheres: (classification?.secondary_spheres || []).join('; '),
      sphere_needs_review: classification ? String(Boolean(classification.needs_review)) : '',
    };
  });

  writeCsv(mergedCsv, mergedRows);
  writeText(summaryPath, renderSummary(ordered, allRows.length));

  console.log(`\nWrote ${outJsonl}`);
  console.log(`Wrote ${outCsv}`);
  console.log(`Wrote ${mergedCsv}`);
  console.log(`Wrote ${summaryPath}`);
}

async function classifyTender(row) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: systemPrompt() }],
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: buildUserPrompt(row) }],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'tender_sphere_classification',
          strict: true,
          schema: classificationSchema(),
        },
      },
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error?.message || `OpenAI API error ${response.status}`);
  }

  const text = extractOutputText(body);
  const parsed = JSON.parse(text);
  return normalizeClassification(row, parsed, 'llm');
}

function systemPrompt() {
  return `Ты классифицируешь российские тендеры по сфере применения решения.

Выбери ровно одну основную сферу из фиксированного списка:
${Object.entries(sphereLabels).map(([code, label]) => `- ${code}: ${label}`).join('\n')}

Правила:
- Определяй отрасль применения, а не тип закупаемого продукта.
- Если больница закупает ИИ/ПО, выбирай healthcare, а не it_internal или public_admin.
- Если город закупает систему для парковок, транспорта, ПДД или маршрутов, выбирай transport_logistics.
- Если закупка относится к водоканалу, ЖКХ, ресурсоснабжению или обращениям жителей, выбирай utilities.
- public_admin используй для ведомственных/муниципальных процессов без более конкретной отрасли.
- it_internal используй, когда видна только внутренняя ИТ-задача: лицензии, поддержка ПО, интеграция, портал, база данных, без отраслевой специфики.
- other используй только когда сфера действительно неясна.
- secondary_spheres может быть пустым массивом или содержать до 3 дополнительных кода.
- evidence объясняет выбор одной короткой фразой на русском.
- needs_review=true для low confidence или когда конкурируют две близкие сферы.`;
}

function buildUserPrompt(row) {
  const payload = {
    tender_id: row.tender_id || '',
    tenderguru_card_id: row.tenderguru_card_id || '',
    tender_name: row.tender_name || row.name || '',
    customer: row.customer || '',
    customer_inn: row.customer_inn || '',
    category: row.category || '',
    region: row.region || '',
    price: row.price || row.price_rub || '',
    niche: row.niche || '',
    classification: row.classification || '',
    matched_terms: row.matched_terms || '',
    query_groups: row.query_groups || row.groups || '',
    reason: row.reason || '',
    products_text: truncate(row.products_text, 1200),
    info_text: truncate(row.info_text, 2500),
  };

  return `Классифицируй сферу применения тендера. Верни только JSON по схеме.

${JSON.stringify(payload, null, 2)}`;
}

function classificationSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'sphere',
      'sphere_label',
      'confidence',
      'evidence',
      'secondary_spheres',
      'needs_review',
    ],
    properties: {
      sphere: { type: 'string', enum: sphereCodes },
      sphere_label: { type: 'string' },
      confidence: { type: 'string', enum: confidenceValues },
      evidence: { type: 'string', minLength: 1, maxLength: 300 },
      secondary_spheres: {
        type: 'array',
        maxItems: 3,
        items: { type: 'string', enum: sphereCodes },
      },
      needs_review: { type: 'boolean' },
    },
  };
}

function normalizeClassification(row, raw, source) {
  const sphere = sphereCodes.includes(raw.sphere) ? raw.sphere : 'other';
  const confidence = confidenceValues.includes(raw.confidence) ? raw.confidence : 'low';
  const secondary = Array.isArray(raw.secondary_spheres)
    ? raw.secondary_spheres.filter((item) => sphereCodes.includes(item) && item !== sphere).slice(0, 3)
    : [];

  return {
    tender_id: row.tender_id || '',
    tenderguru_card_id: row.tenderguru_card_id || '',
    tender_name: row.tender_name || row.name || '',
    customer: row.customer || '',
    sphere,
    sphere_label: sphereLabels[sphere],
    confidence,
    evidence: truncate(cleanText(raw.evidence || ''), 300) || 'Нет объяснения от модели.',
    secondary_spheres: secondary,
    needs_review: Boolean(raw.needs_review) || confidence === 'low',
    model,
    source,
    classified_at: new Date().toISOString(),
  };
}

function fallbackClassification(row, error) {
  return normalizeClassification(row, {
    sphere: 'other',
    confidence: 'low',
    evidence: `Ошибка классификации: ${cleanText(error.message).slice(0, 220)}`,
    secondary_spheres: [],
    needs_review: true,
  }, 'error');
}

function classifyTenderLocally(row) {
  const text = [
    row.tender_name,
    row.customer,
    row.category,
  ].map((value) => cleanText(value).toLowerCase()).join(' ');

  const exact = localRule(row, text);
  return normalizeClassification(row, exact, 'codex_local_classifier');
}

function localRule(row, text) {
  if (has(text, /здравоохран|медицин|врачеб|пациент|поликлиник|больниц|клиник|егисз|рентген|маммограф|томограф|кт\b|мрт|webiomed|радиолог|флюорограмм|дерматоскоп|хирург|онколог|кардиолог|электронн[а-я ]+медицинск|истори[яи] болезни/)) {
    return localResult('healthcare', 'high', 'Предмет или заказчик явно относится к медицинским системам, учреждениям или врачебным решениям.');
  }

  if (has(text, /детск[а-я ]+сад|школ|лицей|университет|колледж|образован|учебн|студент|аттестат|фгос|кафедр|семинар.*образовательн|повышени[ея] квалификац|научн|исследовательск|академ|институт искусственного интеллекта|профессии будущего|имц/)) {
    return localResult('education_science', 'high', 'Сфера применения связана с образовательным или научным учреждением, обучением или учебными системами.');
  }

  if (has(text, /егрн|реестр недвижимости|роскадастр|кадастр|строитель|капитальн|ремонт|благоустрой|жк форум|(?:^|[\s«"])дск(?:[\s»"_-]|$)|геолог|геодез|проектн[о-]смет|строительный колледж|реновац|многоквартирн/)) {
    return localResult('construction', 'high', 'Сфера применения связана со строительством, недвижимостью, благоустройством или кадастровыми данными.');
  }

  if (has(text, /транспорт|логистик|перевоз|грузов|парков|проезд|дорог|пдд|росморпорт|водител|транспортн[а-я ]+модель|сбертранспорт|автопарк|погрузчик|распределительн[а-я ]+центр/)) {
    return localResult('transport_logistics', 'high', 'Предмет относится к транспорту, логистике, парковкам, дорожному движению или транспортным системам.');
  }

  if (has(text, /водоканал|жкх|коммуналь|ресурсоснаб|теплоснаб|водоснаб|газоснаб|мособлгаз|городское хозяйство|обращени[йя] жителей/)) {
    return localResult('utilities', 'high', 'Заказчик или предмет связан с ЖКХ, ресурсоснабжением или коммунальной инфраструктурой.');
  }

  if (has(text, /безопасн|видеонаблюден|безопасный город|безопасный регион|мвд|защиты информации|vipnet|фстэк|фсб|распознавани[ея] лиц|пожар|возгоран|задымлен|скуд|охран|антитеррор/)) {
    return localResult('security', 'high', 'Предмет относится к безопасности, видеонаблюдению, защите информации или системам предупреждения инцидентов.');
  }

  if (has(text, /росатом|атомн|энергет|энерго|электроэнерг|электросет|(?:^|[\s«"])тэк(?:[\s»"_-]|$)|нефт|газпром|газов|газоснаб|нефтегаз|нпз|металлург|металлообраб|машиностро|промышлен|производствен|завод|цех|таиф|фосагро|апатит|метафракс|форвард энерго|т плюс|сетевая компания|фск еэс|чмз|свеза|сегеж|алюминиев|дизельн|топлив|горнодобыв|золото|азот|фракджет/)) {
    return localResult('industry_energy', 'high', 'Сфера применения связана с промышленностью, энергетикой, производством или ТЭК.');
  }

  if (has(text, /банк|банковск|взыскани[ея]|задолженност|лизинг|финанс|бюджет|казнач|счетн[а-я ]+палат|бухгалтер|страхован|сбис|контур\.фокус/)) {
    return localResult('finance_insurance', 'high', 'Предмет относится к финансовым, бюджетным, банковским или страховым процессам.');
  }

  if (has(text, /лента|metro|метро кэш|ритейл|магазин|торгов|ecommerce|екоммерц|лакс[а ]+трейдинг|sokolov|байрам/)) {
    return localResult('retail_commerce', 'high', 'Заказчик или предмет связан с ритейлом, торговлей или коммерческой e-commerce площадкой.');
  }

  if (has(text, /т2 мобайл|телеком|связь|телефон|sip|атс|медиа|видеоконтент|пресс-центр|соцсет|паблик|интернет|трансляц|контент/)) {
    return localResult('telecom_media', 'high', 'Сфера применения связана с телекомом, медиа, связью или публичными коммуникациями.');
  }

  if (has(text, /культур|музе|эрмитаж|театр|библиотек|архив|спорт|физическ[а-я ]+культур|дворец культуры|дом культуры|киностуд|музыкальн[а-я ]+школ|туризм|экспозицион|выставоч/)) {
    return localResult('culture_sport', 'high', 'Предмет относится к культуре, спорту, музеям, медиаархивам или выставочной деятельности.');
  }

  if (has(text, /эколог|природ|лесн|лесных пожаров|национальн[а-я ]+парк|агро|сельск|ветеринар|растени|животн|дзз|дистанционн[а-я ]+зондирован|природных ресурсов/)) {
    return localResult('agriculture_ecology', 'high', 'Сфера связана с экологией, природными ресурсами, лесами, АПК или мониторингом окружающей среды.');
  }

  if (has(text, /социальн|занятост|инвалид|доступная среда|пенсионн|социального страхования|центр занятости|детск[а-я ]+дом|служб[аы] занятости/)) {
    return localResult('social_services', 'high', 'Предмет относится к социальной поддержке, занятости, инвалидам или социальным учреждениям.');
  }

  if (has(text, /администрац|правительств|министерств|департамент|муниципаль|государственн[а-я ]+функц|мфц|орган[а-я ]+местного самоуправления|госуправ|госзаказ|региональн[а-я ]+центр закупок|федеральн[а-я ]+служб|фас|росфинмониторинг|мид россии|центр цифровой трансформации|государственн[а-я ]+информационн[а-я ]+систем/)) {
    return localResult('public_admin', 'high', 'Сфера применения относится к государственным или муниципальным процессам без более конкретной отрасли.');
  }

  if (has(text, /rpa|service ?desk|llm|языков[а-я ]+модел|нейросет|битрикс|bpmsoft|pix|лицензи|поддержк[а-я ]+по|программн[а-я ]+обеспеч|информационн[а-я ]+систем|вычислительн[а-я ]+платформ|gpu|сервер|корпоративн[а-я ]+платформ|контактн[а-я ]+центр/)) {
    return localResult('it_internal', 'medium', 'Видна ИТ-задача или лицензия, но прикладная отрасль не раскрыта достаточно явно.', true);
  }

  return localResult('other', 'low', 'По доступным полям недостаточно данных для уверенного определения сферы.', true);
}

function localResult(sphere, confidence, evidence, needsReview = confidence !== 'high') {
  return {
    sphere,
    confidence,
    evidence,
    secondary_spheres: [],
    needs_review: needsReview,
  };
}

function has(text, pattern) {
  return pattern.test(text);
}

function compactClassification(item) {
  return {
    tender_id: item.tender_id,
    tenderguru_card_id: item.tenderguru_card_id,
    tender_name: item.tender_name,
    customer: item.customer,
    sphere: item.sphere,
    sphere_label: item.sphere_label,
    confidence: item.confidence,
    evidence: item.evidence,
    secondary_spheres: item.secondary_spheres.join('; '),
    needs_review: String(item.needs_review),
    model: item.model,
    source: item.source,
    classified_at: item.classified_at,
  };
}

function renderSummary(items, totalRows) {
  const bySphere = countBy(items, 'sphere');
  const byConfidence = countBy(items, 'confidence');
  const reviewCount = items.filter((item) => item.needs_review).length;

  const lines = [
    '# Tender Sphere Classifications',
    '',
    `Date: ${runDate}`,
    `Rows in source dataset: ${totalRows}`,
    `Classified rows: ${items.length}`,
    `Needs review: ${reviewCount}`,
    `Model: ${model}`,
    '',
    '## By Sphere',
    '',
    '| Sphere | Label | Count |',
    '|---|---|---:|',
  ];

  for (const [sphere, count] of Object.entries(bySphere).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${sphere} | ${sphereLabels[sphere] || ''} | ${count} |`);
  }

  lines.push('', '## By Confidence', '');
  for (const [confidence, count] of Object.entries(byConfidence).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${confidence}: ${count}`);
  }

  return `${lines.join('\n')}\n`;
}

function mergeTender(row, lookup) {
  const full = lookup.get(row.tender_id)
    || lookup.get(row.tenderguru_card_id)
    || lookup.get(row.tender_num_outer)
    || {};

  return {
    ...row,
    info_text: full.info_text || '',
    products_text: full.products_text || '',
    delivery_place: full.delivery_place || '',
    region_id: full.region_id || '',
  };
}

function buildLookup(rows) {
  const map = new Map();

  for (const row of rows) {
    for (const key of [row.tender_id, row.tenderguru_card_id, row.tender_num, row.tender_num_outer].filter(Boolean)) {
      if (!map.has(key)) map.set(key, row);
    }
  }

  return map;
}

function readJsonlMap(path) {
  if (!existsSync(path)) return new Map();

  try {
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    const map = new Map();
    for (const line of lines) {
      const item = JSON.parse(line);
      map.set(rowKey(item), item);
    }
    return map;
  } catch {
    return new Map();
  }
}

function rowKey(row) {
  return row.tender_id || row.tenderguru_card_id || row.tender_num_outer || row.tender_name || row.name || '';
}

function extractOutputText(response) {
  if (response.output_text) return response.output_text;

  const chunks = [];
  for (const output of response.output || []) {
    for (const content of output.content || []) {
      if (content.type === 'output_text' && content.text) chunks.push(content.text);
      if (content.type === 'text' && content.text) chunks.push(content.text);
    }
  }

  const text = chunks.join('').trim();
  if (!text) throw new Error('OpenAI response did not include output text.');
  return text;
}

function truncate(value, maxLength) {
  const text = cleanText(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] || '(empty)';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function parseCsv(content) {
  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (inQuotes && char === '"' && next === '"') {
      field += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && char === ',') {
      record.push(field);
      field = '';
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') index += 1;
      record.push(field);
      records.push(record);
      field = '';
      record = [];
      continue;
    }

    field += char;
  }

  if (field || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const [headers, ...data] = records.filter((item) => item.some((value) => value !== ''));
  if (!headers) return [];

  return data.map((item) => Object.fromEntries(headers.map((header, index) => [header, item[index] || ''])));
}

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function getFlag(name) {
  return process.argv.includes(`--${name}`) || process.argv.includes(`--${name}=1`);
}
