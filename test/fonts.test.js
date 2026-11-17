// Web-font helpers (src/core/fonts.js), the Google Fonts catalog, and theme
// file checks (src/app/theme-library.js).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fontStack, googleCssUrl, googlePreviewUrl, nearestWeight, primaryFamily, pruneFontFaces, withFontFace } from "../src/core/fonts.js";
import { countOverrides, slug, validateTheme } from "../src/app/theme-library.js";

test("Google Fonts URLs ask only for the given weights, sorted and de-duplicated", () => {
  assert.equal(googleCssUrl("Barlow Condensed", [700, 400, 700]), "https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;700&display=swap");
  assert.equal(googleCssUrl("Bebas Neue", [400]), "https://fonts.googleapis.com/css2?family=Bebas+Neue:wght@400&display=swap");
  assert.equal(googlePreviewUrl("Teko"), "https://fonts.googleapis.com/css2?family=Teko&text=Teko");
  assert.equal(googlePreviewUrl("Exo 2"), "https://fonts.googleapis.com/css2?family=Exo+2&text=Exo%202");
});

test("font stacks quote names that need it and add a fallback", () => {
  assert.equal(fontStack("Oswald", "sans"), "Oswald, sans-serif");
  assert.equal(fontStack("Bebas Neue", "display"), "'Bebas Neue', sans-serif");
  assert.equal(fontStack("Exo 2"), "'Exo 2', sans-serif");
  assert.equal(fontStack("Roboto Mono", "mono"), "'Roboto Mono', monospace");
});

test("primaryFamily reads the first family of a stack", () => {
  assert.equal(primaryFamily("'Bebas Neue', sans-serif"), "Bebas Neue");
  assert.equal(primaryFamily('"Segoe UI", system-ui'), "Segoe UI");
  assert.equal(primaryFamily("Teko, sans-serif"), "Teko");
  assert.equal(primaryFamily(""), "");
});

test("nearestWeight picks an available weight", () => {
  assert.equal(nearestWeight([300, 400, 500, 600, 700], 800), 700);
  assert.equal(nearestWeight([400], 700), 400);
  assert.equal(nearestWeight([400, 600], 500), 600, "ties go heavier");
  assert.equal(nearestWeight(null, 650), 650);
});

test("web-font entries are replaced per family and dropped once unused; font files stay", () => {
  let faces = [{ family: "Local", src: "fonts/x.woff2" }];
  faces = withFontFace(faces, "Teko", "url1");
  faces = withFontFace(faces, "Teko", "url2");
  assert.deepEqual(faces, [{ family: "Local", src: "fonts/x.woff2" }, { family: "Teko", css: "url2" }]);
  assert.equal(pruneFontFaces(faces, { number: { family: "Teko, sans-serif" } }).length, 2);
  assert.deepEqual(pruneFontFaces(faces, { number: { family: "Oswald, sans-serif" } }), [{ family: "Local", src: "fonts/x.woff2" }]);
});

test("the font catalog lists real weights for every family", () => {
  const list = JSON.parse(readFileSync(new URL("../data/google-fonts.json", import.meta.url), "utf8"));
  assert.ok(list.length > 1000);
  for (const e of list) {
    assert.ok(e.f && Array.isArray(e.w) && e.w.length, `${e.f} has weights`);
    assert.ok(e.w.every((w) => Number.isInteger(w) && w >= 100 && w <= 900), `${e.f} weights are numbers`);
  }
  const oswald = list.find((e) => e.f === "Oswald");
  assert.deepEqual(oswald.w, [200, 300, 400, 500, 600, 700]);
});

test("theme files are checked before they're used", () => {
  const t = validateTheme({ name: "Night Run", colors: { accent: "#0af" } });
  assert.equal(t.id, "night-run");
  assert.equal(t.schema, "overlay-theme/1");
  assert.throws(() => validateTheme({ schema: "overlay-template/1", elements: [] }), /template, not a theme/);
  assert.throws(() => validateTheme({ schema: "overlay-theme/9", colors: {} }), /unsupported schema/);
  assert.throws(() => validateTheme({ foo: 1 }), /no colors, fonts or panel/);
  assert.throws(() => validateTheme([]), /not a JSON object/);
});

test("slug and countOverrides", () => {
  assert.equal(slug("Café Racer #2"), "cafe-racer-2");
  assert.equal(slug(""), "theme");
  assert.equal(countOverrides({ colors: { accent: "#fff", good: "#0f0" }, fonts: { number: { family: "x" } } }), 3);
  assert.equal(countOverrides(null), 0);
});
