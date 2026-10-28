// Generates docs/error-codes.md from the error catalogue in @np/shared.
// Run after `pnpm build`: node scripts/gen-error-docs.mjs
// CI fails if the committed file is out of date.
import { writeFileSync } from 'node:fs';
import { ERRORS } from '../packages/shared/dist/errors.js';

const area = (code) => code.split('-')[1];
const names = {
  CFG: 'Configuration and startup', DB: 'Database', HTTP: 'HTTP', VAL: 'Validation', AUTH: 'Sign-in', MFA: 'Second factor',
  SESS: 'Sessions', CSRF: 'Request forgery protection', RATE: 'Rate limits', POL: 'Access policy (Lego controls)', SCOPE: 'Jurisdiction tree',
  CR: 'Change requests and quorum', KILL: 'Emergency stop', USER: 'Staff accounts', AUDIT: 'Audit ledger', WORK: 'Background worker',
  CLIENT: 'Web console (client side)', INT: 'Unexpected', REG: 'Office & service registry', CIT: 'Citizen identity',
  CLASS: 'Jurisdiction classification', ORG: 'Organization directory'
};
let out = '# Error codes\n\n_Generated from `packages/shared/src/errors.ts` by `scripts/gen-error-docs.mjs`. Do not edit by hand._\n\n';
out += 'Every failure carries one of these codes in the API response (`error.code`), in the server log (`errCode`) and in the console, together with a request reference (`requestId` / `reqId`). To investigate a report, search the logs for the reference.\n\n';
let current = '';
for (const [code, spec] of Object.entries(ERRORS)) {
  if (area(code) !== current) {
    current = area(code);
    out += `\n## ${names[current] ?? current}\n\n| Code | HTTP | Log level | English | Hindi |\n| --- | --- | --- | --- | --- |\n`;
  }
  out += `| \`${code}\` | ${spec.http || '—'} | ${spec.level} | ${spec.en} | ${spec.hi} |\n`;
}
writeFileSync(new URL('../docs/error-codes.md', import.meta.url), out);
console.warn(`wrote ${Object.keys(ERRORS).length} codes`);
