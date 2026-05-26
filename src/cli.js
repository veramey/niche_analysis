#!/usr/bin/env node
import { loadDotEnv } from './env.js';
import { TenderGuruApiError, TenderGuruClient } from './tenderguru-client.js';

loadDotEnv();

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));
const client = new TenderGuruClient();

try {
  const result = await run(command, args);
  printResult(result, Number(args.limitOutput || args['limit-output'] || 0));
} catch (error) {
  if (error instanceof TenderGuruApiError) {
    console.error(error.message);
    if (error.url) console.error(`URL: ${error.url}`);
    if (error.body) console.error(error.body.slice(0, 2000));
    process.exit(2);
  }

  console.error(error.message);
  process.exit(1);
}

async function run(cmd, options) {
  switch (cmd) {
    case 'search-tenders':
      requireOption(options, 'kwords');
      return client.searchTenders(toApiParams(options, ['limitOutput', 'limit-output']));

    case 'tender':
      if (options.id) return client.getTenderById(options.id, toApiParams(options, ['id']));
      if (options.tendNum || options['tend-num']) {
        return client.getTenderByNumber(options.tendNum || options['tend-num'], toApiParams(options, ['tendNum', 'tend-num']));
      }
      throw new Error('Use tender --id <id> or tender --tend-num <number>.');

    case 'contragent':
      if (options.inn) return client.getContragentByInn(options.inn, toApiParams(options, ['inn']));
      if (options.ogrn) return client.getContragentByOgrn(options.ogrn, toApiParams(options, ['ogrn']));
      if (options.id) return client.getContragentById(options.id, toApiParams(options, ['id']));
      throw new Error('Use contragent --inn <inn>, --ogrn <ogrn>, or --id <id>.');

    case 'contragent-contact':
      requireOption(options, 'inn');
      return client.getContragentContacts(options.inn, toApiParams(options, ['inn']));

    case 'refresh-key':
      return client.getApiCode(options.refreshCode || options['refresh-code'] || process.env.TENDERGURU_REFRESH_CODE, {
        update: options.update,
      });

    case 'get':
      return client.request('', toApiParams(options));

    default:
      printHelp();
      process.exit(cmd ? 1 : 0);
  }
}

function parseArgs(rawArgs) {
  const parsed = {};

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === '--param') {
      const pair = rawArgs[index + 1];
      index += 1;
      if (!pair || !pair.includes('=')) {
        throw new Error('--param expects key=value.');
      }
      const [key, ...rest] = pair.split('=');
      parsed[key] = rest.join('=');
      continue;
    }

    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const normalized = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = rawArgs[index + 1];

    if (!next || next.startsWith('--')) {
      parsed[normalized] = '1';
      continue;
    }

    parsed[normalized] = next;
    index += 1;
  }

  return parsed;
}

function toApiParams(options, omit = []) {
  const omitted = new Set([...omit, 'limitOutput', 'limit-output']);
  const params = {};

  for (const [key, value] of Object.entries(options)) {
    if (omitted.has(key)) continue;
    params[toSnakeCase(key)] = value;
  }

  return params;
}

function toSnakeCase(value) {
  return value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function requireOption(options, key) {
  if (!options[key]) {
    throw new Error(`Missing required option --${key}.`);
  }
}

function printResult(result, limitOutput) {
  const output = redactSecrets(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  console.log(limitOutput > 0 ? output.slice(0, limitOutput) : output);
}

function redactSecrets(output) {
  return output
    .replace(/(api_code=)[^&"'\s]+/gi, '$1<redacted>')
    .replace(/("api_code"\s*:\s*")[^"]+"/gi, '$1<redacted>"');
}

function printHelp() {
  console.log(`TenderGuru API CLI

Usage:
  npm run tg -- search-tenders --kwords "ремонт дороги" --price1 10000000 --param r50=1
  npm run tg -- tender --id 12402324
  npm run tg -- tender --tend-num 0174500001123002772
  npm run tg -- contragent --inn 7716615618
  npm run tg -- contragent-contact --inn 7716615618
  npm run tg -- refresh-key --refresh-code <REFRESH_CODE> --update no
  npm run tg -- get --param mode=regions --limit-output 1200

Environment:
  TENDERGURU_API_CODE      optional api_code for paid fields and sections
  TENDERGURU_REFRESH_CODE  optional refresh_code for refresh-key
`);
}
