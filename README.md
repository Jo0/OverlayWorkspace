# OverlayWorkspace

Design telemetry overlays for your onboard video on a full-size screen, from
your lap timer's data export, and render them as an overlay video plus an
alpha matte that any editor (or ffmpeg) can put over your footage.

- **Exact layout.** Every element has pixel coordinates and a size on a 4K
  design canvas. Drag it, or type the numbers. Snap to a grid and to other
  elements' edges and centers.
- **Your own footage underneath.** Load the clip, rotate it if the camera was
  mounted upside down, and line the data up with it.
- **Templates per kind of session.** Autocross, track day, rally stage, and
  blank. Save your own as `.template.json` files.
- **Themes.** Named colors, font roles, panel shapes, text outline and shadow.
  Change them per template, or per element with a style override.
- **Runs in the browser.** Everything happens on your computer; files are
  never uploaded. Export uses the browser's built-in video encoder (WebCodecs),
  hardware-accelerated where available.

Data sources: **RaceChrono Pro** (CSV v3) for now. Other lap timers and loggers
plug in as importers; see [docs/EXTENDING.md](docs/EXTENDING.md).

## Running it

It's a static site: no build step, no dependencies.

```bash
python tools/serve.py
```

Then open <http://127.0.0.1:8765/>. Any static host works too (GitHub Pages,
Netlify, a USB stick with a local server). It has to be served over http(s):
browsers don't allow ES modules from `file://`.

Browser: current **Chrome or Edge** on desktop is the main target (WebCodecs,
File System Access for writing straight to a folder). Firefox and Safari have
WebCodecs as well, but they're untested; without the File System Access API,
exports download instead.

## Workflow

1. **Load the data.** In RaceChrono Pro: open the session, Export → CSV v3,
   scope *whole session*. Load the `.csv`. Laps and fragments show in the Data
   panel.
2. **Pick the template**, then adjust it: move and resize elements on the
   stage, fine-tune them in the inspector. With nothing selected, the
   inspector edits the template itself: canvas size, theme, colors, fonts,
   panel shape. Save it (**Save…**) to reuse it at the next event.
3. **Set up the lap timing** in the Data panel. These settings only change
   what the gauges *show*. They don't choose which laps get exported.
   - **Skip:** leaves a lap out of "best" and out of the comparison (cones,
     DNF, off-course). RaceChrono can't know about those. A skipped lap still
     shows its own timer and still exports.
   - **Cmp:** picks the comparison lap for the delta. The default is the best
     non-skipped lap.
   - **Compare to theoretical:** compares against your theoretical best: the
     fastest time through each part of the lap, taken from any non-skipped lap
     and joined into one target. This gives a useful delta even on your best
     lap. Each lap is cut into equal parts (10 by default; set it in the
     template inspector). More parts give a lower, more optimistic target. On
     2026-11-15 it was 1:08.136 with 10 parts, against a best lap of 1:08.849.
     Write `{cmp}` in a delta label to show what it compares against: "Δ THEO",
     "Δ BEST" or "Δ LAP 7".
4. **Load the video and sync it** to preview the overlay on your footage. The
   file's recording time is the first guess; the camera clock is usually off.
   - **Auto-sync from GPS:** for a DJI Osmo Action with a GPS remote, the app
     matches the camera's GPS track to the session's and sets the offset to a
     few hundredths of a second. For a flipped or re-encoded copy, it asks for
     the original camera file or its `.nmea`. On autocross every run follows
     the same line, so one clip could match the wrong run; the DJI remote's own
     clock settles that. Several `.nmea` files picked together do too.
   - **By hand:** move the video to the frame where you cross the start line,
     choose "start of Lap N" and click **Sync**. Or type the offset under
     *Or set the offset by number*.

   Sync is needed for the **Whole video clip** export (step 5), and that
   export's JSON is what records where the overlay sits in the clip. For the
   other export ranges the video is only a preview.
5. **Export.** Every export produces the overlay only, never the video with
   the overlay burned in:
   - `<name>.mp4`: the overlay, on black;
   - `<name>_alpha.mp4`: the matte (white = opaque);
   - `<name>.overlay.json`: the data time of the first frame and, with a
     synced video, where that falls in the clip.

   What to export:

   | Range | What you get | Typical use |
   |---|---|---|
   | **Whole video clip** | One overlay for the loaded clip's full length, placed by the sync | Autocross: one clip per run |
   | **Every lap** | One overlay per lap in the session, all laps (Skip doesn't exclude). *Lead-in* and *Run-out* add time before and after each lap | A batch with no video loaded |
   | **Lap N** | One lap, with lead-in and run-out | A single run or lap |
   | **Fragment N** | One continuous recording segment | Track day: a whole session out on track |
   | **Whole session** | Everything | Rarely needed |

   - **Size:** export at your footage's size (3840×2160 for 4K).
   - **Frame rate:** 59.94 is plenty for gauges, and twice as fast as 119.88.
   - **Saving:** in Chrome or Edge, *Choose folder & export* writes straight
     into a folder. Elsewhere (including the Claude app's browser pane), use
     *Download files instead*.

   If the clip will be trimmed later (CameraWorkflow's `trim`), give the
   overlay at least as much lead-in as the trim keeps. Otherwise the first
   seconds of the trimmed clip have no overlay.

### Putting the overlay on the video

Editors: use the `_alpha.mp4` as the overlay's alpha matte (DaVinci Resolve:
Color page → drag the matte into the node graph → *Add Alpha Output*).

ffmpeg, with the overlay exported at the video's size and `START` taken from
`video.overlayStartsAt` in the JSON:

```bash
ffmpeg -i clip.mp4 -itsoffset START -i name.mp4 -itsoffset START -i name_alpha.mp4 \
  -filter_complex "[2]scale=in_range=tv:out_range=pc,format=gray[a];[1][a]alphamerge[ov];[0][ov]overlay=eof_action=pass" \
  -c:a copy out.mp4
```

The matte is ordinary limited-range video, so expand it to full range first
(the `scale=in_range=tv:out_range=pc` step). Otherwise black isn't fully
transparent and white isn't fully opaque. Overlay colors are straight (not
premultiplied).

## Project layout

```
index.html, css/          the editor shell
src/main.js               startup: loads templates/themes, builds the UI
src/config.js             per-deployment settings (support link, source link)
src/core/                 data model, timing, units, templates, themes, registries
src/importers/            one file per data format (RaceChrono CSV v3 so far)
src/widgets/              overlay elements (readout, timer, delta, dial, bar, G circle, map, text, shape, image)
src/render/               renderer, drawing helpers, panel shapes
src/export/               WebCodecs exporter, MP4 writer, file sinks
src/video/                video recording time, DJI GPS track, NMEA reader
src/app/                  editor UI: stage, inspector, panels, timeline, export dialog
templates/, themes/       JSON, listed in each folder's index.json
test/                     node --test unit tests (synthetic data)
tools/serve.py            local dev server
```

## Development

```bash
node --test test/*.test.js   # unit tests: importer, timing, units, placement, MP4 writer
```

The dev server accepts `PUT /samples/out/<file>` so automated browser tests can
save renders. `samples/` is git-ignored: keep real sessions and footage there.
`?data=samples/x.csv&video=samples/y.mp4&template=autocross` loads files on
startup (same-origin paths only).

## Status / roadmap

- [x] RaceChrono CSV v3 import, lap timing with delta, skip and comparison laps
- [x] Layout editor with exact coordinates, snapping, undo, layers
- [x] Templates: autocross, track day, rally stage; themes: default, broadcast, minimal
- [x] Overlay and alpha matte export (H.264 via WebCodecs), JSON sidecar
- [ ] More importers: RaceChrono VBO/NMEA, TrackAddict, Harry's LapTimer,
      AiM/RaceCapture CSV, GoPro GPMF, DJI (camera GPS via the remote)
- [x] Auto-sync from the camera's own GPS track (DJI with a GPS remote, or NMEA)
- [ ] Auto-sync for GoPro (GPMF GPS)
- [ ] Official times / penalties per lap (autocross cones), shown on the timer
- [ ] Multi-select, alignment tools, element groups
- [ ] Web font picker; theme editor that can save a theme file
