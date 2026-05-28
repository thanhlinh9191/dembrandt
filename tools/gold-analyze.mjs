#!/usr/bin/env node
// LLM-as-analyst. Reads the latest gold-run score file, identifies failure
// patterns + their user-attached comments, reads the relevant extractor
// source code, and asks a code-fluent LLM to propose 2-3 fix hypotheses
// per pattern with trade-offs.
//
// Output: test/analysis/<version>_<timestamp>.md
//
// This tool does NOT produce code changes or PRs. It produces a discussion
// document for the human to read and act on.
//
// Provider: --provider openai (gpt-4o) or claude (sonnet). Default: claude
// if ANTHROPIC_API_KEY set, else openai.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadEnv } from './env.mjs';

await loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SCORES_DIR = resolve(ROOT, 'test/scores');
const ANALYSIS_DIR = resolve(ROOT, 'test/analysis');
const EXTRACTORS_DIR = resolve(ROOT, 'lib/extractors');

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const args = process.argv.slice(2);
const providerArg = (() => {
  const i = args.findIndex(a => a === '--provider');
  return i >= 0 ? args[i + 1] : null;
})();
const provider = providerArg || (ANTHROPIC_KEY ? 'claude' : (OPENAI_KEY ? 'openai' : null));
if (!provider) { console.error('No API key. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env.local.'); process.exit(2); }
if (provider === 'openai' && !OPENAI_KEY) { console.error('OPENAI_API_KEY required for --provider openai'); process.exit(2); }
if (provider === 'claude' && !ANTHROPIC_KEY) { console.error('ANTHROPIC_API_KEY required for --provider claude'); process.exit(2); }

const OPENAI_MODEL = process.env.OPENAI_ANALYST_MODEL || 'gpt-4o';
const CLAUDE_MODEL = process.env.CLAUDE_ANALYST_MODEL || 'claude-sonnet-4-6';

const PASS_THRESHOLD = 70;

// Map a breakdown dimension to which extractor file is relevant.
const FIELD_TO_EXTRACTOR = {
  primary: 'colors.js',
  secondary: 'colors.js',
  brandPalette: 'colors.js',
  logoUrl: 'logo.js',
  primaryFont: 'typography.js',
  secondaryFont: 'typography.js',
};

async function latestScoreFile() {
  if (!existsSync(SCORES_DIR)) return null;
  const files = (await readdir(SCORES_DIR))
    .filter(f => f.endsWith('.json'))
    .sort();
  return files.length ? resolve(SCORES_DIR, files[files.length - 1]) : null;
}

async function loadExpectedFor(domain) {
  const f = resolve(ROOT, 'test/gold', domain, 'expected.json');
  if (!existsSync(f)) return null;
  try { return JSON.parse(await readFile(f, 'utf-8')); } catch { return null; }
}

function collectFailures(scoreData) {
  // Group failures by (field, pattern) where pattern is one of:
  //   missed (score < 40)
  //   close-but-wrong (40-70)
  //   verdict-flagged (any score, user marked wrong/missed/added)
  const failures = {};
  for (const r of scoreData.results) {
    if (r.error || !r.breakdown) continue;
    for (const [field, b] of Object.entries(r.breakdown)) {
      const score = b.score;
      const verdict = b.userMeta?.verdict;
      const comment = b.userMeta?.comment;
      let category = null;
      if (score != null && score < 40) category = 'missed';
      else if (score != null && score < PASS_THRESHOLD) category = 'close-but-wrong';
      else if (verdict && /missed|wrong|added/.test(verdict)) category = 'verdict-flagged';
      if (!category) continue;
      const key = `${field}::${category}`;
      failures[key] = failures[key] || { field, category, instances: [] };
      failures[key].instances.push({
        site: r.domain,
        score,
        expected: b.expected,
        actual: b.actualSemantic || b.actual || b.bestInPalette || (b.actualTop?.[0]),
        deltaE: b.bestDeltaE,
        verdict, comment,
      });
    }
  }
  return failures;
}

async function readExtractorSource(field) {
  const file = FIELD_TO_EXTRACTOR[field];
  if (!file) return null;
  const path = resolve(EXTRACTORS_DIR, file);
  if (!existsSync(path)) return null;
  const src = await readFile(path, 'utf-8');
  // Cap at 12k chars to stay within reasonable token budget.
  if (src.length > 12000) return src.slice(0, 12000) + '\n\n/* ... truncated ... */';
  return src;
}

function buildPrompt(cluster, source) {
  const instances = cluster.instances.map(i => {
    return `  - site=${i.site}, score=${i.score}, expected=${JSON.stringify(i.expected)}, actual=${JSON.stringify(i.actual)}${i.deltaE != null ? `, ΔE=${i.deltaE}` : ''}${i.verdict ? `, verdict=${i.verdict}` : ''}${i.comment ? `, human note: "${i.comment}"` : ''}`;
  }).join('\n');

  return `You are reviewing automated brand-extraction quality for a tool called dembrandt. It runs in a headless Chromium against websites and identifies design tokens (colors, fonts, logos).

A benchmark labeled by a human flagged a failure pattern:

FIELD: ${cluster.field}
CATEGORY: ${cluster.category}
INSTANCES (${cluster.instances.length}):
${instances}

RELEVANT EXTRACTOR SOURCE (lib/extractors/${FIELD_TO_EXTRACTOR[cluster.field]}):
\`\`\`javascript
${source || '(source not available)'}
\`\`\`

Your task: propose 2-3 distinct fix hypotheses with trade-offs. Do NOT write code patches. Do NOT propose a "best" fix. Frame as alternatives the maintainer can evaluate.

For each hypothesis include:
- WHAT: a one-sentence description
- WHY THIS WOULD WORK: causal reasoning grounded in the source code and instances
- TRADE-OFF: what this change could regress (other sites, other dimensions)
- INVESTIGATION: which specific lines/functions to read first to validate the hypothesis

Format as markdown. Start each hypothesis with ### Hypothesis N. Be concrete, name actual functions and variables from the source. Avoid platitudes ("improve robustness").

If the pattern looks like a data quality issue (e.g. user mislabeled, dembrandt was actually right), say so plainly.

Respond with markdown only. No preamble.`;
}

async function callOpenAI(prompt) {
  const body = {
    model: OPENAI_MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  };
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'authorization': `Bearer ${OPENAI_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return { text: data.choices?.[0]?.message?.content || '', usage: data.usage, model: OPENAI_MODEL };
}

async function callClaude(prompt) {
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return { text: data.content?.[0]?.text || '', usage: data.usage, model: CLAUDE_MODEL };
}

async function ask(prompt) {
  if (provider === 'openai') return callOpenAI(prompt);
  return callClaude(prompt);
}

async function main() {
  const scoreFile = await latestScoreFile();
  if (!scoreFile) { console.error('No score file found. Run `npm run gold:run` first.'); process.exit(1); }
  const scoreData = JSON.parse(await readFile(scoreFile, 'utf-8'));

  // augment results with the labeler's meta (the score file only has breakdown.userMeta;
  // expected.meta is on disk too — already merged via scoreSite, so we're good)
  const failures = collectFailures(scoreData);
  const keys = Object.keys(failures);
  if (keys.length === 0) {
    console.log('no failures above threshold. nothing to analyze.');
    return;
  }
  console.log(`analyzing ${keys.length} failure cluster(s) with ${provider} (${provider === 'openai' ? OPENAI_MODEL : CLAUDE_MODEL})\n`);

  await mkdir(ANALYSIS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = resolve(ANALYSIS_DIR, `${scoreData.version}_${ts}.md`);

  const sections = [];
  sections.push(`# dembrandt failure analysis · ${scoreData.version}`);
  sections.push(`Generated ${new Date().toISOString()} · provider: ${provider} · score file: ${scoreFile.split('/').slice(-2).join('/')}`);
  sections.push(`Aggregate gold score: **${scoreData.aggregate}/100** across ${scoreData.results.length} sites.\n`);

  for (const k of keys) {
    const cluster = failures[k];
    console.log(`▸ ${cluster.field} / ${cluster.category}  (${cluster.instances.length} site(s))`);
    const src = await readExtractorSource(cluster.field);
    const prompt = buildPrompt(cluster, src);
    let resp;
    try {
      resp = await ask(prompt);
      console.log(`  ${resp.model}: ${resp.usage?.input_tokens ?? '?'} in / ${resp.usage?.output_tokens ?? resp.usage?.completion_tokens ?? '?'} out tokens`);
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
      sections.push(`\n## ${cluster.field} / ${cluster.category} (${cluster.instances.length} sites)\n\nFailed to generate analysis: ${e.message}\n`);
      continue;
    }
    sections.push(`\n## ${cluster.field} / ${cluster.category} (${cluster.instances.length} sites)\n`);
    sections.push(`Affected: ${cluster.instances.map(i => i.site).join(', ')}\n`);
    const userNotes = cluster.instances.filter(i => i.comment).map(i => `- **${i.site}**: ${i.comment}`).join('\n');
    if (userNotes) sections.push(`\nHuman comments:\n${userNotes}\n`);
    sections.push(`\n${resp.text}\n`);
  }

  sections.push(`\n---\n_Generated by tools/gold-analyze.mjs. These are hypotheses, not verified fixes. Run gold:run after any code change to verify direction._`);

  await writeFile(outFile, sections.join('\n'));
  console.log(`\nanalysis saved → ${outFile.replace(ROOT + '/', '')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
