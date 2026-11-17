// Web fonts: Google Fonts URLs, CSS font stacks, and which web fonts a theme
// still uses. Pure functions (no DOM), so they're testable in Node.
//
// A theme refers to a Google font through a fontFaces entry with a stylesheet
// URL: { "family": "Oswald", "css": "https://fonts.googleapis.com/css2?..." }.
// The URL asks only for weights the family has: the API rejects the whole
// request (HTTP 400) if one weight is missing.

export const GOOGLE_CSS = "https://fonts.googleapis.com/css2";

const enc = (family) => encodeURIComponent(family).replace(/%20/g, "+");

/** Stylesheet URL for a family with the given upright weights. */
export function googleCssUrl(family, weights) {
  const ws = [...new Set(weights)].map(Number).filter((w) => w >= 1 && w <= 1000).sort((a, b) => a - b);
  const axis = ws.length ? `:wght@${ws.join(";")}` : "";
  return `${GOOGLE_CSS}?family=${enc(family)}${axis}&display=swap`;
}

/** A tiny stylesheet with just the glyphs of `text` (for previews in the picker). */
export function googlePreviewUrl(family, text = family) {
  const glyphs = [...new Set(text)].join("");
  return `${GOOGLE_CSS}?family=${enc(family)}&text=${encodeURIComponent(glyphs)}`;
}

const FALLBACK = { sans: "sans-serif", serif: "serif", mono: "monospace", display: "sans-serif", handwriting: "cursive" };

/** CSS font-family value for a picked family, with a generic fallback. */
export function fontStack(family, category = "sans") {
  const name = /^[\w-]+$/.test(family) && !/^\d/.test(family) ? family : `'${family.replace(/'/g, "\\'")}'`;
  return `${name}, ${FALLBACK[category] || "sans-serif"}`;
}

/** First family in a CSS font-family list, unquoted ("'Bebas Neue', sans-serif" -> "Bebas Neue"). */
export function primaryFamily(stack) {
  if (!stack) return "";
  const m = String(stack).trim().match(/^(?:'([^']*)'|"([^"]*)"|([^,]+))/);
  return m ? (m[1] ?? m[2] ?? m[3]).trim() : "";
}

/** The available weight closest to `want` (ties go heavier). */
export function nearestWeight(weights, want) {
  if (!weights || !weights.length) return want;
  return weights.reduce((best, w) => (Math.abs(w - want) < Math.abs(best - want) || (Math.abs(w - want) === Math.abs(best - want) && w > best) ? w : best));
}

/** Web-font entries (with a css URL) whose family no font role uses any more are dropped; file-based faces are kept. */
export function pruneFontFaces(faces, fonts) {
  const used = new Set(Object.values(fonts || {}).map((f) => primaryFamily(f && f.family).toLowerCase()));
  return (faces || []).filter((f) => !f.css || used.has(String(f.family).toLowerCase()));
}

/** Adds or replaces the web-font entry for a family. */
export function withFontFace(faces, family, css) {
  return [...(faces || []).filter((f) => !(f.css && f.family === family)), { family, css }];
}
