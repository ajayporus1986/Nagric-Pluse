/**
 * Error-code catalogue for the whole platform.
 *
 * Every failure the API or worker can report has one stable code of the form
 * NP-<AREA>-<NNNN>. The same code appears in:
 *   - the API response body ({ error: { code, message } }),
 *   - the server log line (field `errCode`), and
 *   - the admin console, which shows it to the user so support can search the logs.
 *
 * Rules:
 *   - Codes are never reused or renumbered once released; retire them instead.
 *   - Messages shown to users never contain internal detail (stack traces, SQL, ids
 *     of other people). Internal detail goes to the log only.
 *   - `level` is the log level used when the error is raised. Expected user errors
 *     (wrong password, validation) are `info`/`warn`; faults are `error`.
 *
 * docs/error-codes.md is generated from this file.
 */

/** Log level used when an error with this code is logged. */
export type ErrorLevel = 'info' | 'warn' | 'error' | 'fatal';

/** One entry of the catalogue. */
export interface ErrorSpec {
  /** HTTP status returned to the client. */
  http: number;
  /** Log level for this failure. */
  level: ErrorLevel;
  /** User-facing message in English. */
  en: string;
  /** User-facing message in Hindi. */
  hi: string;
}

// The catalogue. Grouped by area; numbers increase within each area.
export const ERRORS = {
  // ---- Configuration and startup (CFG) ------------------------------------
  'NP-CFG-0001': { http: 500, level: 'fatal', en: 'Server configuration is invalid.', hi: 'सर्वर कॉन्फ़िगरेशन अमान्य है।' },
  'NP-CFG-0002': { http: 500, level: 'fatal', en: 'Encryption keys are missing or invalid.', hi: 'एन्क्रिप्शन कुंजियाँ अनुपलब्ध या अमान्य हैं।' },
  'NP-CFG-0003': { http: 500, level: 'fatal', en: 'Module manifests failed validation.', hi: 'मॉड्यूल मैनिफ़ेस्ट सत्यापन विफल रहा।' },
  'NP-CFG-0004': { http: 500, level: 'fatal', en: 'A route was registered without an access declaration.', hi: 'एक रूट बिना पहुँच घोषणा के पंजीकृत हुआ।' },

  // ---- Database (DB) -------------------------------------------------------
  'NP-DB-0001': { http: 503, level: 'error', en: 'The database is unavailable. Please try again shortly.', hi: 'डेटाबेस उपलब्ध नहीं है। कृपया थोड़ी देर बाद प्रयास करें।' },
  'NP-DB-0002': { http: 503, level: 'error', en: 'The request took too long. Please try again.', hi: 'अनुरोध में बहुत समय लगा। कृपया पुनः प्रयास करें।' },
  'NP-DB-0003': { http: 409, level: 'warn', en: 'This record was changed by someone else. Reload and try again.', hi: 'यह रिकॉर्ड किसी और ने बदल दिया है। पुनः लोड करें।' },
  'NP-DB-0004': { http: 500, level: 'error', en: 'A data integrity rule was violated.', hi: 'डेटा अखंडता नियम का उल्लंघन हुआ।' },

  // ---- HTTP and validation (HTTP, VAL) -------------------------------------
  'NP-HTTP-0001': { http: 404, level: 'info', en: 'Not found.', hi: 'नहीं मिला।' },
  'NP-HTTP-0002': { http: 413, level: 'warn', en: 'The request is too large.', hi: 'अनुरोध बहुत बड़ा है।' },
  'NP-HTTP-0003': { http: 415, level: 'warn', en: 'Unsupported content type.', hi: 'असमर्थित सामग्री प्रकार।' },
  'NP-HTTP-0004': { http: 400, level: 'warn', en: 'The request could not be read.', hi: 'अनुरोध पढ़ा नहीं जा सका।' },
  'NP-VAL-0001': { http: 400, level: 'info', en: 'Some fields are invalid.', hi: 'कुछ फ़ील्ड अमान्य हैं।' },

  // ---- Authentication (AUTH) ----------------------------------------------
  'NP-AUTH-0001': { http: 401, level: 'info', en: 'Please sign in.', hi: 'कृपया साइन इन करें।' },
  'NP-AUTH-0002': { http: 401, level: 'warn', en: 'Username or password is incorrect.', hi: 'उपयोगकर्ता नाम या पासवर्ड गलत है।' },
  'NP-AUTH-0003': { http: 423, level: 'warn', en: 'This account is temporarily locked after repeated failed sign-ins.', hi: 'बार-बार असफल प्रयासों के कारण खाता अस्थायी रूप से बंद है।' },
  'NP-AUTH-0004': { http: 403, level: 'warn', en: 'This account is disabled.', hi: 'यह खाता निष्क्रिय है।' },
  'NP-AUTH-0005': { http: 403, level: 'info', en: 'You must change your password before continuing.', hi: 'आगे बढ़ने से पहले पासवर्ड बदलें।' },
  'NP-AUTH-0006': { http: 400, level: 'info', en: 'The new password does not meet the password rules.', hi: 'नया पासवर्ड नियमों के अनुरूप नहीं है।' },
  'NP-AUTH-0007': { http: 400, level: 'info', en: 'The current password is incorrect.', hi: 'वर्तमान पासवर्ड गलत है।' },

  // ---- Second factor (MFA) -------------------------------------------------
  'NP-MFA-0001': { http: 403, level: 'info', en: 'Second-factor verification is required.', hi: 'दूसरे चरण का सत्यापन आवश्यक है।' },
  'NP-MFA-0002': { http: 403, level: 'info', en: 'You must set up an authenticator app before continuing.', hi: 'आगे बढ़ने से पहले ऑथेंटिकेटर ऐप सेट करें।' },
  'NP-MFA-0003': { http: 401, level: 'warn', en: 'The verification code is incorrect or expired.', hi: 'सत्यापन कोड गलत या समाप्त है।' },
  'NP-MFA-0004': { http: 409, level: 'warn', en: 'An authenticator is already set up for this account.', hi: 'इस खाते के लिए ऑथेंटिकेटर पहले से सेट है।' },
  'NP-MFA-0005': { http: 409, level: 'warn', en: 'Start authenticator setup first.', hi: 'पहले ऑथेंटिकेटर सेटअप शुरू करें।' },

  // ---- Sessions and CSRF (SESS, CSRF) -------------------------------------
  'NP-SESS-0001': { http: 401, level: 'info', en: 'Your session has expired. Please sign in again.', hi: 'आपका सत्र समाप्त हो गया है। कृपया फिर से साइन इन करें।' },
  'NP-SESS-0002': { http: 401, level: 'warn', en: 'This session was signed out.', hi: 'यह सत्र साइन आउट कर दिया गया था।' },
  'NP-CSRF-0001': { http: 403, level: 'warn', en: 'Security token missing or invalid. Reload the page and try again.', hi: 'सुरक्षा टोकन अनुपलब्ध या अमान्य है। पृष्ठ पुनः लोड करें।' },
  'NP-CSRF-0002': { http: 403, level: 'warn', en: 'Request origin not allowed.', hi: 'अनुरोध का स्रोत अनुमत नहीं है।' },

  // ---- Rate limiting (RATE) -----------------------------------------------
  'NP-RATE-0001': { http: 429, level: 'warn', en: 'Too many attempts. Please wait and try again.', hi: 'बहुत अधिक प्रयास। कृपया प्रतीक्षा करें।' },

  // ---- Policy / Lego controls (POL) ---------------------------------------
  'NP-POL-0001': { http: 403, level: 'warn', en: 'You do not have permission for this action here.', hi: 'आपको यहाँ इस कार्य की अनुमति नहीं है।' },
  'NP-POL-0002': { http: 403, level: 'info', en: 'This feature is not active here.', hi: 'यह सुविधा यहाँ सक्रिय नहीं है।' },
  'NP-POL-0003': { http: 503, level: 'error', en: 'Access rules are temporarily unavailable.', hi: 'पहुँच नियम अस्थायी रूप से उपलब्ध नहीं हैं।' },

  // ---- Scope tree (SCOPE) --------------------------------------------------
  'NP-SCOPE-0001': { http: 404, level: 'info', en: 'This area is not in the jurisdiction list.', hi: 'यह क्षेत्र क्षेत्राधिकार सूची में नहीं है।' },
  'NP-SCOPE-0002': { http: 400, level: 'info', en: 'This role cannot be assigned at this level.', hi: 'यह भूमिका इस स्तर पर नहीं दी जा सकती।' },

  // ---- Change requests and quorum (CR) ------------------------------------
  'NP-CR-0001': { http: 404, level: 'info', en: 'Change request not found.', hi: 'परिवर्तन अनुरोध नहीं मिला।' },
  'NP-CR-0002': { http: 409, level: 'info', en: 'This change request is no longer open.', hi: 'यह परिवर्तन अनुरोध अब खुला नहीं है।' },
  'NP-CR-0003': { http: 409, level: 'warn', en: 'You have already voted on this change request.', hi: 'आप इस अनुरोध पर पहले ही मत दे चुके हैं।' },
  'NP-CR-0004': { http: 403, level: 'warn', en: 'You cannot approve a change that concerns your own account.', hi: 'आप अपने ही खाते से जुड़े परिवर्तन को अनुमोदित नहीं कर सकते।' },
  'NP-CR-0005': { http: 409, level: 'info', en: 'This change would not change anything.', hi: 'इस परिवर्तन से कुछ नहीं बदलेगा।' },
  'NP-CR-0006': { http: 400, level: 'info', en: 'This is a protected function and cannot be switched off.', hi: 'यह संरक्षित कार्य है, इसे बंद नहीं किया जा सकता।' },
  'NP-CR-0007': { http: 404, level: 'info', en: 'Unknown module or feature.', hi: 'अज्ञात मॉड्यूल या सुविधा।' },
  'NP-CR-0008': { http: 409, level: 'warn', en: 'Approved, but the change could no longer be applied. It has been rejected.', hi: 'अनुमोदित, किंतु परिवर्तन लागू नहीं हो सका; इसे अस्वीकृत किया गया।' },
  'NP-CR-0009': { http: 409, level: 'info', en: 'A similar change request is already open for this area.', hi: 'इस क्षेत्र के लिए समान परिवर्तन अनुरोध पहले से खुला है।' },

  // ---- Kill switch (KILL) --------------------------------------------------
  'NP-KILL-0001': { http: 400, level: 'warn', en: 'Protected modules cannot be emergency-stopped.', hi: 'संरक्षित मॉड्यूल को आपात रूप से रोका नहीं जा सकता।' },
  'NP-KILL-0002': { http: 409, level: 'info', en: 'An emergency stop is already active for this module here.', hi: 'इस मॉड्यूल पर आपात रोक पहले से सक्रिय है।' },
  'NP-KILL-0003': { http: 404, level: 'info', en: 'Emergency stop not found or already cleared.', hi: 'आपात रोक नहीं मिली या पहले ही हटा दी गई।' },

  // ---- Users (USER) --------------------------------------------------------
  'NP-USER-0001': { http: 409, level: 'info', en: 'This username is already taken.', hi: 'यह उपयोगकर्ता नाम पहले से लिया गया है।' },
  'NP-USER-0002': { http: 404, level: 'info', en: 'User not found.', hi: 'उपयोगकर्ता नहीं मिला।' },
  'NP-USER-0003': { http: 409, level: 'warn', en: 'This account holds an oversight role; disabling it needs a change request approved by a quorum.', hi: 'इस खाते के पास निगरानी भूमिका है; इसे निष्क्रिय करने के लिए कोरम-स्वीकृत परिवर्तन अनुरोध आवश्यक है।' },

  // ---- Registry: offices, posts, services (REG) ----------------------------
  'NP-REG-0001': { http: 404, level: 'info', en: 'Office not found.', hi: 'कार्यालय नहीं मिला।' },
  'NP-REG-0002': { http: 404, level: 'info', en: 'Post not found.', hi: 'पद नहीं मिला।' },
  'NP-REG-0003': { http: 404, level: 'info', en: 'Service not found.', hi: 'सेवा नहीं मिली।' },
  'NP-REG-0004': { http: 409, level: 'warn', en: 'This cannot be removed while other records still refer to it.', hi: 'इसे हटाया नहीं जा सकता क्योंकि अन्य रिकॉर्ड अभी भी इससे जुड़े हैं।' },
  'NP-REG-0005': { http: 409, level: 'info', en: 'This service code already exists here.', hi: 'यह सेवा कोड यहाँ पहले से मौजूद है।' },
  'NP-REG-0006': { http: 409, level: 'info', en: 'This post already has a current holder. End that assignment first.', hi: 'इस पद पर पहले से कोई पदधारी है। पहले उसकी नियुक्ति समाप्त करें।' },

  // ---- Jurisdiction classification (CLASS) ---------------------------------
  'NP-CLASS-0001': { http: 404, level: 'info', en: 'Unknown classification axis.', hi: 'अज्ञात वर्गीकरण अक्ष।' },
  'NP-CLASS-0002': { http: 404, level: 'info', en: 'Unknown value for this classification axis.', hi: 'इस वर्गीकरण अक्ष के लिए अज्ञात मान।' },
  'NP-CLASS-0003': { http: 400, level: 'info', en: 'This axis allows more than one value and cannot be set this way.', hi: 'यह अक्ष एक से अधिक मान स्वीकार करता है और इस तरह सेट नहीं किया जा सकता।' },

  // ---- Organization directory (ORG) ----------------------------------------
  'NP-ORG-0001': { http: 404, level: 'info', en: 'Organization entity not found.', hi: 'संगठन संस्था नहीं मिली।' },
  'NP-ORG-0002': { http: 409, level: 'warn', en: 'This cannot be removed while other records still refer to it.', hi: 'इसे हटाया नहीं जा सकता क्योंकि अन्य रिकॉर्ड अभी भी इससे जुड़े हैं।' },
  'NP-ORG-0003': { http: 400, level: 'info', en: 'A parent entity must be in the same or an ancestor node.', hi: 'मूल संस्था उसी या पूर्वज क्षेत्र में होनी चाहिए।' },

  // ---- Grievance intake (INTAKE) --------------------------------------------
  'NP-INTAKE-0001': { http: 404, level: 'info', en: 'Grievance not found.', hi: 'शिकायत नहीं मिली।' },
  'NP-INTAKE-0002': { http: 400, level: 'info', en: 'A grievance must target a known service or organization, or state a subject on its own.', hi: 'शिकायत किसी ज्ञात सेवा या संगठन से जुड़ी होनी चाहिए, या अपना विषय स्पष्ट बताए।' },
  'NP-INTAKE-0003': { http: 400, level: 'info', en: 'That status change is not allowed from the current status.', hi: 'वर्तमान स्थिति से यह बदलाव स्वीकार्य नहीं है।' },
  'NP-INTAKE-0004': { http: 403, level: 'info', en: 'Grievance intake is not switched on here yet.', hi: 'शिकायत दर्ज करना अभी यहाँ सक्रिय नहीं है।' },
  'NP-INTAKE-0005': { http: 400, level: 'info', en: 'Only an authenticated citizen may file under their own identity; use ANONYMOUS otherwise.', hi: 'केवल प्रमाणित नागरिक ही अपनी पहचान से दर्ज कर सकता है; अन्यथा गुमनाम विकल्प का उपयोग करें।' },

  // ---- Case engine (CASE) ----------------------------------------------------
  'NP-CASE-0001': { http: 404, level: 'info', en: 'Case not found.', hi: 'मामला नहीं मिला।' },
  'NP-CASE-0002': { http: 400, level: 'info', en: 'That person cannot be assigned: no such active staff account.', hi: 'उस व्यक्ति को सौंपा नहीं जा सकता: ऐसा कोई सक्रिय कर्मचारी खाता नहीं है।' },
  'NP-CASE-0003': { http: 409, level: 'info', en: 'This grievance is not awaiting closure confirmation.', hi: 'यह शिकायत समापन पुष्टि की प्रतीक्षा में नहीं है।' },
  'NP-CASE-0004': { http: 403, level: 'info', en: 'Only the citizen who filed this grievance may confirm or dispute its closure.', hi: 'इस शिकायत को दर्ज करने वाला नागरिक ही इसके समापन की पुष्टि या विवाद कर सकता है।' },
  'NP-CASE-0005': { http: 410, level: 'info', en: 'The window to confirm or dispute this closure has already passed.', hi: 'इस समापन की पुष्टि या विवाद करने की समय-सीमा समाप्त हो चुकी है।' },

  // ---- Citizen identity (CIT) -----------------------------------------------
  'NP-CIT-0001': { http: 403, level: 'info', en: 'Citizen self-service is not switched on here yet.', hi: 'नागरिक स्व-सेवा अभी यहाँ सक्रिय नहीं है।' },
  'NP-CIT-0002': { http: 400, level: 'info', en: 'Enter a valid 10-digit mobile number.', hi: 'एक मान्य 10 अंकों का मोबाइल नंबर दर्ज करें।' },
  'NP-CIT-0003': { http: 401, level: 'warn', en: 'The code is incorrect or has expired. Request a new one.', hi: 'कोड गलत है या समाप्त हो गया है। नया कोड माँगें।' },
  'NP-CIT-0004': { http: 429, level: 'warn', en: 'Too many attempts for this code. Request a new one.', hi: 'इस कोड के लिए बहुत अधिक प्रयास। नया कोड माँगें।' },
  'NP-CIT-0005': { http: 403, level: 'warn', en: 'This citizen account is disabled.', hi: 'यह नागरिक खाता निष्क्रिय है।' },
  'NP-CIT-0006': { http: 401, level: 'info', en: 'Your session has expired. Please verify your mobile number again.', hi: 'आपका सत्र समाप्त हो गया है। कृपया अपना मोबाइल नंबर फिर से सत्यापित करें।' },
  'NP-CIT-0007': { http: 401, level: 'warn', en: 'This session was signed out.', hi: 'यह सत्र साइन आउट कर दिया गया था।' },
  'NP-CIT-0008': { http: 401, level: 'info', en: 'Please verify your mobile number to continue.', hi: 'जारी रखने के लिए कृपया अपना मोबाइल नंबर सत्यापित करें।' },
  'NP-CIT-0009': { http: 503, level: 'error', en: 'Could not send the verification code right now. Please try again shortly.', hi: 'अभी सत्यापन कोड नहीं भेजा जा सका। कृपया थोड़ी देर बाद प्रयास करें।' },

  // ---- Audit (AUDIT) -------------------------------------------------------
  'NP-AUDIT-0001': { http: 500, level: 'fatal', en: 'The audit log failed an integrity check.', hi: 'ऑडिट लॉग अखंडता जाँच में विफल रहा।' },
  'NP-AUDIT-0002': { http: 500, level: 'error', en: 'The action could not be recorded in the audit log, so it was not performed.', hi: 'कार्य ऑडिट लॉग में दर्ज नहीं हो सका, इसलिए नहीं किया गया।' },
  'NP-AUDIT-0003': { http: 500, level: 'error', en: 'Audit checkpoint signature is invalid.', hi: 'ऑडिट चेकपॉइंट हस्ताक्षर अमान्य है।' },

  // ---- Background worker (WORK) -------------------------------------------
  'NP-WORK-0001': { http: 500, level: 'error', en: 'Background job failed.', hi: 'पृष्ठभूमि कार्य विफल रहा।' },
  'NP-WORK-0002': { http: 500, level: 'error', en: 'Audit relay failed.', hi: 'ऑडिट रिले विफल रहा।' },
  'NP-WORK-0003': { http: 500, level: 'error', en: 'Audit checkpoint signing failed.', hi: 'ऑडिट चेकपॉइंट हस्ताक्षर विफल रहा।' },

  // ---- Client-side (CLIENT) — reported by the web app ---------------------
  'NP-CLIENT-0001': { http: 0, level: 'warn', en: 'The server could not be reached. Check your connection.', hi: 'सर्वर से संपर्क नहीं हो सका। कनेक्शन जाँचें।' },
  'NP-CLIENT-0002': { http: 0, level: 'error', en: 'Something went wrong on this page.', hi: 'इस पृष्ठ पर कुछ गड़बड़ हुई।' },

  // ---- Catch-all (INT) -----------------------------------------------------
  'NP-INT-0001': { http: 500, level: 'error', en: 'Something went wrong. The incident has been logged.', hi: 'कुछ गड़बड़ हुई। घटना दर्ज कर ली गई है।' }
} as const satisfies Record<string, ErrorSpec>;

/** Union of all known error codes. */
export type ErrorCode = keyof typeof ERRORS;

/** Shape of every error response body returned by the API. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Correlates the response with server log lines. */
    requestId?: string;
    /** Field-level validation problems, when code is NP-VAL-0001. */
    fields?: { path: string; message: string }[];
  };
}

/** True if the value is a known error code (used when parsing untrusted input). */
export function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ERRORS, v);
}
