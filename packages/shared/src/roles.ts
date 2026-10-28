import type { ScopeLevel } from './scope.js';

export const REALMS = ['CITIZEN', 'GOVERNMENT', 'PARTY', 'OBSERVER', 'ELECTION_AUTHORITY', 'PLATFORM', 'GOVERNANCE', 'OPERATIONS'] as const;
export type Realm = (typeof REALMS)[number];

/** Realms that a Realm Governor quorum can switch off (v2 §3.5). The rest are permanent. */
export const SWITCHABLE_REALMS = ['GOVERNMENT', 'PARTY', 'OBSERVER'] as const;
export type SwitchableRealm = (typeof SWITCHABLE_REALMS)[number];

export interface RoleDefinition {
  code: string;
  realm: Realm;
  nameEn: string;
  nameHi: string;
  /** Staff roles sign in with password + second factor. Citizen roles do not use staff accounts. */
  staff: boolean;
  /**
   * Granting this role requires a Realm Governor quorum. Roles whose holders
   * check or govern others are always sensitive.
   */
  sensitive: boolean;
  /** Scope levels at which the role may be assigned. */
  levels: readonly ScopeLevel[];
}

const LOCAL: ScopeLevel[] = ['DISTRICT', 'SUBDISTRICT', 'BLOCK', 'URBAN_BODY', 'AUTHORITY', 'WARD', 'VILLAGE'];
const DISTRICT_UP: ScopeLevel[] = ['NATION', 'STATE', 'DISTRICT'];

/**
 * Role catalogue for the district pod (v2 §4, Blueprint §4, MCC module doc §4).
 * Codes are stable identifiers; names are display text.
 */
export const ROLES: readonly RoleDefinition[] = [
  { code: 'CITIZEN_ANONYMOUS', realm: 'CITIZEN', nameEn: 'Anonymous citizen', nameHi: 'अनाम नागरिक', staff: false, sensitive: false, levels: LOCAL },
  { code: 'CITIZEN_VERIFIED', realm: 'CITIZEN', nameEn: 'Verified citizen', nameHi: 'सत्यापित नागरिक', staff: false, sensitive: false, levels: LOCAL },
  { code: 'ASSISTED_AGENT', realm: 'CITIZEN', nameEn: 'Assisted-submission agent', nameHi: 'सहायक प्रविष्टि एजेंट', staff: true, sensitive: false, levels: LOCAL },
  { code: 'OFFICER', realm: 'GOVERNMENT', nameEn: 'Office clerk / officer', nameHi: 'कार्यालय लिपिक / अधिकारी', staff: true, sensitive: false, levels: LOCAL },
  { code: 'OFFICE_HEAD', realm: 'GOVERNMENT', nameEn: 'Office head', nameHi: 'कार्यालय प्रमुख', staff: true, sensitive: false, levels: LOCAL },
  { code: 'DEPARTMENT_HEAD', realm: 'GOVERNMENT', nameEn: 'Department head (district)', nameHi: 'विभागाध्यक्ष (जनपद)', staff: true, sensitive: false, levels: ['DISTRICT'] },
  { code: 'DISTRICT_MAGISTRATE', realm: 'GOVERNMENT', nameEn: 'District Magistrate', nameHi: 'जिलाधिकारी', staff: true, sensitive: true, levels: ['DISTRICT'] },
  { code: 'AUTHORITY_CEO', realm: 'GOVERNMENT', nameEn: 'Development authority CEO', nameHi: 'विकास प्राधिकरण मुख्य कार्यपालक अधिकारी', staff: true, sensitive: true, levels: ['AUTHORITY'] },
  { code: 'STATE_LEADERSHIP', realm: 'GOVERNMENT', nameEn: 'State leadership', nameHi: 'राज्य नेतृत्व', staff: true, sensitive: true, levels: ['STATE'] },
  { code: 'NATIONAL_LEADERSHIP', realm: 'GOVERNMENT', nameEn: 'National leadership', nameHi: 'राष्ट्रीय नेतृत्व', staff: true, sensitive: true, levels: ['NATION'] },
  { code: 'EMERGENCY_OPERATOR', realm: 'GOVERNMENT', nameEn: 'Emergency control-room operator', nameHi: 'आपात नियंत्रण कक्ष संचालक', staff: true, sensitive: false, levels: ['DISTRICT'] },
  { code: 'CONTRACTOR', realm: 'GOVERNMENT', nameEn: 'Contractor', nameHi: 'ठेकेदार', staff: true, sensitive: false, levels: LOCAL },
  { code: 'PARTY_WORKER', realm: 'PARTY', nameEn: 'Party worker', nameHi: 'दल कार्यकर्ता', staff: true, sensitive: false, levels: LOCAL },
  { code: 'PARTY_UNIT_ADMIN', realm: 'PARTY', nameEn: 'Party unit administrator', nameHi: 'दल इकाई प्रशासक', staff: true, sensitive: true, levels: ['DISTRICT', 'STATE'] },
  { code: 'ELECTION_OFFICER', realm: 'ELECTION_AUTHORITY', nameEn: 'District Election Officer / Returning Officer', nameHi: 'जिला निर्वाचन अधिकारी / निर्वाचन अधिकारी', staff: true, sensitive: true, levels: ['DISTRICT', 'SUBDISTRICT'] },
  { code: 'ELECTION_APPROVER', realm: 'ELECTION_AUTHORITY', nameEn: 'Election order approver (CEO / SEC / ECI)', nameHi: 'निर्वाचन आदेश अनुमोदक', staff: true, sensitive: true, levels: DISTRICT_UP },
  { code: 'INTEGRITY_REVIEWER', realm: 'PLATFORM', nameEn: 'Integrity reviewer', nameHi: 'सत्यनिष्ठा समीक्षक', staff: true, sensitive: true, levels: DISTRICT_UP },
  { code: 'POLL_REVIEWER', realm: 'PLATFORM', nameEn: 'Poll standards reviewer', nameHi: 'मतसर्वेक्षण मानक समीक्षक', staff: true, sensitive: true, levels: DISTRICT_UP },
  { code: 'WHISTLE_REVIEWER', realm: 'PLATFORM', nameEn: 'Whistleblower review cell', nameHi: 'व्हिसलब्लोअर समीक्षा प्रकोष्ठ', staff: true, sensitive: true, levels: DISTRICT_UP },
  { code: 'REALM_GOVERNOR', realm: 'GOVERNANCE', nameEn: 'Realm Governor (quorum member)', nameHi: 'क्षेत्र शासक (कोरम सदस्य)', staff: true, sensitive: true, levels: DISTRICT_UP },
  { code: 'DATA_PROTECTION_OFFICER', realm: 'GOVERNANCE', nameEn: 'Data Protection Officer', nameHi: 'डेटा संरक्षण अधिकारी', staff: true, sensitive: true, levels: DISTRICT_UP },
  { code: 'OBSERVER', realm: 'OBSERVER', nameEn: 'Observer / auditor', nameHi: 'पर्यवेक्षक / लेखा परीक्षक', staff: true, sensitive: true, levels: DISTRICT_UP },
  { code: 'PLATFORM_OPERATOR', realm: 'OPERATIONS', nameEn: 'Platform operator (SRE / SecOps)', nameHi: 'प्लेटफ़ॉर्म संचालक', staff: true, sensitive: true, levels: DISTRICT_UP }
] as const;

const BY_CODE = new Map(ROLES.map((r) => [r.code, r]));

export function getRole(code: string): RoleDefinition | undefined {
  return BY_CODE.get(code);
}

export const ROLE_CODES = ROLES.map((r) => r.code);
