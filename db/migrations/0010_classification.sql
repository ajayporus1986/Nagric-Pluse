-- 0010 Jurisdiction classification (Phase 1.5): admin-editable axes/values
-- attached per scope node, so the platform never assumes GB Nagar/Noida's
-- shape. Real-world research (see project doc
-- "Nagrik_Pulse_Governance_Taxonomy_and_Configurability_Design") found that
-- urban-body type, rural governing body, policing model, and Union
-- Territory status are all set per-state or per-place with no fixed national
-- enum -- so they live as rows here, never as a hardcoded code list, and are
-- changed only through the same Realm Governor quorum as every other Lego
-- setting (see NODE_CLASSIFICATION_SET in platform/changes.ts).

-- ---------------------------------------------------------------------------
-- Axes: the dimensions a node can be classified along. Admin-addable: a new
-- axis (e.g. a state introduces a new ULB category) needs no code change.
-- ---------------------------------------------------------------------------
CREATE TABLE platform.classification_axes (
  code            text PRIMARY KEY CHECK (code ~ '^[a-z][a-zA-Z0-9]{1,40}$'),
  name_en         text NOT NULL CHECK (length(name_en) BETWEEN 1 AND 200),
  name_hi         text NOT NULL CHECK (length(name_hi) BETWEEN 1 AND 200),
  description_en  text CHECK (description_en IS NULL OR length(description_en) <= 500),
  multi           boolean NOT NULL DEFAULT false, -- true if a node may hold more than one value on this axis
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Values: the admin-addable vocabulary for one axis (e.g. axis
-- "urbanBodyType" might have values MUNICIPAL_CORPORATION, NAGAR_PALIKA_
-- PARISHAD, NAGAR_PANCHAYAT, CANTONMENT_BOARD, ...). New values are added as
-- rows by a Realm Governor, never shipped as a code enum.
-- ---------------------------------------------------------------------------
CREATE TABLE platform.classification_values (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  axis_code   text NOT NULL REFERENCES platform.classification_axes(code),
  code        text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,60}$'),
  name_en     text NOT NULL CHECK (length(name_en) BETWEEN 1 AND 200),
  name_hi     text NOT NULL CHECK (length(name_hi) BETWEEN 1 AND 200),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (axis_code, code)
);
CREATE INDEX classification_values_axis ON platform.classification_values (axis_code) WHERE active;

-- ---------------------------------------------------------------------------
-- Node classifications: the fact itself. One row per (node, axis) for a
-- single-valued axis; multiple rows allowed when the axis is `multi`.
-- boolean-shaped axes (e.g. "isUnionTerritory", "actsAsDistrict") are modeled
-- as a two-value axis (YES/NO) rather than a new column type, so every axis
-- is read and changed the same way.
-- ---------------------------------------------------------------------------
CREATE TABLE platform.node_classifications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id            text NOT NULL REFERENCES platform.scope_nodes(id),
  axis_code          text NOT NULL REFERENCES platform.classification_axes(code),
  value_code         text NOT NULL,
  -- Last change request that set this value (NULL for initial seed/load data).
  change_request_id  uuid,
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (axis_code, value_code) REFERENCES platform.classification_values (axis_code, code)
);
-- Single-valued axes: at most one row per (node, axis). Enforced in the
-- application for `multi` axes (a partial index can't see the axis flag).
CREATE UNIQUE INDEX node_classifications_single ON platform.node_classifications (node_id, axis_code);
CREATE INDEX node_classifications_node ON platform.node_classifications (node_id);

-- platform.audit_outbox already exists (platform is an invariant module from
-- 0004); classification changes are audited there via writeAudit(c, 'platform', ...).

-- Classification changes affect policy-adjacent, admin-visible state, so the
-- same snapshot-reload notification as module/feature settings applies.
CREATE TRIGGER classification_values_notify AFTER INSERT OR UPDATE OR DELETE ON platform.classification_values FOR EACH STATEMENT EXECUTE FUNCTION platform.notify_policy_changed();
CREATE TRIGGER node_classifications_notify AFTER INSERT OR UPDATE OR DELETE ON platform.node_classifications FOR EACH STATEMENT EXECUTE FUNCTION platform.notify_policy_changed();

-- New change-request kind: node classifications are editable only through the
-- same Realm Governor quorum as every other Lego/registry setting.
ALTER TABLE platform.change_requests DROP CONSTRAINT change_requests_kind_check;
ALTER TABLE platform.change_requests ADD CONSTRAINT change_requests_kind_check CHECK (kind IN (
  'MODULE_SETTING','FEATURE_SETTING','REALM_SETTING','PERMISSION','ROLE_GRANT','ROLE_REVOKE',
  'KILL_SWITCH_RATIFY','QUORUM_CONFIG','USER_ENABLE','USER_RESET_CREDENTIALS','USER_DISABLE','SERVICE_SLA_SET',
  'NODE_CLASSIFICATION_SET'));

-- ---------------------------------------------------------------------------
-- Seed axes and values found by the governance research. Admins can add more
-- later through ordinary rows -- this seed is a starting vocabulary, not a
-- closed list.
-- ---------------------------------------------------------------------------
INSERT INTO platform.classification_axes (code, name_en, name_hi, description_en, multi) VALUES
  ('urbanBodyType', 'Urban local body type', 'शहरी स्थानीय निकाय प्रकार', 'Municipal Corporation / Nagar Palika Parishad / Nagar Panchayat / Cantonment Board / Notified Area / Township / none -- set per state, never fixed nationally.', false),
  ('ruralGoverningBody', 'Rural governing body', 'ग्रामीण शासी निकाय', 'Zilla Parishad / Panchayat Samiti / Gram Panchayat / none -- the Panchayati Raj tier structure is not uniform across states.', false),
  ('policingModel', 'Policing model', 'पुलिसिंग मॉडल', 'Police Commissionerate vs. District Police HQ (SP-led) -- live in some cities/states, absent in others.', false),
  ('adminType', 'Administrative type', 'प्रशासनिक प्रकार', 'STATE vs. UNION_TERRITORY vs. NCT.', false),
  ('actsAsDistrict', 'Acts as a single district', 'एकल जिले के रूप में कार्य करता है', 'Whether a STATE/UT-level node collapses state and district operationally (e.g. Chandigarh) -- independent of adminType.', false),
  ('economicZoneType', 'Economic/industrial zone type', 'आर्थिक/औद्योगिक क्षेत्र प्रकार', 'SEZ / Smart City SPV / Statutory Industrial Development Authority / Port Trust / none, for AUTHORITY-level and other special nodes.', false),
  ('grievanceFrictionReason', 'Grievance friction reason', 'शिकायत बाधा कारण', 'Reusable reason list for the frictionReport block (citizen or business complainant describing why they had to pay, use an agent, or use influence). Multi-select per report.', true),
  ('sectorFormality', 'Business sector formality', 'व्यवसाय क्षेत्र औपचारिकता', 'For a BUSINESS complainant: Organized/registered, MSME (Udyam-registered), Unorganized/informal, Home-based.', false),
  ('operatingContext', 'Business operating context', 'व्यवसाय संचालन संदर्भ', 'For a BUSINESS complainant: regular shop, Authority-area unit, SEZ unit, IT park/STPI unit, street vendor, gig/platform worker.', false)
ON CONFLICT (code) DO NOTHING;

INSERT INTO platform.classification_values (axis_code, code, name_en, name_hi) VALUES
  ('urbanBodyType', 'MUNICIPAL_CORPORATION', 'Municipal Corporation (Nagar Nigam)', 'नगर निगम'),
  ('urbanBodyType', 'NAGAR_PALIKA_PARISHAD', 'Municipal Council (Nagar Palika Parishad)', 'नगर पालिका परिषद'),
  ('urbanBodyType', 'NAGAR_PANCHAYAT', 'Nagar Panchayat', 'नगर पंचायत'),
  ('urbanBodyType', 'CANTONMENT_BOARD', 'Cantonment Board', 'छावनी बोर्ड'),
  ('urbanBodyType', 'NOTIFIED_AREA', 'Notified Area Committee', 'अधिसूचित क्षेत्र समिति'),
  ('urbanBodyType', 'TOWNSHIP', 'Township (enterprise-run)', 'टाउनशिप'),
  ('urbanBodyType', 'NONE', 'None / not applicable', 'कोई नहीं / लागू नहीं'),

  ('ruralGoverningBody', 'ZILLA_PARISHAD', 'Zilla Parishad', 'ज़िला परिषद'),
  ('ruralGoverningBody', 'PANCHAYAT_SAMITI', 'Panchayat Samiti', 'पंचायत समिति'),
  ('ruralGoverningBody', 'GRAM_PANCHAYAT', 'Gram Panchayat', 'ग्राम पंचायत'),
  ('ruralGoverningBody', 'NONE', 'None / not applicable', 'कोई नहीं / लागू नहीं'),

  ('policingModel', 'COMMISSIONERATE', 'Police Commissionerate', 'पुलिस आयुक्तालय'),
  ('policingModel', 'DISTRICT_POLICE_HQ', 'District Police HQ (SP-led)', 'जिला पुलिस मुख्यालय (एसपी)'),

  ('adminType', 'STATE', 'State', 'राज्य'),
  ('adminType', 'UNION_TERRITORY', 'Union Territory', 'संघ राज्य क्षेत्र'),
  ('adminType', 'NCT', 'National Capital Territory', 'राष्ट्रीय राजधानी क्षेत्र'),

  ('actsAsDistrict', 'YES', 'Yes', 'हाँ'),
  ('actsAsDistrict', 'NO', 'No', 'नहीं'),

  ('economicZoneType', 'SEZ', 'Special Economic Zone', 'विशेष आर्थिक क्षेत्र'),
  ('economicZoneType', 'SMART_CITY_SPV', 'Smart City SPV', 'स्मार्ट सिटी एसपीवी'),
  ('economicZoneType', 'INDUSTRIAL_DEV_AUTHORITY', 'Statutory Industrial Development Authority', 'सांविधिक औद्योगिक विकास प्राधिकरण'),
  ('economicZoneType', 'PORT_TRUST', 'Port Trust', 'पोर्ट ट्रस्ट'),
  ('economicZoneType', 'NONE', 'None / not applicable', 'कोई नहीं / लागू नहीं'),

  ('grievanceFrictionReason', 'PROCESS_UNCLEAR', 'Process too complicated / steps unclear', 'प्रक्रिया जटिल/अस्पष्ट थी'),
  ('grievanceFrictionReason', 'INFO_NOT_DISCLOSED', 'Required documents/information not disclosed upfront', 'जरूरी जानकारी/दस्तावेज़ पहले नहीं बताए गए'),
  ('grievanceFrictionReason', 'DELIBERATE_DELAY', 'Office/staff deliberately delayed the work', 'कार्यालय/कर्मचारी ने जानबूझकर देरी की'),
  ('grievanceFrictionReason', 'NO_RESPONSE_WITHOUT_PAYMENT', 'No response or update without payment', 'भुगतान के बिना कोई जवाब नहीं मिला'),
  ('grievanceFrictionReason', 'PAYMENT_CALLED_MANDATORY', 'Told payment was "mandatory" to get it done', 'भुगतान को "अनिवार्य" बताया गया'),
  ('grievanceFrictionReason', 'HAD_TO_HIRE_AGENT', 'Had to hire an agent/tout to get the work done at all', 'काम करवाने के लिए एजेंट/दलाल रखना पड़ा'),
  ('grievanceFrictionReason', 'USED_CONNECTIONS', 'Used personal connection/influence (no cash) to get it done', 'व्यक्तिगत पहुँच/प्रभाव का उपयोग करना पड़ा'),
  ('grievanceFrictionReason', 'SERVICE_DENIED_WITHOUT_PAYMENT', 'Service denied until payment made', 'भुगतान तक सेवा से इनकार किया गया'),
  ('grievanceFrictionReason', 'PAY_TO_AVOID_PENALTY', 'Asked to pay to avoid a penalty or compliance issue', 'जुर्माने/अनुपालन से बचने हेतु भुगतान के लिए कहा गया'),
  ('grievanceFrictionReason', 'REDIRECTED_REPEATEDLY', 'Repeatedly redirected between offices, no one took responsibility', 'कार्यालयों के बीच बार-बार भेजा गया, किसी ने ज़िम्मेदारी नहीं ली'),
  ('grievanceFrictionReason', 'OTHER', 'Other', 'अन्य'),

  ('sectorFormality', 'ORGANIZED', 'Organized / registered company', 'संगठित / पंजीकृत कंपनी'),
  ('sectorFormality', 'MSME', 'MSME (Udyam-registered)', 'एमएसएमई (उद्यम-पंजीकृत)'),
  ('sectorFormality', 'UNORGANIZED', 'Unorganized / informal', 'असंगठित / अनौपचारिक'),
  ('sectorFormality', 'HOME_BASED', 'Home-based', 'घर-आधारित'),

  ('operatingContext', 'SHOP_ESTABLISHMENT', 'Regular shop/establishment', 'सामान्य दुकान/प्रतिष्ठान'),
  ('operatingContext', 'AUTHORITY_AREA_UNIT', 'Industrial Authority-area unit', 'औद्योगिक प्राधिकरण क्षेत्र इकाई'),
  ('operatingContext', 'SEZ_UNIT', 'SEZ unit', 'एसईजेड इकाई'),
  ('operatingContext', 'IT_PARK_UNIT', 'IT Park/STPI unit', 'आईटी पार्क/एसटीपीआई इकाई'),
  ('operatingContext', 'STREET_VENDOR', 'Street vendor', 'पथ विक्रेता'),
  ('operatingContext', 'GIG_WORKER', 'Gig/platform worker', 'गिग/प्लेटफ़ॉर्म कर्मी')
ON CONFLICT (axis_code, code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------
GRANT SELECT ON platform.classification_axes, platform.classification_values, platform.node_classifications TO np_platform_rw;
GRANT INSERT, UPDATE, DELETE ON platform.classification_axes, platform.classification_values TO np_platform_rw;
GRANT INSERT, UPDATE ON platform.node_classifications TO np_platform_rw;
-- The registry module reads classifications read-only (to show a node's
-- type on screen); it never writes them.
GRANT USAGE ON SCHEMA platform TO np_registry_rw, np_citizen_rw;
GRANT SELECT ON platform.classification_axes, platform.classification_values, platform.node_classifications TO np_registry_rw, np_citizen_rw;
