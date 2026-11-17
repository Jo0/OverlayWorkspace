// Themes: named colors, font roles, panel styling. Elements can override any
// part of the theme through their "style" object, which is deep-merged over it.
// See docs/EXTENDING.md for the schema.

export const DEFAULT_THEME = {
  schema: "overlay-theme/1",
  id: "fallback",
  name: "Fallback",
  colors: {
    text: "#FFFFFF",
    muted: "rgba(255,255,255,0.65)",
    panel: "rgba(8,10,14,0.6)",
    border: "rgba(255,255,255,0.14)",
    accent: "#FFB000",
    // Highlights that mean "no gain or loss" (even stretches on the map, a
    // finished time): must stay clearly apart from good and bad.
    neutral: "#FFB000",
    good: "#2ED47A",
    bad: "#FF4D4D",
    track: "rgba(255,255,255,0.45)",
    marker: "#FFB000",
    grid: "rgba(255,255,255,0.18)",
  },
  fonts: {
    display: { family: "system-ui, 'Segoe UI', Roboto, sans-serif", weight: 700 },
    number: { family: "system-ui, 'Segoe UI', Roboto, sans-serif", weight: 700, tabular: true },
    label: { family: "system-ui, 'Segoe UI', Roboto, sans-serif", weight: 600, letterSpacing: 0.08 },
  },
  fontFaces: [],
  panel: {
    shape: "rounded",
    radius: 28,
    fill: "panel",
    stroke: "border",
    strokeWidth: 3,
    padding: 28,
    shadow: { color: "rgba(0,0,0,0.35)", blur: 30, x: 0, y: 8 },
  },
  line: { width: 8, cap: "round" },
  // Text effects, sizes in em (fractions of the font size):
  // stroke: { color, width }, shadow: { color, blur, x, y }
  text: { stroke: null, shadow: null },
};

export function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Deep merge; arrays and primitives in `over` replace those in `base`. */
export function deepMerge(base, over) {
  if (!isPlainObject(over)) return over === undefined ? base : over;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) out[k] = isPlainObject(v) ? deepMerge(out[k], v) : v;
  return out;
}

export function resolveTheme(theme, elementStyle) {
  const t = deepMerge(DEFAULT_THEME, theme || {});
  return elementStyle ? deepMerge(t, elementStyle) : t;
}

/** A color reference is a theme color name, or any CSS color. */
export function color(theme, ref, fallback = "text") {
  if (ref == null || ref === "") ref = fallback;
  const c = theme.colors && theme.colors[ref];
  return c != null ? c : ref;
}

export function fontRole(theme, role) {
  return (theme.fonts && (theme.fonts[role] || theme.fonts.display)) || DEFAULT_THEME.fonts.display;
}

/** Sets ctx.font (and letter spacing, where supported) for a font role at px size. */
export function applyFont(ctx, theme, role, px) {
  const f = fontRole(theme, role);
  ctx.font = `${f.style || "normal"} ${f.weight || 400} ${Math.max(1, px)}px ${f.family}`;
  if ("letterSpacing" in ctx) ctx.letterSpacing = f.letterSpacing ? `${f.letterSpacing * px}px` : "0px";
  return f;
}

const loadedFaces = new Set();
const stylesheets = new Map(); // url -> Promise

function loadStylesheet(url) {
  if (!stylesheets.has(url)) {
    stylesheets.set(url, new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = url;
      link.onload = resolve;
      link.onerror = () => { stylesheets.delete(url); link.remove(); reject(new Error(`couldn't load ${url}`)); };
      document.head.append(link);
    }));
  }
  return stylesheets.get(url);
}

function firstFamily(stack) {
  const m = String(stack || "").trim().match(/^(?:'([^']*)'|"([^"]*)"|([^,]+))/);
  return m ? (m[1] ?? m[2] ?? m[3]).trim().toLowerCase() : "";
}

/**
 * Loads the theme's custom fonts so canvas text can use them: font files
 * ({ family, src }) and web-font stylesheets ({ family, css }, e.g. Google
 * Fonts). A stylesheet only declares its fonts; the weights the theme's font
 * roles use are then fetched explicitly, since canvas drawing doesn't
 * trigger a download the way page text does.
 */
export async function loadThemeFonts(theme) {
  if (typeof FontFace === "undefined" || typeof document === "undefined") return;
  const faces = (theme && theme.fontFaces) || [];
  const roles = Object.values((theme && theme.fonts) || {});
  await Promise.all(
    faces.map(async (f) => {
      try {
        if (f.css) {
          await loadStylesheet(f.css);
          const uses = roles.filter((r) => firstFamily(r.family) === String(f.family).toLowerCase());
          await Promise.all((uses.length ? uses : [{ weight: 400 }]).map((r) =>
            document.fonts.load(`${r.style || "normal"} ${r.weight || 400} 40px "${f.family}"`)));
          return;
        }
        const key = `${f.family}|${f.src}|${f.weight || ""}|${f.style || ""}`;
        if (loadedFaces.has(key)) return;
        const src = /^url\(/.test(f.src) ? f.src : `url(${JSON.stringify(f.src)})`;
        const face = new FontFace(f.family, src, { weight: String(f.weight || "400"), style: f.style || "normal" });
        await face.load();
        document.fonts.add(face);
        loadedFaces.add(key);
      } catch (e) {
        console.warn(`Font "${f.family}" failed to load:`, e);
      }
    }),
  );
}
