// Small DOM helpers: h() element builder and file open/save.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, "");
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

/** Opens a file picker; resolves to a File or null. */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept, style: { display: "none" } });
    input.addEventListener("change", () => {
      resolve(input.files && input.files[0] ? input.files[0] : null);
      input.remove();
    });
    input.addEventListener("cancel", () => { resolve(null); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
}

/** Opens a multi-select file picker; resolves to an array of Files (possibly empty). */
export function pickFiles(accept) {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept, multiple: true, style: { display: "none" } });
    input.addEventListener("change", () => { resolve([...(input.files || [])]); input.remove(); });
    input.addEventListener("cancel", () => { resolve([]); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Saves text through the browser's save dialog, or as a download where there
 * is none. Returns { status: "saved" | "downloaded" | "cancelled", reason? }.
 *
 * Embedded browsers (the Claude app's pane among them) can create the picked
 * file and then fail to write it, sometimes reporting AbortError as if the
 * user had cancelled. That left empty files behind, so a write that fails or
 * comes out the wrong size falls back to a download instead.
 */
export async function saveTextFile(text, suggestedName, type = "application/json") {
  const blob = new Blob([text], { type });
  if (window.showSaveFilePicker) {
    let handle;
    try {
      handle = await window.showSaveFilePicker({ suggestedName, types: [{ description: "JSON", accept: { [type]: [".json"] } }] });
    } catch (e) {
      if (e.name === "AbortError") return { status: "cancelled" };
      return { ...download(blob, suggestedName), reason: e.message || e.name };
    }
    try {
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      const written = await handle.getFile();
      if (written.size !== blob.size) throw new Error(`only ${written.size} of ${blob.size} bytes were written`);
      return { status: "saved", name: handle.name };
    } catch (e) {
      return { ...download(blob, suggestedName), reason: e.message || e.name };
    }
  }
  return download(blob, suggestedName);
}

function download(blob, suggestedName) {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: suggestedName });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { status: "downloaded", name: suggestedName };
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}
