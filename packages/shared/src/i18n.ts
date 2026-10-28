/**
 * Locales supported by the platform. Hindi is the default for every district;
 * further languages are added per district package.
 */
export const LOCALES = ['hi', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'hi';

/** Type guard for untrusted locale input. */
export function isLocale(v: unknown): v is Locale {
  return v === 'hi' || v === 'en';
}

/** Pick a locale from an Accept-Language header; Hindi is the default. */
export function negotiateLocale(header: string | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;
  const parts = header
    .split(',')
    .map((p) => {
      const [tag, ...params] = p.trim().split(';');
      const q = params.find((x) => x.trim().startsWith('q='));
      return { tag: (tag ?? '').toLowerCase(), q: q ? Number(q.trim().slice(2)) : 1 };
    })
    .filter((p) => p.tag && Number.isFinite(p.q))
    .sort((a, b) => b.q - a.q);
  for (const p of parts) {
    const base = p.tag.split('-')[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}
