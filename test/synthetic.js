// Synthetic test data shared by the test files (no real GPS traces in the repo).

/** A RaceChrono-style CSV v3: car circling a 100 m radius loop, 25 Hz.
 *  Lap 1 takes 40 s, lap 2 takes 36 s (faster), then 5 s of run-out. */
export function syntheticCsv() {
  const R = 100, lat0 = 40, lon0 = -100;
  const circ = 2 * Math.PI * R;
  const lines = [
    "This file is created using RaceChrono Pro v10.3.2 ( http://racechrono.com/ ).",
    "Format,3",
    'Session title,"Test day"',
    "Session type,Lap timing",
    'Track name,"Test loop"',
    "Driver name,",
    "Created,01/01/2026,10:00",
    "Note,",
    "",
    "timestamp,fragment_id,lap_number,elapsed_time,distance_traveled,latitude,longitude,speed,lateral_acc,longitudinal_acc,speed",
    "unix time,,,s,m,deg,deg,m/s,G,G,m/s",
    ",,,,,100: gps,100: gps,100: gps,calc,calc,calc",
  ];
  const t0 = 1_700_000_000;
  let dist = 0;
  const pre = 5, lap1 = 40, lap2 = 36, post = 5;
  for (let i = 0; i <= (pre + lap1 + lap2 + post) * 25; i++) {
    const t = i / 25;
    let lap = "", v;
    if (t < pre) v = 5;
    else if (t < pre + lap1) { lap = "1"; v = circ / lap1; }
    else if (t < pre + lap1 + lap2) { lap = "2"; v = circ / lap2; }
    else v = 5;
    if (i) dist += v / 25;
    const a = dist / R;
    const lat = lat0 + (R * Math.sin(a)) / 111320;
    const lon = lon0 + (R * (1 - Math.cos(a))) / (111320 * Math.cos((lat0 * Math.PI) / 180));
    lines.push([(t0 + t).toFixed(2), 0, lap, t.toFixed(2), dist.toFixed(3), lat.toFixed(7), lon.toFixed(7), v.toFixed(3), (v * v / R / 9.81).toFixed(3), "0", v.toFixed(3)].join(","));
  }
  return { text: lines.join("\n") + "\n", t0, pre, lap1, lap2 };
}
