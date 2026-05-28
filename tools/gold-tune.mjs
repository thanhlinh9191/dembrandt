#!/usr/bin/env node
// Threshold tuner / score comparator.
//
// MODE 1 (today, works): compare two score files from test/scores/, show per-site delta.
//   gold-tune.mjs compare <fileA> <fileB>
//   gold-tune.mjs compare --latest   (compare two newest score files)
//
// MODE 2 (sketch, requires extractor refactor): grid-search tunable thresholds
//   gold-tune.mjs grid
// Currently prints the list of constants in lib/extractors that would need to
// be exposed via env vars before tuning is possible.

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SCORES_DIR = resolve(ROOT, 'test/scores');

const args = process.argv.slice(2);
const mode = args[0];

async function listScoreFiles() {
  if (!existsSync(SCORES_DIR)) return [];
  const files = (await readdir(SCORES_DIR))
    .filter(f => f.endsWith('.json') && !f.startsWith('ai-judge'))
    .map(f => resolve(SCORES_DIR, f));
  return files.sort();
}

async function loadScore(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

function color(s, c) {
  const codes = { red: 31, green: 32, yellow: 33, dim: 90 };
  return `\x1b[${codes[c]}m${s}\x1b[0m`;
}

function fmtDelta(d) {
  if (d === 0 || d == null) return color('  0', 'dim');
  if (d > 0) return color(`+${d}`.padStart(3), 'green');
  return color(`${d}`.padStart(3), 'red');
}

async function compare(aFile, bFile) {
  const a = await loadScore(aFile);
  const b = await loadScore(bFile);
  console.log(`\n  A: ${a.version}  (${a.timestamp})`);
  console.log(`  B: ${b.version}  (${b.timestamp})\n`);

  const sitesA = new Map(a.results.map(r => [r.domain, r]));
  const sitesB = new Map(b.results.map(r => [r.domain, r]));
  const allSites = new Set([...sitesA.keys(), ...sitesB.keys()]);

  console.log(`  ${'site'.padEnd(22)}  A    B    Δ`);
  console.log(`  ${'─'.repeat(22)}  ───  ───  ────`);
  for (const d of [...allSites].sort()) {
    const sa = sitesA.get(d)?.aggregate ?? null;
    const sb = sitesB.get(d)?.aggregate ?? null;
    const delta = (sa != null && sb != null) ? sb - sa : null;
    const aStr = sa != null ? String(sa).padStart(3) : color(' - ', 'dim');
    const bStr = sb != null ? String(sb).padStart(3) : color(' - ', 'dim');
    console.log(`  ${d.padEnd(22)}  ${aStr}  ${bStr}  ${fmtDelta(delta)}`);
  }

  const delta = (b.aggregate ?? 0) - (a.aggregate ?? 0);
  console.log(`\n  AGGREGATE  ${a.aggregate ?? '-'}  →  ${b.aggregate ?? '-'}   ${fmtDelta(delta)}\n`);

  // dimension drill-down for regressions
  const regressed = [];
  for (const d of allSites) {
    const sa = sitesA.get(d), sb = sitesB.get(d);
    if (!sa || !sb || sa.aggregate == null || sb.aggregate == null) continue;
    if (sb.aggregate < sa.aggregate - 2) regressed.push({ d, sa, sb });
  }
  if (regressed.length) {
    console.log(`  REGRESSIONS (> 2 points):`);
    for (const { d, sa, sb } of regressed) {
      console.log(`    ${d}:`);
      for (const k of Object.keys(sa.breakdown || {})) {
        const va = sa.breakdown[k]?.score;
        const vb = sb.breakdown[k]?.score;
        if (va !== vb) console.log(`      ${k}: ${va} → ${vb}  ${fmtDelta(vb - va)}`);
      }
    }
    console.log('');
  }
}

async function gridSketch() {
  console.log(`\nThreshold tuning is a planned feature. Requires exposing constants in`);
  console.log(`lib/extractors/ as env vars so the tuner can grid-search them.\n`);
  console.log(`Constants to expose (search lib/extractors for these):`);
  console.log(`  - delta-E perceptual dedup threshold       (currently ~15)`);
  console.log(`  - structural color filter cutoff           (currently 40% of elements)`);
  console.log(`  - confidence high/medium/low boundaries    (currently 20 / 5)`);
  console.log(`  - context score weights                    (logo=5, brand=5, primary=4, ...)\n`);
  console.log(`Wire each as DEMBRANDT_<NAME> with sensible defaults. Once wired,`);
  console.log(`this script will grid-search ±50% around each value and report the`);
  console.log(`combination that maximizes aggregate gold score.\n`);
  console.log(`Until then, use 'gold-tune compare' to compare scores across`);
  console.log(`hand-tuned versions of the extractor (commit by commit).\n`);
}

async function main() {
  if (mode === 'compare') {
    let a, b;
    if (args[1] === '--latest') {
      const files = await listScoreFiles();
      if (files.length < 2) { console.error('need at least 2 score files in test/scores/'); process.exit(1); }
      a = files[files.length - 2];
      b = files[files.length - 1];
    } else {
      a = args[1]; b = args[2];
      if (!a || !b) { console.error('usage: gold-tune compare <fileA> <fileB>  |  gold-tune compare --latest'); process.exit(1); }
    }
    await compare(a, b);
    return;
  }
  if (mode === 'grid') return gridSketch();
  console.error(`usage:
  gold-tune compare <fileA> <fileB>
  gold-tune compare --latest
  gold-tune grid                   (prints what needs to be wired first)`);
  process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
