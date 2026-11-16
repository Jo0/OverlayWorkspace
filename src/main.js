// Entry point: registers plug-ins, loads the template/theme libraries, builds
// the UI.

import "./widgets/index.js";
import "./importers/index.js";
import { CONFIG } from "./config.js";
import { serializeTemplate } from "./core/template.js";
import { loadThemeFonts } from "./core/theme.js";
import { $, h, pickFile, saveTextFile } from "./app/dom.js";
import { initExportDialog } from "./app/export-dialog.js";
import { initInspector } from "./app/inspector.js";
import { initPanels, loadDataFile, loadVideoFile } from "./app/panels.js";
import { initStage, invalidate } from "./app/stage.js";
import { history, loadAutosave, on, setStatus, setTemplate, state } from "./app/state.js";
import { initTimeline } from "./app/timeline.js";

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function loadLibrary() {
  const themeList = await fetchJson("themes/index.json");
  for (const t of themeList) {
    const theme = await fetchJson(`themes/${t.file}`);
    state.themes.set(theme.id || t.id, theme);
    loadThemeFonts(theme).then(invalidate);
  }
  const tplList = await fetchJson("templates/index.json");
  state.templateList = [];
  for (const t of tplList) {
    const tpl = await fetchJson(`templates/${t.file}`);
    state.templateList.push({ id: t.id, name: tpl.name, sessionType: tpl.sessionType, data: tpl });
  }
}

function buildHeader() {
  const sel = $("#template-select");
  sel.replaceChildren(
    h("option", { value: "" }, "New from template…"),
    ...state.templateList.map((t) => h("option", { value: t.id }, t.name)),
  );
  sel.addEventListener("change", () => {
    const t = state.templateList.find((x) => x.id === sel.value);
    sel.value = "";
    if (!t) return;
    if (history.index > 0 && !confirm(`Replace the current layout with "${t.name}"? (Save it first if you want to keep it.)`)) return;
    setTemplate(structuredClone(t.data));
    setStatus(`Started from the ${t.name} template.`);
  });
  $("#btn-open").addEventListener("click", async () => {
    const f = await pickFile(".json,application/json");
    if (!f) return;
    try {
      setTemplate(JSON.parse(await f.text()));
      setStatus(`Opened ${f.name}.`, "ok");
    } catch (e) {
      setStatus(`Couldn't open ${f.name}: ${e.message}`, "error");
    }
  });
  $("#btn-save").addEventListener("click", async () => {
    const name = (state.template.name || "overlay").replace(/[^\w.-]+/g, "_");
    if (await saveTextFile(serializeTemplate(state.template), `${name}.template.json`)) setStatus("Template saved.", "ok");
  });
  $("#btn-undo").addEventListener("click", () => history.undo());
  $("#btn-redo").addEventListener("click", () => history.redo());

  const links = $("#header-links");
  if (CONFIG.supportUrl) links.append(h("a", { href: CONFIG.supportUrl, target: "_blank", rel: "noopener", class: "support" }, CONFIG.supportLabel));
  if (CONFIG.sourceUrl) links.append(h("a", { href: CONFIG.sourceUrl, target: "_blank", rel: "noopener" }, "Source"));
}

function buildStageToolbar() {
  const grid = $("#grid-size");
  grid.value = state.ui.grid;
  grid.addEventListener("input", () => { state.ui.grid = Math.max(0, Number(grid.value) || 0); invalidate(); });
  const show = $("#grid-show");
  show.checked = state.ui.showGrid;
  show.addEventListener("change", () => { state.ui.showGrid = show.checked; invalidate(); });
  const bg = $("#preview-bg");
  bg.addEventListener("change", () => { $("#stage").dataset.bg = bg.value; });
  $("#stage").dataset.bg = bg.value;
}

function initStatus() {
  const el = $("#status");
  let timer;
  on("status", ({ text, kind }) => {
    el.textContent = text;
    el.dataset.kind = kind;
    clearTimeout(timer);
    if (kind !== "error" && kind !== "warn") timer = setTimeout(() => { el.textContent = ""; }, 8000);
  });
}

/** Dev/demo convenience: ?data=<url>&video=<url>&template=<id> (same-origin paths). */
async function loadFromQuery() {
  const q = new URLSearchParams(location.search);
  const get = async (key) => {
    const url = q.get(key);
    if (!url || /^[a-z]+:/i.test(url) || url.startsWith("//")) return null;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return new File([await r.blob()], url.split("/").pop());
  };
  try {
    const tid = q.get("template");
    const t = tid && state.templateList.find((x) => x.id === tid);
    if (t) setTemplate(structuredClone(t.data));
    const data = await get("data");
    if (data) await loadDataFile(data);
    const video = await get("video");
    if (video) await loadVideoFile(video);
  } catch (e) {
    setStatus(e.message, "error");
  }
}

async function main() {
  document.title = CONFIG.appName;
  initStatus();
  try {
    await loadLibrary();
  } catch (e) {
    setStatus(`Couldn't load templates/themes: ${e.message}. Serve the folder over http (python tools/serve.py).`, "error");
    return;
  }
  if (typeof VideoEncoder === "undefined") {
    setStatus("This browser has no WebCodecs video encoder, so export won't work. Use a current Chrome, Edge or Firefox on desktop.", "error");
  }
  buildHeader();
  buildStageToolbar();
  initStage();
  initPanels();
  initInspector();
  initTimeline();
  initExportDialog();
  const saved = loadAutosave();
  try {
    setTemplate(saved || structuredClone(state.templateList.find((t) => t.id === "autocross").data));
  } catch {
    setTemplate(structuredClone(state.templateList[0].data));
  }
  await loadFromQuery();
}

main();
