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

export async function saveTextFile(text, suggestedName, type = "application/json") {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName, types: [{ description: "JSON", accept: { [type]: [".json"] } }] });
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      return true;
    } catch (e) {
      if (e.name === "AbortError") return false;
      throw e;
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: suggestedName });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}
