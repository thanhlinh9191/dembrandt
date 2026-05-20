// Shared helpers for gold tooling: color math, normalization, scoring.

export function normHex(c) {
  if (!c) return null;
  const s = String(c).trim();
  let m = s.match(/^#?([0-9a-f]{3})$/i);
  if (m) {
    const [r, g, b] = m[1].split('');
    return ('#' + r + r + g + g + b + b).toLowerCase();
  }
  m = s.match(/^#?([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (m) return ('#' + m[1]).toLowerCase();
  m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) {
    const h = n => Number(n).toString(16).padStart(2, '0');
    return ('#' + h(m[1]) + h(m[2]) + h(m[3])).toLowerCase();
  }
  return null;
}

function hexToRgb(hex) {
  const h = normHex(hex);
  if (!h) return null;
  return [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
}

function rgbToXyz([r, g, b]) {
  const lin = c => {
    c /= 255;
    return c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
  };
  const R = lin(r), G = lin(g), B = lin(b);
  return [
    R * 0.4124564 + G * 0.3575761 + B * 0.1804375,
    R * 0.2126729 + G * 0.7151522 + B * 0.0721750,
    R * 0.0193339 + G * 0.1191920 + B * 0.9503041,
  ];
}

function xyzToLab([x, y, z]) {
  const Xn = 0.95047, Yn = 1.0, Zn = 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  const fx = f(x / Xn), fy = f(y / Yn), fz = f(z / Zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function deltaE(hex1, hex2) {
  const a = hexToRgb(hex1);
  const b = hexToRgb(hex2);
  if (!a || !b) return Infinity;
  const lab1 = xyzToLab(rgbToXyz(a));
  const lab2 = xyzToLab(rgbToXyz(b));
  return Math.sqrt(
    Math.pow(lab1[0] - lab2[0], 2) +
    Math.pow(lab1[1] - lab2[1], 2) +
    Math.pow(lab1[2] - lab2[2], 2)
  );
}

// 100 = perfect match, 0 = unrelated
export function colorScore(expectedHex, actualHex, perfectAt = 3, zeroAt = 25) {
  const e = normHex(expectedHex);
  const a = normHex(actualHex);
  if (!e || !a) return 0;
  const d = deltaE(e, a);
  if (d <= perfectAt) return 100;
  if (d >= zeroAt) return 0;
  return Math.round(100 * (1 - (d - perfectAt) / (zeroAt - perfectAt)));
}

// Find best matching color in a palette, return { hex, score, deltaE }
export function bestMatch(expectedHex, paletteHexes) {
  const e = normHex(expectedHex);
  if (!e) return { hex: null, score: 0, deltaE: Infinity };
  let best = { hex: null, score: 0, deltaE: Infinity };
  for (const c of paletteHexes) {
    const h = normHex(c);
    if (!h) continue;
    const d = deltaE(e, h);
    const s = colorScore(e, h);
    if (s > best.score) best = { hex: h, score: s, deltaE: d };
  }
  return best;
}

export function normFont(name) {
  if (!name) return null;
  return String(name).replace(/['"]/g, '').split(',')[0].trim().toLowerCase();
}

export function fontScore(expected, actualFamilies) {
  const e = normFont(expected);
  if (!e) return 0;
  const list = Array.isArray(actualFamilies) ? actualFamilies : [actualFamilies];
  for (const a of list) {
    const n = normFont(a);
    if (!n) continue;
    if (n === e) return 100;
    if (n.includes(e) || e.includes(n)) return 80;
  }
  return 0;
}

export function extractFontFamilies(extraction) {
  const out = [];
  const styles = extraction?.typography?.styles || [];
  for (const s of styles) {
    if (s.family) out.push(s.family);
  }
  return out;
}

// siteUrl = the gold site's own URL (expected.url). Used to detect when the
// expected.logoUrl is a cross-domain reference (e.g. brandfetch, freebiesupply)
// vs an actual on-site URL the scorer can compare directly.
export function logoScore(expectedUrl, actualUrl, siteUrl = null) {
  if (!actualUrl) return 0;
  if (!expectedUrl) return 0;
  if (expectedUrl === actualUrl) return 100;

  let expHost = null, actHost = null, siteHost = null;
  try { expHost = new URL(expectedUrl).hostname.replace(/^www\./, ''); } catch {}
  try { actHost = new URL(actualUrl).hostname.replace(/^www\./, ''); } catch {}
  try { siteHost = siteUrl ? new URL(siteUrl).hostname.replace(/^www\./, '') : null; } catch {}

  const expIsReference = siteHost && expHost && expHost !== siteHost;

  if (expIsReference) {
    // Expected URL is on a brand-resource site, not the site itself.
    // Can't compare URLs directly; verify dembrandt found a plausible logo.
    if (actHost === siteHost) return 75;          // logo from the site's own domain: good
    if (actHost && actHost.endsWith('.' + siteHost)) return 70; // subdomain of site
    if (actHost) return 50;                       // logo from CDN or third party
    return 30;                                    // logo URL present but unparseable
  }

  // Both URLs are checkable. Compare path/filename.
  try {
    const a = new URL(expectedUrl);
    const b = new URL(actualUrl);
    if (a.pathname === b.pathname) return 95;
    const baseA = a.pathname.split('/').pop().split('.')[0].toLowerCase();
    const baseB = b.pathname.split('/').pop().split('.')[0].toLowerCase();
    if (baseA && baseA === baseB) return 80;
  } catch { /* fall through */ }
  return 30;
}

const WEIGHTS = {
  primary: 30,
  secondary: 15,
  brandPalette: 20,
  logoUrl: 15,
  primaryFont: 15,
  secondaryFont: 5,
};

export function scoreSite(expected, actual) {
  const breakdown = {};
  let total = 0, max = 0;

  // primary
  if (expected.primary) {
    const actualPrimary = actual?.colors?.semantic?.primary;
    const palette = (actual?.colors?.palette || []).map(p => p.color);
    const direct = colorScore(expected.primary, actualPrimary);
    const best = bestMatch(expected.primary, palette);
    const score = Math.max(direct, best.score);
    breakdown.primary = {
      expected: expected.primary,
      actualSemantic: actualPrimary,
      bestInPalette: best.hex,
      bestDeltaE: best.deltaE === Infinity ? null : Number(best.deltaE.toFixed(2)),
      score,
    };
    total += score * WEIGHTS.primary;
    max += 100 * WEIGHTS.primary;
    if (expected.meta?.primary) breakdown.primary.userMeta = expected.meta.primary;
  }

  // secondary
  if (expected.secondary) {
    const actualSecondary = actual?.colors?.semantic?.secondary;
    const palette = (actual?.colors?.palette || []).map(p => p.color);
    const direct = colorScore(expected.secondary, actualSecondary);
    const best = bestMatch(expected.secondary, palette);
    const score = Math.max(direct, best.score);
    breakdown.secondary = {
      expected: expected.secondary,
      actualSemantic: actualSecondary,
      bestInPalette: best.hex,
      bestDeltaE: best.deltaE === Infinity ? null : Number(best.deltaE.toFixed(2)),
      score,
    };
    total += score * WEIGHTS.secondary;
    max += 100 * WEIGHTS.secondary;
    if (expected.meta?.secondary) breakdown.secondary.userMeta = expected.meta.secondary;
  }

  // brand palette
  if (expected.brandPalette?.length) {
    const palette = (actual?.colors?.palette || []).map(p => p.color);
    const details = expected.brandPalette.map(e => {
      const b = bestMatch(e, palette);
      return { expected: e, bestMatch: b.hex, deltaE: b.deltaE === Infinity ? null : Number(b.deltaE.toFixed(2)), score: b.score };
    });
    const avg = details.reduce((s, d) => s + d.score, 0) / details.length;
    breakdown.brandPalette = { details, score: Math.round(avg) };
    total += avg * WEIGHTS.brandPalette;
    max += 100 * WEIGHTS.brandPalette;
    if (expected.meta?.brandPalette) breakdown.brandPalette.userMeta = expected.meta.brandPalette;
  }

  // logo
  if (expected.logoUrl) {
    const actualLogo = actual?.logo?.url;
    const score = logoScore(expected.logoUrl, actualLogo, expected.url);
    breakdown.logoUrl = { expected: expected.logoUrl, actual: actualLogo, score };
    total += score * WEIGHTS.logoUrl;
    max += 100 * WEIGHTS.logoUrl;
    if (expected.meta?.logoUrl) breakdown.logoUrl.userMeta = expected.meta.logoUrl;
  }

  // primary font
  if (expected.primaryFont) {
    const families = extractFontFamilies(actual);
    const score = fontScore(expected.primaryFont, families);
    breakdown.primaryFont = { expected: expected.primaryFont, actualTop: families.slice(0, 5), score };
    total += score * WEIGHTS.primaryFont;
    max += 100 * WEIGHTS.primaryFont;
    if (expected.meta?.primaryFont) breakdown.primaryFont.userMeta = expected.meta.primaryFont;
  }

  // secondary font
  if (expected.secondaryFont) {
    const families = extractFontFamilies(actual);
    const score = fontScore(expected.secondaryFont, families);
    breakdown.secondaryFont = { expected: expected.secondaryFont, actualTop: families.slice(0, 5), score };
    total += score * WEIGHTS.secondaryFont;
    max += 100 * WEIGHTS.secondaryFont;
    if (expected.meta?.secondaryFont) breakdown.secondaryFont.userMeta = expected.meta.secondaryFont;
  }

  const aggregate = max > 0 ? Math.round(total / max * 100) : null;
  return { aggregate, breakdown };
}
