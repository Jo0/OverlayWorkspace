# Extending OverlayWorkspace

Four kinds of things are meant to be added without touching the core:

| What | Where | Registered with |
|---|---|---|
| Data importer (a lap timer / logger format) | `src/importers/*.js` | `importers.register()` |
| Widget (an overlay element) | `src/widgets/*.js` | `widgets.register()` |
| Panel shape | any module | `shapes.register()` |
| Theme / template | `themes/*.json`, `templates/*.json` | the folder's `index.json` |

The registries live in `src/core/registry.js`. A module registers on import,
so new JS files must be imported from `src/importers/index.js` or
`src/widgets/index.js`.

---

## Importers

An importer turns a file into a `Session` (`src/core/session.js`):

```js
import { importers } from "../core/registry.js";
import { Channel, Session } from "../core/session.js";
import { normalizeValues } from "../core/units.js";

importers.register({
  id: "mytimer-csv",
  label: "MyTimer CSV",
  extensions: [".csv"],
  help: "In MyTimer: Session → Share → CSV.",
  // Return 0..1: how sure you are this is your format. `head` is the first 64 KB as text.
  detect: (head, file) => (head.startsWith("MyTimer export") ? 1 : 0),
  async parse(file) {
    const text = await file.text();
    // ...build Float64Arrays of times (unix seconds) and values per channel...
    const speed = new Float64Array(values);              // in km/h, say
    const { dimension, unit } = normalizeValues(speed, "km/h"); // → m/s
    return new Session({
      meta: { title, track, driver, vehicle, date, fileName: file.name },
      channels: [
        new Channel({ id: "speed", name: "Speed", unit, dimension, role: "speed", source: "gps" }, times, speed),
        // ...
      ],
      laps: [{ number: 1, fragment: 0, start, end }],   // unix seconds
      fragments: [{ id: 0, start, end }],
    });
  },
});
```

Rules:

- **Times** are Unix seconds (floats). That's what lets video, data and other
  devices line up.
- **Values** go to the dimension's base unit: m/s, m, G, deg, °C, %, rpm. Use
  `normalizeValues()` (`src/core/units.js`) and the units list there.
- **Roles** (`ROLES` in `session.js`) are how templates find channels: a
  widget prop `"@speed"` means "the channel with role speed". Tag what you
  can: speed, latitude, longitude, distance, lat_g, lon_g, rpm, throttle,
  brake, gear, steering... Without a distance channel, timing integrates speed.
- **Laps** need `start`/`end`. For a point-to-point stage, the stage is a "lap".
- Keep `parse` free of DOM code where you can (take the text, return a
  Session), so it can be unit-tested with `node --test`. See
  `test/core.test.js`.

## Widgets

```js
import { widgets } from "../core/registry.js";
import { drawPanel, drawText, CAP } from "../render/draw.js";
import { P, formatValue } from "./common.js";

widgets.register({
  id: "gear",
  label: "Gear indicator",
  description: "Current gear in a box.",
  defaults: { w: 300, h: 300, props: { channel: "@gear", panel: true } },
  // Prop descriptors drive the inspector. Types: number, text, textarea, bool,
  // color, select (options), channel, unit (of: "<channel prop>"), font, shape, image.
  props: [P.channel("Gear channel"), P.panel],
  // Optional: return a Promise that resolves when assets are ready (export waits for it).
  prepare(element) {},
  draw(ctx, { w, h, props, theme, frame, element, cache }) {
    const box = props.panel ? drawPanel(ctx, w, h, theme) : { x: 0, y: 0, w, h };
    const g = frame.value(props.channel);
    const text = Number.isFinite(g) ? (g === 0 ? "N" : String(g)) : "-";
    const size = box.h / CAP * 0.8;
    drawText(ctx, theme, text, box.x + box.w / 2, box.y + (box.h + size * CAP) / 2, { role: "number", size, align: "center" });
  },
});
```

What `draw` gets:

- **The context:** `ctx` is translated, scaled and rotated so you draw in the
  element's own design pixels, from (0, 0) to (w, h). The same code runs for
  the preview and the export.
- **`frame`:**
  - `frame.t`: the time.
  - `frame.value(ref)`: a channel value at that time, in base units. `ref`
    is `@role`, a channel id, or a virtual timing channel: `timing.elapsed`,
    `timing.delta`, `timing.predicted`, `timing.last`, `timing.best`,
    `timing.lap`, `timing.progress`, `timing.distance`, `timing.remaining`, and `timing.target` (the comparison lap's time: best, theoretical or chosen).
  - `frame.timing`: the full lap context (state, lap, last, best,
    comparison...).
  - `frame.deltaFor(mode)`: the delta against `"session"`, `"so-far"`,
    `"theoretical"` or `"template"`, as `{ delta, self, label }`. `self` means
    the lap would be compared with itself, so there's no delta to show.
  - `frame.session`: the session, for paths and history.
- **`theme`:** already merged with the element's style override. Use
  `color(theme, ref)` for color references (a theme color name or any CSS
  color) and `drawText` for text; it handles font roles, fixed-width digits
  and the theme's text outline and shadow.
- **`cache`:** a per-element `Map` for expensive things such as projected
  paths. Key what you store on whatever it depends on.
- **Missing data** comes back as NaN. Draw a placeholder; don't throw.

## Shapes

```js
import { shapes } from "../core/registry.js";
shapes.register({
  id: "hex",
  label: "Hexagon",
  // Build a path in a w×h box at (x, y). `o` is the panel settings (radius, skew, ...).
  path(ctx, x, y, w, h, o) {
    const c = Math.min(h / 2, o.radius ?? h / 4);
    ctx.moveTo(x + c, y); ctx.lineTo(x + w - c, y); ctx.lineTo(x + w, y + h / 2);
    ctx.lineTo(x + w - c, y + h); ctx.lineTo(x + c, y + h); ctx.lineTo(x, y + h / 2); ctx.closePath();
  },
});
```

Once registered, a shape is available to theme panels (`panel.shape`), bars,
the delta bar and the Shape element.

## Themes (`themes/*.json`)

```jsonc
{
  "schema": "overlay-theme/1",
  "id": "night",
  "name": "Night",
  "colors": {                 // any names; widgets default to these:
    "text": "#FFFFFF", "muted": "rgba(255,255,255,.6)", "panel": "rgba(0,0,0,.6)",
    "border": "rgba(255,255,255,.15)", "accent": "#FFB000", "neutral": "#FFB000",
    "good": "#2ED47A", "bad": "#FF4D4D", "track": "rgba(255,255,255,.45)",
    "marker": "#FFB000", "grid": "rgba(255,255,255,.16)"
  },
  "fonts": {                  // roles; widgets use display, number, label
    "display": { "family": "Oswald, sans-serif", "weight": 600 },
    "number":  { "family": "Oswald, sans-serif", "weight": 600, "tabular": true },
    "label":   { "family": "Oswald, sans-serif", "weight": 400, "letterSpacing": 0.1 }
  },
  "fontFaces": [              // optional web fonts, loaded before drawing
    { "family": "Oswald", "src": "fonts/Oswald-SemiBold.woff2", "weight": 600 }
  ],
  "panel": {
    "shape": "chamfer", "radius": 30, "corners": "tl br",
    "fill": "panel", "stroke": "border", "strokeWidth": 3, "padding": 30,
    "shadow": { "color": "rgba(0,0,0,.4)", "blur": 24, "x": 0, "y": 8 }
  },
  "text": {                   // sizes in em
    "stroke": { "color": "rgba(0,0,0,.5)", "width": 0.08 },
    "shadow": { "color": "rgba(0,0,0,.6)", "blur": 0.1, "x": 0, "y": 0.03 }
  }
}
```

Then add `{ "id": "night", "file": "night.json" }` to `themes/index.json`.

Color roles with a meaning:

- **`good` / `bad`:** gaining and losing time (map trail, run timer, delta
  bars), also throttle and brake.
- **`neutral`:** highlights that mean neither: map stretches where you're
  about even, the finished run time.
- **`accent`:** the theme's brand color, free to be any hue. Nothing that
  could be read as a gain or loss uses it, so a red accent (Broadcast) is
  fine.
- **`marker`:** the position dot, drawn on top of the gain/loss trail.

Keep `neutral`, `marker` and `track` clearly apart from `good` and `bad`.
`test/themes.test.js` checks every bundled theme for this (color difference
ΔE ≥ 25, judged over dark asphalt); add yours to `index.json` and run it.

Font notes:

- **`tabular`** lays out digits at a fixed width, so numbers don't jitter
  even when the font's digits are proportional.
- **Licences:** only bundle fonts whose licence allows redistribution (e.g.
  SIL OFL). Otherwise reference installed fonts by family name.

## Templates (`templates/*.json`)

```jsonc
{
  "schema": "overlay-template/1",
  "id": "drag",
  "name": "Drag strip",
  "sessionType": "drag",
  "canvas": { "width": 3840, "height": 2160 },   // design pixels
  "theme": "default",
  "themeOverrides": { "colors": { "accent": "#00B7FF" } },  // optional
  "timing": { "comparison": "best", "sections": 10 },  // "best", "theoretical" or a lap number; sections: parts per lap for "theoretical"
  "groups": { "g1": { "name": "Speed and pedals" } },  // optional, see below
  "elements": [
    {
      "id": "speed", "type": "readout", "name": "Speed",
      "x": 110, "y": 1700, "w": 560, "h": 360,
      "anchor": "bl",          // tl tc tr ml mc mr bl bc br
      "rotation": 0, "opacity": 1,
      "props": { "channel": "@speed", "unit": "mph", "label": "MPH" },
      "style": { "panel": { "shape": "pill" } },  // optional per-element theme override
      "group": "g1"            // optional: a key of "groups"
    }
  ]
}
```

Then add it to `templates/index.json`.

**Groups** are flat (no groups inside groups). Members are kept next to each
other in `elements`, so a group is one block in the layer order; a group needs
two or more members, and unused entries in `groups` are dropped on load.

**Anchors:** if you export at another aspect ratio (say a 9:16 vertical
video), elements scale uniformly and stay pinned to their anchor corner or
edge. A `br` element keeps its distance from the bottom-right.
