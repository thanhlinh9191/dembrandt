// teach.ts — internal, opt-in extractor. Hidden flag; not part of the product
// output. Only runs when `--teach` is passed; its result is written to a
// separate `<file>.teach.json` sidecar (see index.ts). Collects the raw :root
// custom-property map (names + resolved values) and interactive-state styles —
// both publicly visible CSS that the product extractor deliberately filters out.

export async function extractTeach(page: any) {
  return await page.evaluate(() => {
    const out: { cssVariables: Record<string, string>; states: any[] } = { cssVariables: {}, states: [] };

    // 1. All :root custom properties, names + resolved values, minimal filtering.
    try {
      const cs = getComputedStyle(document.documentElement);
      let n = 0;
      for (let i = 0; i < cs.length && n < 600; i++) {
        const prop = cs[i];
        if (!prop.startsWith('--')) continue;
        if (prop.startsWith('--wp--preset')) continue; // WordPress editor preset dump
        const val = cs.getPropertyValue(prop).trim();
        if (!val) continue;
        out.cssVariables[prop] = val;
        n++;
      }
    } catch { /* ignore */ }

    // 2. Interactive-state styles for links/buttons (:hover/:focus/:active),
    //    read from same-origin stylesheets. Cross-origin sheets throw → skipped.
    try {
      const wantState = /:(hover|focus|focus-visible|active)/;
      const onInteractive = /(^|[\s,>~+])(a|button)\b|\[role=["']?button|\.(btn|button)\b/i;
      const props = ['color', 'background-color', 'border-color', 'box-shadow', 'outline-color'];
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: any;
        try { rules = (sheet as CSSStyleSheet).cssRules; } catch { continue; }
        if (!rules) continue;
        for (const rule of Array.from(rules) as any[]) {
          const sel = rule.selectorText;
          if (!sel || !wantState.test(sel) || !onInteractive.test(sel)) continue;
          const pick: Record<string, string> = {};
          for (const p of props) { const v = rule.style?.getPropertyValue(p); if (v) pick[p] = v.trim(); }
          if (Object.keys(pick).length) out.states.push({ selector: String(sel).slice(0, 140), ...pick });
          if (out.states.length >= 200) break;
        }
        if (out.states.length >= 200) break;
      }
    } catch { /* ignore */ }

    return out;
  });
}
