/** Response shapes of the API used by the console (kept in one place for review). */
import type { Action, Decision } from '@np/shared';

export interface SessionInfo {
  user: { id: string; username: string; displayName: string; locale: 'hi' | 'en' };
  next: 'CHANGE_PASSWORD' | 'MFA_ENROLL' | 'MFA_VERIFY' | 'READY';
  csrfToken: string;
  assignments: { role: string; nodeId: string; nodeNameEn: string; nodeNameHi: string; level?: string }[];
}

export interface TreeNode {
  id: string;
  level: string;
  lgdCode: string | null;
  nameEn: string;
  nameHi: string;
  childCount: number;
  children?: TreeNode[];
}

export type Capabilities = Record<string, Partial<Record<Action, Decision>>>;

export interface Localized {
  en: string;
  hi: string;
}

export interface FeatureState {
  code: string;
  name: Localized;
  actions: Action[];
  invariant: boolean;
  explicit: 'ENABLED' | 'DISABLED' | 'INHERIT';
  available: boolean;
  trace: { step: string; decision: Decision; detail: string }[];
}

export interface ModuleState {
  id: string;
  version: string;
  name: Localized;
  realm: string;
  invariant: boolean;
  defaultEnabled: boolean;
  requires: string[];
  explicit: 'ENABLED' | 'DISABLED' | 'INHERIT';
  killSwitch: { expiresAt: string } | null;
  features: FeatureState[];
}

export interface ChangeRequest {
  id: string;
  nodeId: string;
  kind: string;
  payload: Record<string, unknown>;
  reason: string;
  impact: { type: string; lines?: { featureCode: string; from: boolean; to: boolean; nodes: number; sample: string[] }[]; truncated?: boolean; role?: string; before?: string[]; after?: string[]; note?: string };
  status: 'PENDING' | 'APPLIED' | 'REJECTED' | 'EXPIRED' | 'WITHDRAWN';
  requiredApprovals: number;
  proposedBy: string;
  proposedByName?: string;
  proposedAt: string;
  expiresAt: string;
  decidedAt: string | null;
  outcome: Record<string, unknown> | null;
  votes: { approverId: string; approverName?: string; verdict: 'APPROVE' | 'REJECT'; comment: string | null; at: string }[];
}

export interface StaffUser {
  id: string;
  username: string;
  displayName: string;
  status: 'ACTIVE' | 'DISABLED';
  totpEnrolled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  roles: { role: string; nodeId: string; assignmentId: string }[];
}

export interface RoleInfo {
  code: string;
  realm: string;
  nameEn: string;
  nameHi: string;
  sensitive: boolean;
  levels: string[];
}

export interface KillSwitch {
  id: string;
  moduleId: string;
  nodeId: string;
  reason: string;
  activatedAt: string;
  expiresAt: string;
  clearedAt: string | null;
  ratifiedBy: string | null;
  active: boolean;
}

export interface Office {
  id: string;
  nodeId: string;
  nameEn: string;
  nameHi: string;
  departmentEn: string;
  departmentHi: string;
  addressEn: string | null;
  addressHi: string | null;
  phone: string | null;
  active: boolean;
}

export interface Post {
  id: string;
  officeId: string;
  titleEn: string;
  titleHi: string;
  active: boolean;
  holder: { userId: string; username: string | null; displayName: string | null; assignedFrom: string } | null;
}

export interface NotifiedService {
  id: string;
  nodeId: string;
  code: string;
  nameEn: string;
  nameHi: string;
  departmentEn: string;
  departmentHi: string;
  designatedOfficerPostId: string | null;
  firstAppealOfficerPostId: string | null;
  secondAppellateAuthorityEn: string | null;
  secondAppellateAuthorityHi: string | null;
  slaDays: number;
  sourceActEn: string;
  sourceActHi: string;
  isNotified: boolean;
  active: boolean;
  entityId: string | null;
}

export interface OrgEntity {
  id: string;
  nodeId: string;
  kind: string;
  nameEn: string;
  nameHi: string;
  parentEntityId: string | null;
  contactEn: string | null;
  contactHi: string | null;
  active: boolean;
}

export interface ClassificationAxis {
  code: string;
  nameEn: string;
  nameHi: string;
  descriptionEn: string | null;
  multi: boolean;
  values: { code: string; nameEn: string; nameHi: string }[];
  current: string | null;
}

export interface GrievanceListItem {
  id: string;
  referenceCode: string;
  nodeId: string;
  subject: string;
  status: string;
  complainantType: string;
  hasFriction: boolean;
  slaDueAt: string | null;
  createdAt: string;
}

export interface GrievanceEvent {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  note: string | null;
  actorUserId: string | null;
  createdAt: string;
}

export interface GrievanceDetail {
  id: string;
  referenceCode: string;
  nodeId: string;
  serviceId: string | null;
  entityId: string | null;
  complainantType: string;
  businessProfile: Record<string, unknown> | null;
  frictionReport: { occurred: boolean; reasonCodes: string[]; otherText?: string } | null;
  subject: string;
  description: string;
  locale: string;
  status: string;
  slaDays: number | null;
  slaDueAt: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  events: GrievanceEvent[];
}

export interface AuditEvent {
  seq: string;
  occurredAt: string;
  recordedAt: string;
  actorId: string | null;
  actorRoles: string[];
  action: string;
  featureCode: string | null;
  scopePath: string | null;
  targetType: string | null;
  targetId: string | null;
  decision: Decision | null;
  ip: string | null;
  detail: Record<string, unknown>;
  hash: string;
}
