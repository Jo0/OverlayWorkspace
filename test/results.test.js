// Official results per run (src/core/results.js) and how they change timing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { countedTime, parseResults, parseTime, rawTime, resultMark } from "../src/core/results.js";
import { Timing } from "../src/core/timing.js";
import { parseRaceChronoV3 } from "../src/importers/racechrono-csv-v3.js";
import { syntheticCsv } from "./synthetic.js";

const runs = (text) => parseResults(text).runs.map((r) => [Number.isFinite(r.official) ? r.official : null, r.cones, r.status]);

test("pasted results: AXware-style tokens", () => {
  assert.deepEqual(runs("68.849+1  70.123+OC  69.019  DNF"), [[68.849, 1, ""], [70.123, 0, "oc"], [69.019, 0, ""], [null, 0, "dnf"]]);
});

test("pasted results: a whole row, names and car numbers ignored", () => {
  const r = parseResults("1  P  12  Some Driver  BMW M2  SS  68.849+1  69.123  70.001+OFF");
  assert.deepEqual(r.runs.map((x) => [x.official, x.cones, x.status]), [[68.849, 1, ""], [69.123, 0, ""], [70.001, 0, "oc"]]);
  assert.ok(r.skipped.includes("12") && r.skipped.includes("BMW"));
});

test("pasted results: other spellings", () => {
  assert.deepEqual(runs("1:08.849 +2, 1:09.100 (1); RRN | 70.5+dnf\t71.2 + 3"), [[68.849, 2, ""], [69.1, 1, ""], [null, 0, "rerun"], [70.5, 0, "dnf"], [71.2, 3, ""]]);
  assert.deepEqual(runs("DNS DSQ OC"), [[null, 0, "dnf"], [null, 0, "dsq"], [null, 0, "oc"]]);
  assert.deepEqual(runs(""), []);
});

test("times parse in both forms", () => {
  assert.equal(parseTime("1:08.849"), 68.849);
  assert.equal(parseTime("68.849"), 68.849);
  assert.ok(Number.isNaN(parseTime("abc")));
});

test("raw time, counted time and the results mark", () => {
  const lap = { duration: 68.9, result: { official: 68.849, cones: 2 } };
  assert.equal(rawTime(lap), 68.849);
  assert.equal(countedTime(lap, 1), 70.849);
  assert.equal(countedTime(lap, 2), 72.849);
  assert.equal(resultMark(lap), "+2");
  assert.equal(rawTime({ duration: 70 }), 70, "GPS time without an official one");
  assert.equal(resultMark({ duration: 70, result: { status: "oc" } }), "OC");
  assert.ok(Number.isNaN(countedTime({ duration: 70, result: { status: "dnf" } }, 1)));
});

test("best goes by counted time; OC can't be best; the finished timer shows the raw time and mark", () => {
  const { text, t0, pre, lap1, lap2 } = syntheticCsv();
  const s = parseRaceChronoV3(text);
  s.conePenalty = 1;
  const [L1, L2] = s.laps; // 40 s and 36 s
  const tm = new Timing(s);
  assert.equal(tm.bestLap(), L2);

  L2.result = { cones: 5 }; // 36 + 5 = 41 > 40
  tm.invalidate();
  assert.equal(tm.bestLap(), L1, "five cones make the faster lap slower");

  L2.result = { official: 35.9, cones: 2 };
  L1.result = { status: "oc" };
  tm.invalidate();
  assert.equal(tm.bestLap(), L2, "an off-course run can't be best");
  assert.equal(tm.theoreticalLap(), null, "nor part of the theoretical best (one run left)");

  const during = tm.context(t0 + pre + lap1 + 10);
  assert.equal(during.state, "in");
  assert.ok(Math.abs(during.elapsed - 10) < 0.05, "running: GPS time");
  assert.equal(during.mark, "");
  const after = tm.context(t0 + pre + lap1 + lap2 + 1);
  assert.equal(after.state, "after");
  assert.equal(after.elapsed, 35.9, "finished: the official time");
  assert.equal(after.mark, "+2");
});
