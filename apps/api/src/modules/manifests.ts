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

/** Roles that administer the registry at their own level (office heads and up). */
const REGISTRY_ADMIN = {
  OFFICE_HEAD: ['view', 'create', 'update'],
  DEPARTMENT_HEAD: ['view', 'create', 'update', 'delete'],
  DISTRICT_MAGISTRATE: ['view', 'create', 'update', 'delete'],
  AUTHORITY_CEO: ['view', 'create', 'update', 'delete'],
  REALM_GOVERNOR: ['view'],
  OBSERVER: ['view'],
  DATA_PROTECTION_OFFICER: ['view']
};

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
  },
  {
    id: 'registry',
    version: '0.1.0',
    name: { en: 'Office & service registry', hi: 'कार्यालय एवं सेवा रजिस्ट्री' },
    realm: 'GOVERNMENT',
    requires: ['platform', 'iam'],
    features: [
      {
        code: 'registry.offices',
        name: { en: 'Offices', hi: 'कार्यालय' },
        actions: ['view', 'create', 'update', 'delete'],
        auditedActions: ['create', 'update', 'delete'],
        defaultGrants: { ...ALL_STAFF_VIEW, ...REGISTRY_ADMIN }
      },
      {
        code: 'registry.posts',
        name: { en: 'Posts & post holders', hi: 'पद एवं पदधारी' },
        actions: ['view', 'create', 'update', 'delete'],
        auditedActions: ['create', 'update', 'delete'],
        defaultGrants: { ...ALL_STAFF_VIEW, ...REGISTRY_ADMIN }
      },
      {
        code: 'registry.services',
        name: { en: 'Notified services & timelines', hi: 'सूचित सेवाएँ एवं समय-सीमा' },
        // Everything except the SLA itself is a direct, audited edit; the SLA
        // changes only through a change request (platform.change_requests),
        // so 'update' here never touches sla_days — see registry routes.
        actions: ['view', 'create', 'update', 'delete'],
        auditedActions: ['create', 'update', 'delete'],
        defaultGrants: { ...ALL_STAFF_VIEW, ...REGISTRY_ADMIN }
      }
    ]
  },
  {
    id: 'org',
    version: '0.1.0',
    name: { en: 'Organization directory', hi: 'संगठन निर्देशिका' },
    realm: 'GOVERNMENT',
    requires: ['platform', 'iam'],
    features: [
      {
        code: 'org.directory',
        name: { en: 'Departments, authorities & service providers', hi: 'विभाग, प्राधिकरण एवं सेवा प्रदाता' },
        actions: ['view', 'create', 'update', 'delete'],
        auditedActions: ['create', 'update', 'delete'],
        defaultGrants: { ...ALL_STAFF_VIEW, ...REGISTRY_ADMIN }
      }
    ]
  },
  {
    id: 'citizen',
    version: '0.1.0',
    name: { en: 'Citizen identity', hi: 'नागरिक पहचान' },
    realm: 'GOVERNMENT',
    // Switchable (not invariant): a district can enable citizen self-service
    // only once it is ready, and can disable it anywhere in its subtree with
    // the ordinary Lego module toggle (see platform.module_settings).
    requires: ['platform'],
    features: [
      {
        code: 'citizen.identity',
        name: { en: 'Mobile OTP sign-in', hi: 'मोबाइल ओटीपी साइन-इन' },
        // Citizens hold no role in the Lego model, so no defaultGrants apply
        // to them; the citizen routes check availability directly via
        // PolicyService.featureAvailable, not through a staff decision.
        // 'view' is kept only so staff-facing module/feature lists (e.g. a
        // future "what's switched on here" screen) can show this feature.
        actions: ['view'],
        defaultGrants: ALL_STAFF_VIEW
      }
    ]
  },
  {
    id: 'intake',
    version: '0.1.0',
    name: { en: 'Grievance intake', hi: 'शिकायत दर्ज' },
    realm: 'GOVERNMENT',
    // Switchable: a district enables citizen-facing intake only once its
    // registry/org data is ready, same pattern as the citizen module.
    requires: ['platform', 'iam', 'registry', 'org', 'citizen'],
    features: [
      {
        code: 'intake.grievances',
        name: { en: 'Grievances', hi: 'शिकायतें' },
        // Citizen filing is public (checked via PolicyService.featureAvailable,
        // same as citizen.identity) and carries no staff role, so only the
        // staff-facing view/update (status-triage) actions appear here.
        // 'update' here means moving a grievance through its status machine
        // (see intake/routes.ts TRANSITIONS), not editing its content.
        actions: ['view', 'update'],
        auditedActions: ['update'],
        defaultGrants: {
          ...ALL_STAFF_VIEW,
          ASSISTED_AGENT: ['view', 'update'],
          OFFICER: ['view', 'update'],
          OFFICE_HEAD: ['view', 'update'],
          DEPARTMENT_HEAD: ['view', 'update'],
          DISTRICT_MAGISTRATE: ['view', 'update'],
          AUTHORITY_CEO: ['view', 'update']
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
