/**
 * Removes `readonly` modifier from types without changing literal types.
 * - `readonly ["foo"]` → `["foo"]` (preserves literal)
 * - `readonly { a: 1 }` → `{ a: 1 }` (preserves literal)
 */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };
