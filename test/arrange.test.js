// Align, distribute, scale and groups (src/core/arrange.js), plus groups
// surviving a template save/load.

import { test } from "node:test";
import assert from "node:assert/strict";
import { align, bounds, distribute, expandToGroups, makeGroup, moveLayer, normalizeGroups, scaleInto, ungroup, units } from "../src/core/arrange.js";
import { normalizeTemplate, serializeTemplate } from "../src/core/template.js";

const el = (id, x, y, w, h, extra = {}) => ({ id, x, y, w, h, ...extra });
const tpl = (elements, groups = {}) => ({ elements, groups });
const order = (t) => t.elements.map((e) => e.id).join(" ");

test("bounds covers every element", () => {
  assert.deepEqual(bounds([el("a", 10, 20, 100, 50), el("b", 200, 0, 10, 10)]), { x: 10, y: 0, w: 200, h: 70 });
  assert.equal(bounds([]), null);
});

test("align moves each unit to the reference edge or center", () => {
  const a = el("a", 10, 10, 100, 50), b = el("b", 300, 40, 50, 50);
  const ref = bounds([a, b]);
  align(units([a, b]), "right", ref);
  assert.equal(a.x + a.w, 350);
  assert.equal(b.x + b.w, 350);
  align(units([a, b]), "vcenter", { x: 0, y: 0, w: 3840, h: 2160 });
  assert.equal(a.y + a.h / 2, 1080);
  assert.equal(b.y + b.h / 2, 1080);
});

test("a group aligns as one unit and keeps its internal layout", () => {
  const a = el("a", 0, 0, 100, 100, { group: "g" }), b = el("b", 150, 20, 50, 50, { group: "g" }), c = el("c", 500, 300, 80, 80);
  align(units([a, b, c]), "left", { x: 1000, y: 0, w: 10, h: 10 });
  assert.deepEqual([a.x, b.x, c.x], [1000, 1150, 1000]);
});

test("locked units stay put", () => {
  const a = el("a", 0, 0, 10, 10), b = el("b", 100, 0, 10, 10, { locked: true });
  align(units([a, b]), "left", { x: 50, y: 0, w: 1, h: 1 });
  assert.deepEqual([a.x, b.x], [50, 100]);
});

test("distribute makes equal gaps and keeps the outermost in place", () => {
  const a = el("a", 0, 0, 100, 10), b = el("b", 130, 0, 200, 10), c = el("c", 900, 0, 100, 10);
  distribute(units([c, a, b]), "x"); // order given doesn't matter
  assert.equal(a.x, 0);
  assert.equal(c.x, 900);
  assert.equal(b.x - (a.x + a.w), c.x - (b.x + b.w)); // gap 300 each side
  assert.equal(distribute(units([a, b]), "x"), 0, "needs 3 or more");
});

test("scaleInto maps a selection into a new box", () => {
  const els = [el("a", 100, 100, 100, 100), el("b", 300, 100, 100, 200)];
  const start = els.map((e) => ({ ...e }));
  scaleInto(els, start, bounds(start), { x: 100, y: 100, w: 600, h: 400 });
  assert.deepEqual(els.map((e) => [e.x, e.y, e.w, e.h]), [[100, 100, 200, 200], [500, 100, 200, 400]]);
});

test("expandToGroups selects whole groups", () => {
  const t = tpl([el("a", 0, 0, 1, 1, { group: "g" }), el("b", 0, 0, 1, 1, { group: "g" }), el("c", 0, 0, 1, 1)]);
  assert.deepEqual(expandToGroups(t, ["b"]), ["a", "b"]);
  assert.deepEqual(expandToGroups(t, ["c"]), ["c"]);
});

test("makeGroup names the group and makes members contiguous at the topmost one", () => {
  const t = tpl([el("a", 0, 0, 1, 1), el("b", 0, 0, 1, 1), el("c", 0, 0, 1, 1), el("d", 0, 0, 1, 1)]);
  const gid = makeGroup(t, ["a", "c"]);
  assert.equal(t.groups[gid].name, "Group 1");
  assert.equal(order(t), "b a c d", "a moved up next to c, keeping a below c");
  assert.equal(makeGroup(t, ["d"]), null, "one element isn't a group");
  ungroup(t, ["a"]);
  assert.ok(!t.elements.some((e) => e.group));
  assert.deepEqual(t.groups, {});
});

test("normalizeGroups drops one-member groups and fills in names", () => {
  const t = tpl([el("a", 0, 0, 1, 1, { group: "x" }), el("b", 0, 0, 1, 1, { group: "y" }), el("c", 0, 0, 1, 1, { group: "y" })], { x: { name: "X" } });
  normalizeGroups(t);
  assert.equal(t.elements[0].group, undefined);
  assert.deepEqual(t.groups, { y: { name: "Group" } });
});

test("moveLayer moves whole groups past neighbours, and members within their group", () => {
  const t = tpl([el("a", 0, 0, 1, 1), el("b", 0, 0, 1, 1, { group: "g" }), el("c", 0, 0, 1, 1, { group: "g" }), el("d", 0, 0, 1, 1)]);
  assert.ok(moveLayer(t, "b", 1)); // group forward past d
  assert.equal(order(t), "a d b c");
  assert.ok(moveLayer(t, "b", 1, true)); // b above c inside the group
  assert.equal(order(t), "a d c b");
  assert.ok(!moveLayer(t, "b", 1, true), "can't leave the group");
  assert.ok(moveLayer(t, "a", 1));
  assert.equal(order(t), "d a c b", "a single element hops over a single neighbour");
  assert.ok(moveLayer(t, "a", 1));
  assert.equal(order(t), "d c b a", "and over a whole group");
});

test("groups survive a template save and load", () => {
  const t = normalizeTemplate({
    elements: [
      { id: "a", type: "text", group: "g1" },
      { id: "b", type: "text" },
      { id: "c", type: "text", group: "g1" },
    ],
    groups: { g1: { name: "Timing" } },
  });
  assert.equal(order(t), "b a c");
  const back = normalizeTemplate(JSON.parse(serializeTemplate(t)));
  assert.deepEqual(back.groups, { g1: { name: "Timing" } });
  assert.deepEqual(back.elements.map((e) => e.group), [undefined, "g1", "g1"]);
  const plain = JSON.parse(serializeTemplate(normalizeTemplate({ elements: [{ id: "z", type: "text" }] })));
  assert.equal(plain.groups, undefined, "no groups key when there are none");
  assert.equal(plain.elements[0].group, undefined);
});
