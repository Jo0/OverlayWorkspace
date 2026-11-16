// Plug-in registries. Everything the app can be extended with (data importers,
// widgets, panel shapes) is a plain object registered here under a unique id.
// See docs/EXTENDING.md.

export function createRegistry(kind) {
  const items = new Map();
  return {
    kind,
    register(def) {
      if (!def || typeof def.id !== "string" || !def.id) {
        throw new Error(`${kind}: definition needs a string "id"`);
      }
      items.set(def.id, def);
      return def;
    },
    get(id) {
      return items.get(id);
    },
    require(id) {
      const def = items.get(id);
      if (!def) throw new Error(`Unknown ${kind} "${id}"`);
      return def;
    },
    has(id) {
      return items.has(id);
    },
    list() {
      return [...items.values()];
    },
  };
}

export const importers = createRegistry("importer");
export const widgets = createRegistry("widget");
export const shapes = createRegistry("shape");
