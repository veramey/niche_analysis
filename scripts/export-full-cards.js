#!/usr/bin/env node
/**
 * Collects the maximum available TenderGuru data for all discovered tenders.
 * - Reuses already-fetched cards from tender-cards.jsonl
 * - Fetches missing cards by tenderguru_card_id
 * - Flattens all available fields into full-tenders.jsonl + full-tenders.csv
 */
import { readFile } from 'node:fs/promises';
import { loadDotEnv } from '../src/env.js';
import { TenderGuruClient } from '../src/tenderguru-client.js';
import {
  appendJsonl,
  cleanText,
  ensureDir,
  normalizeDocs,
  redactSecretsDeep,
  writeCsv,
  writeJsonl,
} from '../src/export-utils.js';

loadDotEnv();

const runDate = getArg('date', '2026-05-25');
const processedDir = `data/processed/${runDate}`;
const rawDir = `data/raw/tenderguru/${runDate}`;

ensureDir(processedDir);

const classifiedPath = `${processedDir}/classified-tenders.csv`;
const cardsPath = `${rawDir}/tender-cards.jsonl`;
const outJsonl = `${processedDir}/full-tenders.jsonl`;
const outCsv = `${processedDir}/full-tenders.csv`;

const client = new TenderGuruClient();

// --- Load existing raw cards, keyed by every ID we can find ---
const cardCache = new Map(); // id -> card object

const rawLines = (await readFile(cardsPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
for (const line of rawLines) {
  const { response } = JSON.parse(line);
  const cards = Array.isArray(response) ? response.filter(i => i && !i.Total) : (response ? [response] : []);
  for (const card of cards) {
    if (card.ID) cardCache.set(String(card.ID), card);
  }
}
console.log(`Loaded ${cardCache.size} cached cards`);

// --- Load classified tenders ---
function parseCsv(text) {
  const lines = text.trim().split('\n');
  const headers = parseCsvRow(lines[0]);
  return lines.slice(1).map(line => Object.fromEntries(headers.map((h, i) => [h, parseCsvRow(line)[i] ?? ''])));
}
function parseCsvRow(line) {
  const cells = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && !inQ) { inQ = true; continue; }
    if (c === '"' && inQ) { if (line[i+1] === '"') { cur += '"'; i++; continue; } inQ = false; continue; }
    if (c === ',' && !inQ) { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  return cells;
}

const classified = parseCsv(await readFile(classifiedPath, 'utf8'));
console.log(`Processing ${classified.length} tenders`);

writeJsonl(outJsonl, []);

let fetched = 0, cached = 0, failed = 0;
const rows = [];

for (const c of classified) {
  const tgCardId = c.tenderguru_card_id;
  const tenderId = c.tender_id !== '0' ? c.tender_id : '';

  // Try to find card in cache
  let card = cardCache.get(tgCardId) || cardCache.get(tenderId) || null;

  // Fetch if missing
  if (!card && (tgCardId || tenderId)) {
    try {
      const id = tgCardId || tenderId;
      const res = await client.getTenderById(id);
      card = Array.isArray(res) ? res.find(i => i && !i.Total) || null : res || null;
      if (card?.ID) cardCache.set(String(card.ID), card);
      fetched++;
      if (fetched % 20 === 0) console.log(`  fetched ${fetched} new cards…`);
    } catch {
      failed++;
    }
  } else if (card) {
    cached++;
  }

  const row = buildRow(c, card || {});
  rows.push(row);
  appendJsonl(outJsonl, row);
}

writeCsv(outCsv, rows);

console.log(`\nDone: ${cached} from cache, ${fetched} freshly fetched, ${failed} failed`);
console.log(`Output: ${outJsonl}`);
console.log(`Output: ${outCsv}`);

// --- Build flattened row from classified + full card ---
function buildRow(c, card) {
  const info = cleanText(card.Info || '');
  const products = parseProducts(card.productsXML);
  const docs = normalizeDocs(card.docsXML);
  const apiInfo = parseApiInfo(card.ApiTenderInfo || '');

  return {
    // Identity
    tender_id: (c.tender_id !== '0' ? c.tender_id : '') || card.ID || '',
    tenderguru_card_id: c.tenderguru_card_id || card.ID || '',
    tender_num: card.TenderNumOuter || c.tender_num_outer || '',

    // Basic metadata
    tender_name: cleanText(card.TenderName || c.tender_name || ''),
    date: card.Date || c.date || '',
    end_time: card.EndTime || c.end_time || '',
    bidding_date: card.biddingDate || '',
    request_end_date: card.request_receiving_end_date || '',

    // Customer
    customer: cleanText(card.Customer || c.customer || ''),
    customer_inn: card.CustomerINN || c.customer_inn || '',
    contact_name: cleanText(card.contactName || ''),
    contact_email: card.contactEmail || '',
    contact_phone: card.contactPhone || '',

    // Location
    region: cleanText(card.Region || c.region || ''),
    region_id: card.RegionId || '',
    delivery_place: cleanText(card.deliveryPlace || card.delivery_place || ''),
    delivery_term: cleanText(card.delivery_term || ''),

    // Financial
    price: card.Price || c.price || '',
    ob_price: card.ObPrice || '',
    ob_price_z: card.ObPriceZ || '',
    smp: card.smp || '',

    // Procurement metadata
    fz: card.Fz || c.fz || '',
    etp: cleanText(card.Etp || c.etp || ''),
    tender_type: card.TenderType || '',
    category: cleanText(card.Category || c.category || ''),

    // Links
    tender_link: card.TenderLink || c.tender_link || '',
    tenderguru_link: card.TenderLinkInner || c.tenderguru_link || '',
    eis_link: card.EisLink || '',
    eis_link_print: card.EisLinkPrint || '',
    etp_link: card.EtpLink || card.TenderLinkEtp || '',
    zakaz_link: card.zakazLink || '',
    zakaz_tenders_link: card.zakazTendersLink || '',
    plan_zakup_number: card.PlanZakupNumber || '',

    // Classification (from our pipeline)
    niche: c.niche || '',
    classification: c.classification || '',
    relevance_score: c.relevance_score || '',
    matched_terms: c.matched_terms || '',
    query_groups: c.query_groups || '',
    sources: c.sources || '',
    reason: c.reason || '',

    // Full description
    info_text: info,
    info_length: info.length,

    // Products
    products_count: products.length,
    products_text: products.map(p => `${p.name}${p.code ? ' ['+p.code+']' : ''}${p.qty ? ' qty:'+p.qty : ''}${p.price ? ' price:'+p.price : ''}`).join(' | '),

    // Documents
    docs_count: docs.length,
    doc_links: c.doc_links_from_documentation_search || '',
    docs_status: c.docs_status || '',

    // API extended info
    api_tender_info: redactSecretsDeep(apiInfo),

    // Raw API extras (useful for later parsing)
    api_char_link: card.ApiCharLinkTender || '',
    api_contract_info: cleanText(String(card.ApiContractInfo || '')).slice(0, 500),
    plan_zakup_api: cleanText(String(card.PlanZakupApiInfo || '')).slice(0, 300),
    search_fragment: cleanText(JSON.stringify(card.searchFragmentXML || '')).slice(0, 400),
  };
}

function parseProducts(xml) {
  if (!xml) return [];
  const items = xml.product ? (Array.isArray(xml.product) ? xml.product : [xml.product]) : [];
  return items.map(p => ({
    name: cleanText(p.ProductName || ''),
    code: p.ProductCode || '',
    qty: p.Kolvo || '',
    price: p.edPrice || '',
    unit: p.Izm || '',
  }));
}

function parseApiInfo(raw) {
  if (!raw) return {};
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return { raw: String(raw).slice(0, 200) }; }
}

function getArg(name, def) {
  const flag = `--${name}=`;
  const arg = process.argv.find(a => a.startsWith(flag));
  return arg ? arg.slice(flag.length) : def;
}
