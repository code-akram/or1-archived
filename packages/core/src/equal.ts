/** Structural equality for plain JSON data (objects, arrays, primitives). */
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}
