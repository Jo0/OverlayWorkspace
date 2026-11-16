// Theme color consistency: every bundled theme keeps the colors that carry a
// meaning (gaining, losing, "neither") visibly apart, so switching themes
// can't make an even stretch or a finished time read as a loss.
// Run with: node --test test/*.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveTheme, color } from "../src/core/theme.js";
import { normalizeTemplate } from "../src/core/template.js";
import "../src/widgets/index.js";
import { widgets } from "../src/core/registry.js";

const themeDir = new URL("../themes/", import.meta.url);
const themes = JSON.parse(readFileSync(new URL("index.json", themeDir), "utf8")).map((t) => ({
  id: t.id,
  theme: resolveTheme(JSON.parse(readFileSync(new URL(t.file, themeDir), "utf8"))),
}));

// Overlays sit on footage: judge colors as they'd look over mid-dark asphalt.
const BACKDROP = [64, 64, 64];

function parseCss(c) {
  let m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (m) {
    const [r, g, b, a = 1] = m[1].split(",").map(Number);
    return [r, g, b, a];
  }
  throw new Error(`can't parse color ${c}`);
}

function lab(css) {
  const [r, g, b, a] = parseCss(css);
  const rgb = [r, g, b].map((v, i) => (v * a + BACKDROP[i] * (1 - a)) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const X = (0.4124 * rgb[0] + 0.3576 * rgb[1] + 0.1805 * rgb[2]) / 0.95047;
  const Y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const Z = (0.0193 * rgb[0] + 0.1192 * rgb[1] + 0.9505 * rgb[2]) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

const deltaE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));

// Pairs that are drawn next to each other with different meanings.
const MUST_DIFFER = [
  ["good", "bad"],        // gain vs loss: map trail, timer, delta bars
  ["neutral", "good"],    // even stretch / finished time vs gain
  ["neutral", "bad"],     // even stretch / finished time vs loss
  ["marker", "bad"],      // position dot riding on a losing trail
  ["marker", "good"],
  ["track", "good"],      // undriven course line vs the trail
  ["track", "bad"],
];
const MIN_DELTA_E = 25;

for (const { id, theme } of themes) {
  test(`theme "${id}": meaningful colors stay apart`, () => {
    for (const [a, b] of MUST_DIFFER) {
      const d = deltaE(color(theme, a), color(theme, b));
      assert.ok(d >= MIN_DELTA_E, `${a} (${color(theme, a)}) and ${b} (${color(theme, b)}) are too alike: ΔE ${d.toFixed(1)} < ${MIN_DELTA_E}`);
    }
  });
}

test("no widget defaults a neither-gain-nor-loss color to accent", () => {
  // accent is the theme's brand color and may be red or green; anything that
  // must not read as gain/loss uses neutral instead.
  const checks = { trackmap: ["driven"], laptimer: ["finishedColor", "color", "waitingColor"], trace: ["color3"] };
  for (const [type, keys] of Object.entries(checks)) {
    const props = widgets.get(type).defaults.props;
    for (const k of keys) assert.notEqual(props[k], "accent", `${type}.${k}`);
  }
});

test("templates saved with the old accent defaults move to neutral", () => {
  const old = normalizeTemplate({
    elements: [
      { type: "trackmap", props: { driven: "accent", dot: "accent" } },
      { type: "laptimer", props: { finishedColor: "accent" } },
    ],
  });
  assert.equal(old.elements[0].props.driven, "neutral");
  assert.equal(old.elements[0].props.dot, "accent"); // not one of the migrated props
  assert.equal(old.elements[1].props.finishedColor, "neutral");
  assert.equal(old.colorRoles, 2);

  // A template saved after the change keeps an explicit accent choice.
  const fresh = normalizeTemplate({ colorRoles: 2, elements: [{ type: "trackmap", props: { driven: "accent" } }] });
  assert.equal(fresh.elements[0].props.driven, "accent");
});
