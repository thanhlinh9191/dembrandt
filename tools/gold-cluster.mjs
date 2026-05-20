#!/usr/bin/env node
// Failure pattern clusterer. Reads the latest score file from test/scores/
// and groups failing sites by failure shape (which dimensions failed, by how
// much, on which feature axes). Helps identify systemic extraction bugs vs
// per-site quirks.
//
// Usage:
//   gold-cluster.mjs                  (uses latest score file)
//   gold-cluster.mjs <scoreFile>

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SCORES_DIR = resolve(ROOT, 'test/scores');

const PASS_THRESHOLD = 70; // per-dimension score below this is a "fail"

async function latestScoreFile() {
  const files = (await readdir(SCORES_DIR))
    .filter(f => f.endsWith('.json'))
    .sort();
  return files.length ? resolve(SCORES_DIR, files[files.length - 1]) : null;
}

function color(s, c) {
  const codes = { red: 31, green: 32, yellow: 33, cyan: 36, dim: 90, bold: 1 };
  return `\x1b[${codes[c]}m${s}\x1b[0m`;
}

function classify(deltaE) {
  if (deltaE == null) return 'no-color-data';
  if (deltaE <= 5) return 'near-match';
  if (deltaE <= 15) return 'close-but-wrong';
  return 'far';
}

async function main() {
  const file = process.argv[2] || await latestScoreFile();
  if (!file || !existsSync(file)) {
    console.error('no score file found. run `npm run gold:run` first.');
    process.exit(1);
  }
  const data = JSON.parse(await readFile(file, 'utf-8'));
  console.log(`\nFailure patterns · dembrandt ${data.version} · ${data.results.length} sites\n`);

  const patterns = {
    primaryFail: [],         // primary dim scored < threshold
    paletteJunk: [],         // palette score < threshold
    fontMissed: [],          // primaryFont score < threshold
    logoMissed: [],          // logoUrl score < threshold
    primaryFarOff: [],       // primary deltaE > 15
    primaryCloseButWrong: [],// primary deltaE 5-15 (likely needs threshold tune)
    structuralLeak: [],      // palette contains many neutrals (heuristic)
    extractionError: [],
  };

  for (const r of data.results) {
    if (r.error) { patterns.extractionError.push({ site: r.domain, error: r.error }); continue; }
    const b = r.breakdown || {};
    if (b.primary?.score < PASS_THRESHOLD) patterns.primaryFail.push({ site: r.domain, score: b.primary.score, deltaE: b.primary.bestDeltaE });
    if (b.brandPalette?.score < PASS_THRESHOLD) patterns.paletteJunk.push({ site: r.domain, score: b.brandPalette.score });
    if (b.primaryFont?.score < PASS_THRESHOLD) patterns.fontMissed.push({ site: r.domain, score: b.primaryFont.score, expected: b.primaryFont.expected, top: b.primaryFont.actualTop?.slice(0, 3) });
    if (b.logoUrl?.score < PASS_THRESHOLD) patterns.logoMissed.push({ site: r.domain, score: b.logoUrl.score, expected: b.logoUrl.expected, got: b.logoUrl.actual });
    const klass = classify(b.primary?.bestDeltaE);
    if (klass === 'far') patterns.primaryFarOff.push(r.domain);
    if (klass === 'close-but-wrong') patterns.primaryCloseButWrong.push({ site: r.domain, deltaE: b.primary.bestDeltaE });
  }

  const section = (name, items, hint) => {
    if (items.length === 0) return;
    console.log(color(`▸ ${name}  (${items.length})`, 'bold'));
    if (hint) console.log(color(`  ${hint}`, 'dim'));
    for (const i of items) console.log(`  ${color('•', 'red')} ${typeof i === 'string' ? i : JSON.stringify(i)}`);
    console.log('');
  };

  section('PRIMARY missed', patterns.primaryFail,
    'Either semantic detection missed it or the palette dropped it. Check colors.semantic + raw vs filtered palette.');
  section('PRIMARY close-but-wrong (ΔE 5-15)', patterns.primaryCloseButWrong,
    'These are the easiest wins. Often the right color is in the raw palette but a sibling shade won via context score.');
  section('PRIMARY far-off (ΔE > 15)', patterns.primaryFarOff.map(s => ({ site: s })),
    'Likely a structural color (header bg, body text) is being treated as brand. Check structural-filter threshold.');
  section('PALETTE incomplete', patterns.paletteJunk,
    'Brand palette colors did not appear in top results. Check confidence scoring weights.');
  section('FONT missed', patterns.fontMissed,
    'Either the actual font family detection is wrong (system fallback returned) or font-loading races extraction.');
  section('LOGO missed', patterns.logoMissed,
    'Logo detection picked the wrong image. Check extractLogo: maybe a favicon or hero image scored higher.');
  section('EXTRACTION errored', patterns.extractionError,
    'Browser/playwright failure. Bot detection or timeout. Try --slow.');

  const buckets = Object.entries(patterns).filter(([, v]) => v.length > 0);
  if (buckets.length === 0) {
    console.log(color('  no failures above threshold. nice.', 'green'));
    return;
  }
  console.log(color(`SUMMARY: ${buckets.length} failure patterns, ${buckets.reduce((s, [, v]) => s + v.length, 0)} total incidents`, 'cyan'));
}

main().catch(e => { console.error(e); process.exit(1); });
