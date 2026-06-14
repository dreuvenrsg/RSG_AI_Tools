// src/utils.ts
export const toFixed2 = (n: number | null | undefined) =>
  typeof n === "number" && isFinite(n) ? n.toFixed(2) : null;

export const isNonEmpty = (s?: string | null) => !!(s && s.trim().length);
