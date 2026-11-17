# OverlayWorkspace

[![Support me on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/badjo0jo0)

Design telemetry overlays for your onboard video on a full-size screen, from
your lap timer's data export, and render them as an overlay video plus an
alpha matte that any editor (or ffmpeg) can put over your footage.

- **Exact layout.** Every element has pixel coordinates and a size on a 4K
  design canvas. Drag it, or type the numbers. Snap to a grid and to other
  elements' edges and centers. Select several to move, resize, align or
  distribute them together, and group the ones that belong together.
- **Your own footage underneath.** Load the clip, rotate it if the camera was
  mounted upside down, and line the data up with it.
- **Templates per kind of session.** Autocross, track day, rally stage, and
  blank. Save your own as `.template.json` files.
- **Themes.** Named colors, font roles, panel shapes, text outline and shadow.
  Change them per template, or per element with a style override. Pick fonts
  from Google Fonts (previewed in the picker) or your installed fonts, and save
  the result as a theme file to reuse or share.
- **Runs in the browser.** Everything happens on your computer; files are
  never uploaded. Export uses the browser's built-in video encoder (WebCodecs),
  hardware-accelerated where available.

**Use it online: <https://jo0.github.io/OverlayWorkspace/>** (nothing to
install; your files still stay on your computer).

Data sources, and how far each has been tested:

| Format | How it loads | Tested with |
|---|---|---|
| **RaceChrono Pro** CSV v3 | Laps and every channel | Real sessions ✅ |
| **VBO** from RaceChrono | Laps from the start/finish lines in the file | Real exports ✅ (matches the CSV of the same session) |
| **VBO** from a Racelogic VBOX, Harry's LapTimer, TrackAddict | Same importer | ⚠️ Untested: no sample files. Column names and the start/finish line format may differ |
| **TrackAddict** CSV | Any-CSV importer: you confirm the columns | ⚠️ Untested with a real export (built from forum descriptions) |
| **RaceCapture** log | Any-CSV importer | ⚠️ Untested with a real log (header format taken from its open-source firmware) |
| **AiM Race Studio** CSV | Any-CSV importer, laps from its beacon markers | ⚠️ Untested: never seen a real export, so this is the shakiest |
| **Any other CSV** with a header row | You pick time, position, speed and lap once per layout | Synthetic files |

None of these formats except VBO publishes a specification, so a real file is
the only way to be sure. If yours doesn't load right, or your lap timer isn't
listed, [open an issue](https://github.com/Jo0/OverlayWorkspace/issues/new/choose)
and pick the matching template: it lists exactly which files to attach. They
hold your GPS track, so a session at a public track is best.

Data without laps gets them from start/finish lines you place on the track.
More lap timers and loggers plug in as importers; see
[docs/EXTENDING.md](docs/EXTENDING.md).

## Running it

It's a static site: no build step, no dependencies. To run your own copy:

```bash
python tools/serve.py
```

Then open <http://127.0.0.1:8765/>. Any static host works too (GitHub Pages,
Netlify, a USB stick with a local server). It has to be served over http(s):
browsers don't allow ES modules from `file://`.

Browser: current **Chrome or Edge** on desktop is the main target (WebCodecs,
File System Access for writing straight to a folder).

**Firefox** works too (tested with Firefox 160 on Windows: editing, previewing
DJI 4K 120 fps HEVC clips, and export). Two differences:

- Exports download instead of being written into a folder (Firefox has no
  File System Access API).
- Firefox gives web pages only a software H.264 encoder, so export is slower:
  about 12 fps at 4K and 40 fps at 1080p on the test machine, roughly a third
  of Chrome's hardware speed. A 70 s run at 4K 59.94 takes about 6 minutes.

(Firefox's encoder also uses B-frames and writes a malformed decoder header;
the MP4 writer handles both, see `src/export/mp4-writer.js`.) Safari is
untested.

## Workflow

1. **Load the data.** In RaceChrono Pro: open the session, Export → CSV v3,
   scope *whole session*. Load the `.csv`. Laps and fragments show in the Data
   panel.
   - **Several files of one session** (RaceChrono's VBO export writes
     `_start`, `_resume…` files): select them all in **Load data…**.
   - **Another CSV:** the app shows the first rows and its guess of which
     column is what. Fix anything wrong and **Import**; **Columns…** in the
     Data panel changes it later.
   - **No laps in the data, or wrong ones:** **Start/finish lines…** shows
     the GPS track. Click the start line (and the finish, for autocross or a
     stage; tick *Circuit* for one line). Each line faces the way you drove
     there; laps only count crossings in that direction and within the
     line's width, so a course that passes near the start doesn't trigger
     it. The laps found are listed before you apply them, and the lines are
     remembered for that file. Skip ticks and official results stay with
     their run numbers.
2. **Pick the template**, then adjust it: move and resize elements on the
   stage, fine-tune them in the inspector. With nothing selected, the
   inspector edits the template itself: canvas size, theme, colors, fonts,
   panel shape. Save it (**Save…**) to reuse it at the next event.
   - **Theme editor:** with nothing selected, the inspector edits the theme:
     colors, fonts (**Choose…** opens the font picker), panels, text outline
     and shadow. Changes belong to the template until you **Save as
     theme…**, which writes a `.theme.json` file and adds it to *your themes*
     in the Theme menu. **Open theme…** loads one. A template saved with one
     of your themes carries a copy of it, so it opens the same elsewhere.
   - **Fonts:** Google Fonts are free to use in videos and load from
     fonts.googleapis.com when a theme uses them (so the editor needs internet
     for them). An installed font works only on computers that have it; Chrome
     and Edge can list yours, other browsers take the name typed in.
   - **Several at once:** Shift-click, drag a box over empty space, or
     Ctrl+A. Drag any of them to move them all; the handles resize them
     together. The inspector then aligns them (to each other or to the
     canvas) and spaces them out evenly.
   - **Groups:** Ctrl+G groups the selection, Ctrl+Shift+G ungroups. A click
     on the stage takes the whole group; Ctrl-click or double-click picks one
     element in it. In Layers a group is one row you can hide, lock or move
     forward and back as a block.
3. **Set up the lap timing** in the Data panel. These settings only change
   what the gauges *show*. They don't choose which laps get exported.
   - **Skip:** leaves a lap out of "best" and out of the comparison, e.g. a
     lap that isn't a run. A skipped lap still shows its own timer and still
     exports.
   - **Official results:** what the timing sheet says about each run: the
     official (timing-light) time, cones, and off course / DNF / DSQ /
     rerun. Open it from the prompt above the run table, a run's **Res**
     cell (＋), or the run timer's settings. Type them in, or paste your row from the results page (AXware
     style `68.849+1  70.123+OC  DNF`; names and car numbers are ignored).
     Each cone adds the session's penalty (1 s by default). The run timer
     shows the GPS time while running and the official time at the finish,
     with the cones or status beside it: `1:08.849 +2`, `1:11.700 OC`. Best
     and the comparison go by the time as it counts, so a clean run beats a
     faster one with cones; off-course, DNF, DSQ and reruns can't be best and
     stay out of the theoretical best. Lap exports record the result in their
     `.overlay.json`.
   - **Cmp:** picks the comparison lap for the delta. The default is the best
     run as it counts.
   - Skip ticks and official results are kept in this browser for that data
     file, so loading it again brings them back.
   - **Compare to theoretical:** compares against your theoretical best: the
     fastest time through each part of the lap, taken from any non-skipped lap
     and joined into one target. This gives a useful delta even on your best
     lap. Each lap is cut into equal parts (10 by default; set it in the
     template inspector). More parts give a lower, more optimistic target. On
     2026-11-15 it was 1:08.136 with 10 parts, against a best lap of 1:08.849.
     How the parts are found: RaceChrono's "optimal lap" needs sectors defined
     on the track, and an autocross course has none. Here every lap is cut at
     the same fractions of its own GPS distance (10 %, 20 %, …). On the same
     course those fractions land on nearly the same spot each lap, within a
     few metres, because the lines differ slightly.
   - **Delta pane:** the *Deltas* element shows up to three rows. Δ SESSION
     compares against the session's best lap, in hindsight (run 3 against run
     10). Δ BEST compares against the best lap before this one, which is what
     a live lap timer would have shown. Δ THEO compares against the
     theoretical best. A single *Delta* element can use any of these, or the
     template setting; write `{cmp}` in its label to show which. A row with
     nothing to compare against (the best lap against itself, or the first lap
     for Δ BEST) shows a muted `-.--`. A value that rounds to 0.00 stays
     muted, so it doesn't flicker red and green.
   - **Gain/loss on the map:** the track map colors the part already driven
     green where you gained time and red where you lost it, judged over about
     a second. The default (*Auto*) compares against the session best and
     switches to the theoretical best when you're watching the best lap. A
     "vs SESSION" / "vs THEO" label on the map says which. You can set the
     comparison and the colors in the map's settings, or choose *One color*
     for a plain trail.
   - **Run timer colors:** turn on *Color the time by the delta* in the run
     timer's settings and the running time turns green while you're ahead of
     the comparison and red while you're behind. It uses the same comparison
     choices and best-lap fallback as the map, and the title shows which
     ("RUN 10 · vs THEO"). Within half a hundredth it keeps its normal color.
     Turn off *Also color the final time by the delta* to keep the usual
     finished color for the final time.
4. **Load the video and sync it** to preview the overlay on your footage. The
   file's recording time is the first guess; the camera clock is usually off.
   - **Auto-sync from GPS:** for a DJI Osmo Action with a GPS remote, the app
     matches the camera's GPS track to the session's and sets the offset to a
     few hundredths of a second. For a flipped or re-encoded copy, it asks for
     the original camera file or its `.nmea`. On autocross every run follows
     the same line, so one clip could match the wrong run; the DJI remote's own
     clock settles that. Several `.nmea` files picked together do too.
   - **GoPro:** models with GPS (HERO5–HERO11 Black, HERO13 Black, MAX) work
     the same way, from the clip's own telemetry. GoPro GPS records real UTC
     time, so the sync works even when the camera's clock or time zone is
     hours off, and the run is never confused with another. The HERO12 Black,
     HERO11 Mini and HERO10 Bones have no GPS. The camera needs a GPS lock:
     open sky, and up to a minute after power-on. (Tested on GoPro's own
     sample clips and on synthetic data; not yet on a real track session.
     If you have a GoPro clip with lap timer data from the same session,
     please open an issue.)
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
     into a folder. Elsewhere (Firefox, the Claude app's browser pane), the
     files download. Clear old exports out of Downloads first: if a name is
     taken, the browser saves it as `name(1).mp4`, and the `.overlay.json`
     then points at the old file.

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
src/widgets/              overlay elements (readout, timer, delta, delta pane, dial, bar, trace graph, G circle, map, text, shape, image)
src/render/               renderer, drawing helpers, panel shapes
src/export/               WebCodecs exporter, MP4 writer, file sinks
src/video/                video recording time, camera GPS tracks (DJI, GoPro GPMF), NMEA reader
src/app/                  editor UI: stage, inspector, panels, timeline, export dialog
templates/, themes/       JSON, listed in each folder's index.json
data/google-fonts.json    font picker catalog (tools/update-google-fonts.py rebuilds it)
test/                     node --test unit tests (synthetic data)
tools/serve.py            local dev server
tools/update-google-fonts.py  refreshes data/google-fonts.json from Google Fonts' public metadata
```

## Development

```bash
node --test test/*.test.js   # unit tests: importer, timing, results, units, placement, MP4 writer, arrange, fonts, themes, GoPro GPS
```

One GoPro test also reads GoPro's own sample clips when they're in
`samples/gopro/` (skipped otherwise):

```bash
mkdir -p samples/gopro && for f in hero6 hero8; do curl -L -o samples/gopro/$f.mp4 https://raw.githubusercontent.com/gopro/gpmf-parser/main/samples/$f.mp4; done
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
- [x] VBO importer (VBOX, RaceChrono, Harry's LapTimer, TrackAddict), generic
      CSV with column mapping, laps from start/finish lines
- [ ] Dedicated importers once someone shares sample files: TrackAddict, AiM,
      RaceCapture (the generic CSV covers them meanwhile); NMEA, GoPro GPMF
      and DJI telemetry as data sources
- [x] Auto-sync from the camera's own GPS track (DJI with a GPS remote, or NMEA)
- [x] Auto-sync for GoPro (GPMF GPS); still to confirm on a real track session
- [x] Official times / penalties per lap (autocross cones), shown on the timer
- [x] Multi-select, alignment tools, element groups
- [x] Web font picker; theme editor that can save a theme file
- [x] Logos and images (PNG, JPG, WebP, SVG) embedded in the template
- [ ] Logo tint: recolor a one-colour logo to a theme color, so it follows
      theme changes
- [ ] Warn about (and offer to shrink) large embedded images: they're stored
      in the template, and a few MB can silently break the browser autosave
- [ ] Custom panel outlines from an SVG, scaled 9-slice style so corners and
      stroke widths keep their size while the panel stretches
- [ ] Custom gauges designed as SVGs, with parts bound to data (a needle that
      rotates with speed, text that shows lap time), drawn natively so 4K
      exports stay fast

Want a format, camera or feature that isn't here?
[Open an issue](https://github.com/Jo0/OverlayWorkspace/issues/new/choose):
the templates ask for what's needed to build it in one go.

## License

MIT, see [LICENSE](LICENSE). Use it, fork it, host it; keep the copyright notice.
