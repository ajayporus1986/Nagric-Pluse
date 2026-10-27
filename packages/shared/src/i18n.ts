export const LOCALES = ['hi', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'hi';

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

/** Error codes returned by the API. Clients localise by code; messages here are the canonical text. */
export const ERROR_MESSAGES = {
  UNAUTHENTICATED: { en: 'Please sign in.', hi: 'कृपया साइन इन करें।' },
  MFA_REQUIRED: { en: 'Second-factor verification is required.', hi: 'दूसरे चरण का सत्यापन आवश्यक है।' },
  FORBIDDEN: { en: 'You do not have permission for this action.', hi: 'आपको इस कार्य की अनुमति नहीं है।' },
  FEATURE_DISABLED: { en: 'This feature is not active here.', hi: 'यह सुविधा यहाँ सक्रिय नहीं है।' },
  CSRF: { en: 'Your session token is missing or invalid. Reload and try again.', hi: 'सत्र टोकन अनुपलब्ध या अमान्य है। पृष्ठ पुनः लोड करें।' },
  RATE_LIMITED: { en: 'Too many attempts. Please wait and try again.', hi: 'बहुत अधिक प्रयास। कृपया प्रतीक्षा करें।' },
  INVALID_CREDENTIALS: { en: 'Username or password is incorrect.', hi: 'उपयोगकर्ता नाम या पासवर्ड गलत है।' },
  INVALID_CODE: { en: 'The verification code is incorrect.', hi: 'सत्यापन कोड गलत है।' },
  VALIDATION: { en: 'Some fields are invalid.', hi: 'कुछ फ़ील्ड अमान्य हैं।' },
  NOT_FOUND: { en: 'Not found.', hi: 'नहीं मिला।' },
  CONFLICT: { en: 'This conflicts with the current state. Reload and try again.', hi: 'यह वर्तमान स्थिति से मेल नहीं खाता। पुनः प्रयास करें।' },
  QUORUM_RULE: { en: 'This approval is not allowed by the quorum rules.', hi: 'कोरम नियमों के अनुसार यह अनुमोदन मान्य नहीं है।' },
  INVARIANT: { en: 'This is a protected function and cannot be switched off.', hi: 'यह संरक्षित कार्य है, इसे बंद नहीं किया जा सकता।' },
  INTERNAL: { en: 'Something went wrong. The incident has been logged.', hi: 'कुछ गड़बड़ हुई। घटना दर्ज कर ली गई है।' }
} as const satisfies Record<string, Record<Locale, string>>;

export type ErrorCode = keyof typeof ERROR_MESSAGES;
