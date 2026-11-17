// Arranging elements: bounds, align, distribute, scale, and groups. Pure
// functions over a template, no DOM, so they're testable in Node.
//
// Groups are flat: an element has an optional `group` id, and the template
// has `groups: { [id]: { name } }`. Members are kept next to each other in
// the element list (normalizeGroups), so a group is one block in the layer
// order and the Layers panel can show it as one row with its members under it.

/** Bounding box of elements (rotation ignored), or null for none. */
export function bounds(els) {
  if (!els.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of els) {
    x0 = Math.min(x0, e.x);
    y0 = Math.min(y0, e.y);
    x1 = Math.max(x1, e.x + e.w);
    y1 = Math.max(y1, e.y + e.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Splits a selection into units that move as one when aligning or
 * distributing: each group in it is one unit, every other element its own.
 * @returns [{ els, rect, locked }]
 */
export function units(els) {
  const byGroup = new Map();
  const out = [];
  for (const e of els) {
    if (e.group) {
      let u = byGroup.get(e.group);
      if (!u) { u = { els: [] }; byGroup.set(e.group, u); out.push(u); }
      u.els.push(e);
    } else out.push({ els: [e] });
  }
  for (const u of out) {
    u.rect = bounds(u.els);
    u.locked = u.els.some((e) => e.locked);
  }
  return out;
}

function shift(u, dx, dy) {
  for (const e of u.els) { e.x = Math.round(e.x + dx); e.y = Math.round(e.y + dy); }
}

export const ALIGN_EDGES = ["left", "hcenter", "right", "top", "vcenter", "bottom"];

/**
 * Aligns units to an edge or center of `ref` (a rect: the selection's bounds
 * or the canvas). Locked units stay put. Returns how many units moved.
 */
export function align(us, edge, ref) {
  let moved = 0;
  for (const u of us) {
    if (u.locked) continue;
    const r = u.rect;
    let dx = 0, dy = 0;
    if (edge === "left") dx = ref.x - r.x;
    else if (edge === "hcenter") dx = ref.x + ref.w / 2 - (r.x + r.w / 2);
    else if (edge === "right") dx = ref.x + ref.w - (r.x + r.w);
    else if (edge === "top") dy = ref.y - r.y;
    else if (edge === "vcenter") dy = ref.y + ref.h / 2 - (r.y + r.h / 2);
    else if (edge === "bottom") dy = ref.y + ref.h - (r.y + r.h);
    else throw new Error(`Unknown edge ${edge}`);
    if (Math.round(dx) || Math.round(dy)) { shift(u, dx, dy); moved++; }
  }
  return moved;
}

/**
 * Spaces units evenly along an axis ("x" or "y"): the first and last stay
 * where they are and the gaps between neighbours become equal. Needs 3+.
 * Locked units in the middle keep their place and are spaced around.
 */
export function distribute(us, axis) {
  if (us.length < 3) return 0;
  const P = axis === "x" ? "x" : "y", S = axis === "x" ? "w" : "h";
  const sorted = [...us].sort((a, b) => a.rect[P] - b.rect[P] || a.rect[S] - b.rect[S]);
  const first = sorted[0].rect, last = sorted[sorted.length - 1].rect;
  const span = last[P] + last[S] - first[P];
  const total = sorted.reduce((a, u) => a + u.rect[S], 0);
  const gap = (span - total) / (sorted.length - 1);
  let pos = first[P] + first[S] + gap, moved = 0;
  for (const u of sorted.slice(1, -1)) {
    const d = pos - u.rect[P];
    if (!u.locked && Math.round(d)) {
      shift(u, P === "x" ? d : 0, P === "y" ? d : 0);
      moved++;
    }
    pos += u.rect[S] + gap;
  }
  return moved;
}

/**
 * Resizes a set of elements together: positions and sizes are mapped from
 * rect `from` to rect `to` (both design px), as when dragging a handle of a
 * multi-selection. `start` holds each element's geometry when the drag began.
 */
export function scaleInto(els, start, from, to) {
  const sx = from.w ? to.w / from.w : 1, sy = from.h ? to.h / from.h : 1;
  els.forEach((e, i) => {
    const s = start[i];
    const x0 = to.x + (s.x - from.x) * sx, y0 = to.y + (s.y - from.y) * sy;
    const x1 = to.x + (s.x + s.w - from.x) * sx, y1 = to.y + (s.y + s.h - from.y) * sy;
    e.x = Math.round(x0);
    e.y = Math.round(y0);
    e.w = Math.max(1, Math.round(x1) - Math.round(x0));
    e.h = Math.max(1, Math.round(y1) - Math.round(y0));
  });
}

// ── Groups ───────────────────────────────────────────────────────────────────

let groupCounter = 0;
export function newGroupId() {
  groupCounter += 1;
  return `group-${Date.now().toString(36)}-${groupCounter}`;
}

/** Every element id in the same groups as `ids` (selecting one member selects its group). */
export function expandToGroups(template, ids) {
  const groups = new Set();
  for (const e of template.elements) if (ids.includes(e.id) && e.group) groups.add(e.group);
  if (!groups.size) return [...ids];
  const out = new Set(ids);
  for (const e of template.elements) if (e.group && groups.has(e.group)) out.add(e.id);
  return template.elements.filter((e) => out.has(e.id)).map((e) => e.id);
}

export function groupMembers(template, groupId) {
  return template.elements.filter((e) => e.group === groupId);
}

/**
 * Groups elements (two or more). Elements already in other groups move into
 * the new one. Returns the new group id, or null if there's nothing to group.
 */
export function makeGroup(template, ids, name) {
  const members = template.elements.filter((e) => ids.includes(e.id));
  if (members.length < 2) return null;
  const id = newGroupId();
  template.groups = template.groups || {};
  template.groups[id] = { name: name || nextGroupName(template) };
  for (const e of members) e.group = id;
  normalizeGroups(template);
  return id;
}

/** Ungroups the groups of the given elements. Returns the ids of the freed elements. */
export function ungroup(template, ids) {
  const groups = new Set(template.elements.filter((e) => ids.includes(e.id) && e.group).map((e) => e.group));
  const freed = [];
  for (const e of template.elements) {
    if (e.group && groups.has(e.group)) { delete e.group; freed.push(e.id); }
  }
  normalizeGroups(template);
  return freed;
}

function nextGroupName(template) {
  const used = new Set(Object.values(template.groups || {}).map((g) => g.name));
  let n = 1;
  while (used.has(`Group ${n}`)) n++;
  return `Group ${n}`;
}

/**
 * Keeps groups consistent: members sit next to each other in the element list
 * (at the place of the group's topmost member, keeping their order), every
 * group in use has an entry with a name, and unused or one-member groups go.
 */
export function normalizeGroups(template) {
  const els = template.elements;
  const groups = { ...(template.groups || {}) };
  const counts = new Map();
  for (const e of els) if (e.group) counts.set(e.group, (counts.get(e.group) || 0) + 1);
  for (const e of els) if (e.group && counts.get(e.group) < 2) delete e.group;
  // Rebuild the list: walking top (end) to bottom, a group's block lands where its topmost member is.
  const out = [];
  const placed = new Set();
  for (let i = els.length - 1; i >= 0; i--) {
    const e = els[i];
    if (!e.group) { out.push(e); continue; }
    if (placed.has(e.group)) continue;
    placed.add(e.group);
    const members = els.filter((m) => m.group === e.group);
    for (let k = members.length - 1; k >= 0; k--) out.push(members[k]);
  }
  out.reverse();
  els.splice(0, els.length, ...out);
  const kept = {};
  for (const id of placed) kept[id] = { name: (groups[id] && groups[id].name) || "Group" };
  template.groups = kept;
  return template;
}

/**
 * Moves a layer-list unit (an ungrouped element, or a whole group) one step
 * up (+1, towards the front) or down (-1) past its neighbouring unit. A
 * grouped element alone (single=true) moves only within its group.
 */
export function moveLayer(template, id, dir, single = false) {
  const els = template.elements;
  const el = els.find((e) => e.id === id);
  if (!el) return false;
  if (single && el.group) {
    const i = els.indexOf(el), j = i + dir;
    if (j < 0 || j >= els.length || els[j].group !== el.group) return false;
    [els[i], els[j]] = [els[j], els[i]];
    return true;
  }
  // Blocks: each ungrouped element, or each group, as [start, end) in the list.
  const blocks = [];
  for (let i = 0; i < els.length;) {
    let j = i + 1;
    if (els[i].group) while (j < els.length && els[j].group === els[i].group) j++;
    blocks.push(els.slice(i, j));
    i = j;
  }
  const k = blocks.findIndex((b) => b.includes(el));
  const m = k + dir;
  if (m < 0 || m >= blocks.length) return false;
  [blocks[k], blocks[m]] = [blocks[m], blocks[k]];
  els.splice(0, els.length, ...blocks.flat());
  return true;
}
