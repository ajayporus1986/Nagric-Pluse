/**
 * Manifests of the modules built into Phase 0.
 *
 * Governance itself (platform registry, staff identity, audit) is marked
 * invariant: no setting, realm switch or kill switch can take it away, so the
 * platform can never lock its own administrators out. Authorization still
 * applies to every action.
 *
 * Later modules add their own manifest file and register it in ALL_MANIFESTS.
 */
import { validateManifestSet, type ModuleManifest } from '@np/shared';

/** Roles that can see the jurisdiction tree (every staff role). */
const ALL_STAFF_VIEW = Object.fromEntries(
  [
    'ASSISTED_AGENT', 'OFFICER', 'OFFICE_HEAD', 'DEPARTMENT_HEAD', 'DISTRICT_MAGISTRATE', 'AUTHORITY_CEO', 'STATE_LEADERSHIP',
    'NATIONAL_LEADERSHIP', 'EMERGENCY_OPERATOR', 'CONTRACTOR', 'PARTY_WORKER', 'PARTY_UNIT_ADMIN', 'ELECTION_OFFICER',
    'ELECTION_APPROVER', 'INTEGRITY_REVIEWER', 'POLL_REVIEWER', 'WHISTLE_REVIEWER', 'REALM_GOVERNOR', 'DATA_PROTECTION_OFFICER',
    'OBSERVER', 'PLATFORM_OPERATOR'
  ].map((r) => [r, ['view']])
);

/** Raw manifest definitions (validated below). */
const RAW: unknown[] = [
  {
    id: 'platform',
    version: '0.1.0',
    name: { en: 'Platform registry', hi: 'प्लेटफ़ॉर्म रजिस्ट्री' },
    realm: 'GOVERNANCE',
    invariant: true,
    features: [
      {
        code: 'platform.scope',
        name: { en: 'Jurisdiction tree', hi: 'क्षेत्राधिकार वृक्ष' },
        actions: ['view'],
        invariant: true,
        defaultGrants: ALL_STAFF_VIEW
      },
      {
        code: 'platform.modules',
        name: { en: 'Modules and settings', hi: 'मॉड्यूल और सेटिंग्स' },
        actions: ['view'],
        invariant: true,
        defaultGrants: {
          REALM_GOVERNOR: ['view'],
          PLATFORM_OPERATOR: ['view'],
          OBSERVER: ['view'],
          DATA_PROTECTION_OFFICER: ['view'],
          DISTRICT_MAGISTRATE: ['view']
        }
      },
      {
        code: 'platform.change_requests',
        name: { en: 'Change requests', hi: 'परिवर्तन अनुरोध' },
        actions: ['view', 'create', 'approve'],
        invariant: true,
        auditedActions: ['create', 'approve'],
        defaultGrants: {
          REALM_GOVERNOR: ['view', 'create', 'approve'],
          OBSERVER: ['view'],
          DATA_PROTECTION_OFFICER: ['view']
        }
      },
      {
        code: 'platform.kill_switch',
        name: { en: 'Emergency stop', hi: 'आपात रोक' },
        actions: ['view', 'special'],
        invariant: true,
        auditedActions: ['special'],
        defaultGrants: { PLATFORM_OPERATOR: ['view', 'special'], REALM_GOVERNOR: ['view'], OBSERVER: ['view'] }
      }
    ]
  },
  {
    id: 'iam',
    version: '0.1.0',
    name: { en: 'Staff identity', hi: 'कर्मचारी पहचान' },
    realm: 'GOVERNANCE',
    invariant: true,
    requires: ['platform'],
    features: [
      {
        code: 'iam.users',
        name: { en: 'Staff accounts', hi: 'कर्मचारी खाते' },
        actions: ['view', 'create', 'update'],
        invariant: true,
        auditedActions: ['create', 'update'],
        defaultGrants: {
          REALM_GOVERNOR: ['view', 'create', 'update'],
          PLATFORM_OPERATOR: ['view'],
          DATA_PROTECTION_OFFICER: ['view'],
          OBSERVER: ['view']
        }
      }
    ]
  },
  {
    id: 'audit',
    version: '0.1.0',
    name: { en: 'Audit ledger', hi: 'ऑडिट बही' },
    realm: 'GOVERNANCE',
    invariant: true,
    features: [
      {
        code: 'audit.ledger',
        name: { en: 'Audit log', hi: 'ऑडिट लॉग' },
        actions: ['view', 'special'],
        invariant: true,
        auditedActions: ['view', 'special'],
        defaultGrants: {
          OBSERVER: ['view', 'special'],
          DATA_PROTECTION_OFFICER: ['view', 'special'],
          REALM_GOVERNOR: ['view', 'special'],
          PLATFORM_OPERATOR: ['view', 'special']
        }
      }
    ]
  }
];

/**
 * All manifests, validated and in dependency order. Validation runs at import
 * time so a bad manifest stops the process before it serves traffic.
 */
export const ALL_MANIFESTS: ModuleManifest[] = validateManifestSet(RAW);
