// Minimal .env.local loader. No deps. Reads KEY=value lines and exports into
// process.env without overwriting anything already set. Quietly no-ops if the
// file does not exist.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DEFAULT_FILES = ['.env.local', '.env'];

// Common misspellings/variants → canonical env var name.
const ALIASES = {
  OPENAPI_KEY: 'OPENAI_API_KEY',
  OPENAI_KEY: 'OPENAI_API_KEY',
  OPENAI_APIKEY: 'OPENAI_API_KEY',
  ANTHROPIC_KEY: 'ANTHROPIC_API_KEY',
  ANTHROPIC_APIKEY: 'ANTHROPIC_API_KEY',
  CLAUDE_API_KEY: 'ANTHROPIC_API_KEY',
};

export async function loadEnv(files = DEFAULT_FILES) {
  for (const f of files) {
    const path = resolve(ROOT, f);
    if (!existsSync(path)) continue;
    try {
      const text = await readFile(path, 'utf-8');
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        // strip optional surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!key || !value) continue;
        if (!(key in process.env)) process.env[key] = value;
        const canonical = ALIASES[key];
        if (canonical && !(canonical in process.env)) process.env[canonical] = value;
      }
    } catch { /* ignore */ }
  }
}
