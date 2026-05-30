#!/usr/bin/env node
/**
 * Enriches EIS tenders with contact info and contract deadline
 * by scraping common-info pages on zakupki.gov.ru.
 * Updates public/data/tenders.json and rebuilds cards.
 *
 * Usage:
 *   node scripts/enrich-eis-contacts.js
 *   node scripts/enrich-eis-contacts.js --only=32616004003
 *   node scripts/enrich-eis-contacts.js --headless=false
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { firefox } from 'playwright';
import { loadDotEnv } from '../src/env.js';
import { startRelay } from '../src/socks5-relay.js';

loadDotEnv();

const HEADLESS = getArg('headless', 'true') !== 'false';
const ONLY     = getArg('only', '');
const RETRY    = 2;

const TENDERS_JSON = 'public/data/tenders.json';
const CARDS_DIR    = 'public/data/cards';

// ── proxy ──────────────────────────────────────────────────────────────────────

const pm = (process.env.ALL_PROXY || '').match(/socks5h?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)/);
let relay = null, launchProxy;
if (pm) {
  relay = await startRelay(pm[1], pm[2], pm[3], Number(pm[4]));
  launchProxy = { server: `socks5://localhost:${relay.port}` };
  console.log(`Proxy: localhost:${relay.port} → ${pm[3]}:${pm[4]}\n`);
}

// ── load tenders ───────────────────────────────────────────────────────────────

let tenders = JSON.parse(readFileSync(TENDERS_JSON, 'utf8'));
const eisTenders = tenders.filter(t => t.source === 'eis');
const targets = ONLY
  ? eisTenders.filter(t => t.tender_num === ONLY)
  : eisTenders;

console.log(`Enriching ${targets.length} EIS tenders...\n`);

// ── browser ────────────────────────────────────────────────────────────────────

const browser = await firefox.launch({ headless: HEADLESS, proxy: launchProxy });
const page    = await browser.newPage();
page.setDefaultTimeout(25_000);

const enriched = new Map(); // tender_num → contact fields

for (let i = 0; i < targets.length; i++) {
  const t = targets[i];
  process.stdout.write(`[${i + 1}/${targets.length}] ${t.tender_num} ... `);

  let result = null;
  for (let attempt = 1; attempt <= RETRY; attempt++) {
    try {
      await page.goto(t.eis_link || t.tender_link, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(1500);
      result = await extractContactInfo(page);
      break;
    } catch (err) {
      if (attempt < RETRY) await page.waitForTimeout(3000 * attempt);
    }
  }

  if (result) {
    enriched.set(t.tender_num, result);
    const parts = [
      result.contact_name,
      result.contact_email,
      result.contact_phone,
      result.contract_deadline ? `срок до ${result.contract_deadline}` : '',
    ].filter(Boolean);
    console.log(parts.join(' | ') || 'no contact found');
  } else {
    console.log('failed');
  }
}

await browser.close();
if (relay) relay.stop();

// ── merge into tenders.json ────────────────────────────────────────────────────

let updated = 0;
tenders = tenders.map(t => {
  const extra = enriched.get(t.tender_num);
  if (!extra) return t;
  updated++;
  return { ...t, ...extra };
});

writeFileSync(TENDERS_JSON, JSON.stringify(tenders));
console.log(`\nUpdated ${updated} tenders in tenders.json`);

// ── rebuild cards for enriched tenders ────────────────────────────────────────

let rebuilt = 0;
for (const [tenderNum, extra] of enriched) {
  const t = tenders.find(t => t.tender_num === tenderNum);
  if (!t) continue;

  const cardPath = `${CARDS_DIR}/${tenderNum}.md`;
  let card = '';
  try { card = readFileSync(cardPath, 'utf8'); } catch { continue; }

  // Inject contact block after "## Основные данные" section if not already there
  if (!card.includes('## Контакт') && (extra.contact_name || extra.contact_email || extra.contact_phone || extra.contract_deadline)) {
    const contactBlock = buildContactBlock(extra);
    // Insert before "## Техническое задание" or "## Документация" or "## Ссылки"
    const insertBefore = /^## (Техническое задание|Документация|Ссылки|MVP)/m;
    if (insertBefore.test(card)) {
      card = card.replace(insertBefore, `${contactBlock}\n$&`);
    } else {
      card += `\n${contactBlock}`;
    }
    writeFileSync(cardPath, card, 'utf8');
    rebuilt++;
  }
}

console.log(`Rebuilt ${rebuilt} cards`);

// ── helpers ────────────────────────────────────────────────────────────────────

async function extractContactInfo(page) {
  return page.evaluate(() => {
    const text = (sel) => {
      const el = document.querySelector(sel);
      return el?.textContent?.replace(/\s+/g, ' ')?.trim() || '';
    };

    // Generic field finder: given a label text, find nearby value
    function findField(...labels) {
      const allText = document.body.innerText;
      for (const label of labels) {
        const idx = allText.indexOf(label);
        if (idx === -1) continue;
        const after = allText.slice(idx + label.length, idx + label.length + 300).trim();
        const value = after.split('\n')[0].trim();
        if (value && value.length > 1 && value.length < 200) return value;
      }
      return '';
    }

    const contact_name  = findField('Контактное лицо\n', 'Ответственное должностное лицо\n', 'Контактное лицо ');
    const contact_email = findField('Адрес электронной почты\n', 'E-mail\n', 'Электронная почта\n');
    const contact_phone = findField('Номер контактного телефона\n', 'Контактный телефон\n', 'Телефон\n');
    const contract_deadline = findField('Срок исполнения контракта\n', 'Дата окончания исполнения контракта\n', 'Срок исполнения\n');

    // Clean phone
    const phoneClean = contact_phone.replace(/\s+/g, '').replace(/[()]/g, '').slice(0, 20);

    return {
      contact_name:      contact_name.slice(0, 100),
      contact_email:     contact_email.toLowerCase().slice(0, 100),
      contact_phone:     phoneClean,
      contract_deadline: contract_deadline.slice(0, 30),
    };
  });
}

function buildContactBlock(extra) {
  const lines = ['## Контакт', ''];
  if (extra.contact_name)      lines.push(`**Контактное лицо:** ${extra.contact_name}  `);
  if (extra.contact_email)     lines.push(`**Email:** ${extra.contact_email}  `);
  if (extra.contact_phone)     lines.push(`**Телефон:** ${extra.contact_phone}  `);
  if (extra.contract_deadline) lines.push(`**Срок исполнения:** ${extra.contract_deadline}  `);
  lines.push('');
  return lines.join('\n');
}

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find(a => a.startsWith(prefix))?.slice(prefix.length) || fallback;
}
