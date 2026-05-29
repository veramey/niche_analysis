#!/usr/bin/env node
import { spawn } from 'node:child_process';

const runDate = getArg('date', '2026-05-25');
const only = getArg('only', '');
const input = getArg('input', `data/processed/${runDate}/classified-tenders.csv`);
const docsDir = getArg('docs-dir', `data/raw/tenderguru/${runDate}/docs`);
const downloadOutput = getArg('download-output', `data/raw/tenderguru/${runDate}/docs`);
const manifestCsv = getArg('manifest-csv', `data/raw/tenderguru/${runDate}/docs-manifest.csv`);
const manifestJsonl = getArg('manifest-jsonl', `data/raw/tenderguru/${runDate}/docs-manifest.jsonl`);
const tzOutput = getArg('tz-output', `data/analysis/${runDate}/tz-candidates`);
const maxDepth = getArg('max-depth', '3');
const maxPerTender = getArg('max-per-tender', '20');
const minScore = getArg('min-score', '4');

await runStep('download tender docs', [
  'scripts/download-tender-docs.js',
  `--date=${runDate}`,
  `--input=${input}`,
  `--output=${downloadOutput}`,
  `--manifest-csv=${manifestCsv}`,
  `--manifest-jsonl=${manifestJsonl}`,
  `--max-depth=${maxDepth}`,
  `--max-per-tender=${maxPerTender}`,
  ...(only ? [`--only=${only}`] : []),
]);

await runStep('find TZ candidates', [
  'scripts/find-tz-candidates.js',
  `--date=${runDate}`,
  `--classified=${input}`,
  `--docs-dir=${docsDir}`,
  `--output=${tzOutput}`,
  `--min-score=${minScore}`,
  ...(only ? [`--only=${only}`] : []),
]);

console.log(`Done. Download manifest: ${manifestCsv}`);
console.log(`TZ candidates: ${tzOutput}/tz-candidates.csv`);

async function runStep(label, args) {
  console.log(`Running ${label}...`);
  await new Promise((resolve, reject) => {
    const child = spawn('node', args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${label} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || fallback;
}
