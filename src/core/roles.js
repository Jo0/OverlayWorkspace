// Guessing a channel's role (see ROLES in session.js) from its column name,
// for importers whose formats don't say. First match wins; importers should
// give each role to one channel only (the first that claims it).

/** Engine/driver inputs as loggers name them (RaceChrono CAN columns, OBD, AiM...). */
export const ENGINE_ROLE_PATTERNS = [
  [/(^|[_\s])(engine[_\s]?)?rpm\b|engine[_\s]?speed/i, "rpm"],
  [/throttle|accelerator|pedal[_\s]?pos|\btps\b/i, "throttle"],
  [/brake/i, "brake"],
  [/steer/i, "steering"],
  [/(^|[_\s])gear/i, "gear"],
  [/coolant|water[_\s]?temp|\bect\b/i, "coolant_temp"],
  [/oil[_\s]?temp/i, "oil_temp"],
];

/** Position, motion and G as GPS loggers name them (VBO, CSV exports). */
export const GPS_ROLE_PATTERNS = [
  // G first: "long accel g" must not read as longitude.
  [/lat(eral)?[_\s-]?acc|(lat|lateral)[_\s-]+g$|^g[_\s-]?lat/i, "lat_g"],
  [/lon(g|gitudinal)?[_\s-]?acc|(lon|long|longitudinal)[_\s-]+g$|^g[_\s-]?lon/i, "lon_g"],
  [/combined[_\s-]?(acc|g)/i, "combined_g"],
  // Position: the whole name (after units are stripped), so "latacc" or
  // "lateral" never count. Axis names (Accel X) aren't guessed: they depend
  // on how the device was mounted.
  [/^(lat|latitude|gps[_\s-]?lat(itude)?)$/i, "latitude"],
  [/^(long|lon|lng|longitude|gps[_\s-]?lon(g|gitude)?)$/i, "longitude"],
  [/^(velocity|speed|gps[_\s-]?speed|ground[_\s-]?speed|vel)(\s+(kmh|kph|mph|ms|knots?))?$/i, "speed"],
  [/^(heading|course|bearing|direction)$/i, "heading"],
  [/^(height|altitude|alt|elevation)$/i, "altitude"],
  [/^(distance|dist|odometer|distance[_\s-]?traveled)$/i, "distance"],
  [/lean/i, "lean"],
];

/** The role a column name suggests, or undefined. Names like "Speed (MPH)" work: units in brackets are ignored. */
export function guessRole(name) {
  const n = String(name || "").replace(/\s*[([].*$/, "").trim();
  for (const [re, role] of [...GPS_ROLE_PATTERNS, ...ENGINE_ROLE_PATTERNS]) if (re.test(n)) return role;
  return undefined;
}
