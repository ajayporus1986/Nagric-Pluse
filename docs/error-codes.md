# Error codes

_Generated from `packages/shared/src/errors.ts` by `scripts/gen-error-docs.mjs`. Do not edit by hand._

Every failure carries one of these codes in the API response (`error.code`), in the server log (`errCode`) and in the console, together with a request reference (`requestId` / `reqId`). To investigate a report, search the logs for the reference.


## Configuration and startup

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-CFG-0001` | 500 | fatal | Server configuration is invalid. | सर्वर कॉन्फ़िगरेशन अमान्य है। |
| `NP-CFG-0002` | 500 | fatal | Encryption keys are missing or invalid. | एन्क्रिप्शन कुंजियाँ अनुपलब्ध या अमान्य हैं। |
| `NP-CFG-0003` | 500 | fatal | Module manifests failed validation. | मॉड्यूल मैनिफ़ेस्ट सत्यापन विफल रहा। |
| `NP-CFG-0004` | 500 | fatal | A route was registered without an access declaration. | एक रूट बिना पहुँच घोषणा के पंजीकृत हुआ। |

## Database

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-DB-0001` | 503 | error | The database is unavailable. Please try again shortly. | डेटाबेस उपलब्ध नहीं है। कृपया थोड़ी देर बाद प्रयास करें। |
| `NP-DB-0002` | 503 | error | The request took too long. Please try again. | अनुरोध में बहुत समय लगा। कृपया पुनः प्रयास करें। |
| `NP-DB-0003` | 409 | warn | This record was changed by someone else. Reload and try again. | यह रिकॉर्ड किसी और ने बदल दिया है। पुनः लोड करें। |
| `NP-DB-0004` | 500 | error | A data integrity rule was violated. | डेटा अखंडता नियम का उल्लंघन हुआ। |

## HTTP

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-HTTP-0001` | 404 | info | Not found. | नहीं मिला। |
| `NP-HTTP-0002` | 413 | warn | The request is too large. | अनुरोध बहुत बड़ा है। |
| `NP-HTTP-0003` | 415 | warn | Unsupported content type. | असमर्थित सामग्री प्रकार। |
| `NP-HTTP-0004` | 400 | warn | The request could not be read. | अनुरोध पढ़ा नहीं जा सका। |

## Validation

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-VAL-0001` | 400 | info | Some fields are invalid. | कुछ फ़ील्ड अमान्य हैं। |

## Sign-in

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-AUTH-0001` | 401 | info | Please sign in. | कृपया साइन इन करें। |
| `NP-AUTH-0002` | 401 | warn | Username or password is incorrect. | उपयोगकर्ता नाम या पासवर्ड गलत है। |
| `NP-AUTH-0003` | 423 | warn | This account is temporarily locked after repeated failed sign-ins. | बार-बार असफल प्रयासों के कारण खाता अस्थायी रूप से बंद है। |
| `NP-AUTH-0004` | 403 | warn | This account is disabled. | यह खाता निष्क्रिय है। |
| `NP-AUTH-0005` | 403 | info | You must change your password before continuing. | आगे बढ़ने से पहले पासवर्ड बदलें। |
| `NP-AUTH-0006` | 400 | info | The new password does not meet the password rules. | नया पासवर्ड नियमों के अनुरूप नहीं है। |
| `NP-AUTH-0007` | 400 | info | The current password is incorrect. | वर्तमान पासवर्ड गलत है। |

## Second factor

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-MFA-0001` | 403 | info | Second-factor verification is required. | दूसरे चरण का सत्यापन आवश्यक है। |
| `NP-MFA-0002` | 403 | info | You must set up an authenticator app before continuing. | आगे बढ़ने से पहले ऑथेंटिकेटर ऐप सेट करें। |
| `NP-MFA-0003` | 401 | warn | The verification code is incorrect or expired. | सत्यापन कोड गलत या समाप्त है। |
| `NP-MFA-0004` | 409 | warn | An authenticator is already set up for this account. | इस खाते के लिए ऑथेंटिकेटर पहले से सेट है। |
| `NP-MFA-0005` | 409 | warn | Start authenticator setup first. | पहले ऑथेंटिकेटर सेटअप शुरू करें। |

## Sessions

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-SESS-0001` | 401 | info | Your session has expired. Please sign in again. | आपका सत्र समाप्त हो गया है। कृपया फिर से साइन इन करें। |
| `NP-SESS-0002` | 401 | warn | This session was signed out. | यह सत्र साइन आउट कर दिया गया था। |

## Request forgery protection

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-CSRF-0001` | 403 | warn | Security token missing or invalid. Reload the page and try again. | सुरक्षा टोकन अनुपलब्ध या अमान्य है। पृष्ठ पुनः लोड करें। |
| `NP-CSRF-0002` | 403 | warn | Request origin not allowed. | अनुरोध का स्रोत अनुमत नहीं है। |

## Rate limits

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-RATE-0001` | 429 | warn | Too many attempts. Please wait and try again. | बहुत अधिक प्रयास। कृपया प्रतीक्षा करें। |

## Access policy (Lego controls)

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-POL-0001` | 403 | warn | You do not have permission for this action here. | आपको यहाँ इस कार्य की अनुमति नहीं है। |
| `NP-POL-0002` | 403 | info | This feature is not active here. | यह सुविधा यहाँ सक्रिय नहीं है। |
| `NP-POL-0003` | 503 | error | Access rules are temporarily unavailable. | पहुँच नियम अस्थायी रूप से उपलब्ध नहीं हैं। |

## Jurisdiction tree

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-SCOPE-0001` | 404 | info | This area is not in the jurisdiction list. | यह क्षेत्र क्षेत्राधिकार सूची में नहीं है। |
| `NP-SCOPE-0002` | 400 | info | This role cannot be assigned at this level. | यह भूमिका इस स्तर पर नहीं दी जा सकती। |

## Change requests and quorum

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-CR-0001` | 404 | info | Change request not found. | परिवर्तन अनुरोध नहीं मिला। |
| `NP-CR-0002` | 409 | info | This change request is no longer open. | यह परिवर्तन अनुरोध अब खुला नहीं है। |
| `NP-CR-0003` | 409 | warn | You have already voted on this change request. | आप इस अनुरोध पर पहले ही मत दे चुके हैं। |
| `NP-CR-0004` | 403 | warn | You cannot approve a change that concerns your own account. | आप अपने ही खाते से जुड़े परिवर्तन को अनुमोदित नहीं कर सकते। |
| `NP-CR-0005` | 409 | info | This change would not change anything. | इस परिवर्तन से कुछ नहीं बदलेगा। |
| `NP-CR-0006` | 400 | info | This is a protected function and cannot be switched off. | यह संरक्षित कार्य है, इसे बंद नहीं किया जा सकता। |
| `NP-CR-0007` | 404 | info | Unknown module or feature. | अज्ञात मॉड्यूल या सुविधा। |
| `NP-CR-0008` | 409 | warn | Approved, but the change could no longer be applied. It has been rejected. | अनुमोदित, किंतु परिवर्तन लागू नहीं हो सका; इसे अस्वीकृत किया गया। |
| `NP-CR-0009` | 409 | info | A similar change request is already open for this area. | इस क्षेत्र के लिए समान परिवर्तन अनुरोध पहले से खुला है। |

## Emergency stop

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-KILL-0001` | 400 | warn | Protected modules cannot be emergency-stopped. | संरक्षित मॉड्यूल को आपात रूप से रोका नहीं जा सकता। |
| `NP-KILL-0002` | 409 | info | An emergency stop is already active for this module here. | इस मॉड्यूल पर आपात रोक पहले से सक्रिय है। |
| `NP-KILL-0003` | 404 | info | Emergency stop not found or already cleared. | आपात रोक नहीं मिली या पहले ही हटा दी गई। |

## Staff accounts

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-USER-0001` | 409 | info | This username is already taken. | यह उपयोगकर्ता नाम पहले से लिया गया है। |
| `NP-USER-0002` | 404 | info | User not found. | उपयोगकर्ता नहीं मिला। |
| `NP-USER-0003` | 409 | warn | This account holds an oversight role; disabling it needs a change request approved by a quorum. | इस खाते के पास निगरानी भूमिका है; इसे निष्क्रिय करने के लिए कोरम-स्वीकृत परिवर्तन अनुरोध आवश्यक है। |

## Office & service registry

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-REG-0001` | 404 | info | Office not found. | कार्यालय नहीं मिला। |
| `NP-REG-0002` | 404 | info | Post not found. | पद नहीं मिला। |
| `NP-REG-0003` | 404 | info | Service not found. | सेवा नहीं मिली। |
| `NP-REG-0004` | 409 | warn | This cannot be removed while other records still refer to it. | इसे हटाया नहीं जा सकता क्योंकि अन्य रिकॉर्ड अभी भी इससे जुड़े हैं। |
| `NP-REG-0005` | 409 | info | This service code already exists here. | यह सेवा कोड यहाँ पहले से मौजूद है। |
| `NP-REG-0006` | 409 | info | This post already has a current holder. End that assignment first. | इस पद पर पहले से कोई पदधारी है। पहले उसकी नियुक्ति समाप्त करें। |

## Jurisdiction classification

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-CLASS-0001` | 404 | info | Unknown classification axis. | अज्ञात वर्गीकरण अक्ष। |
| `NP-CLASS-0002` | 404 | info | Unknown value for this classification axis. | इस वर्गीकरण अक्ष के लिए अज्ञात मान। |
| `NP-CLASS-0003` | 400 | info | This axis allows more than one value and cannot be set this way. | यह अक्ष एक से अधिक मान स्वीकार करता है और इस तरह सेट नहीं किया जा सकता। |

## Organization directory

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-ORG-0001` | 404 | info | Organization entity not found. | संगठन संस्था नहीं मिली। |
| `NP-ORG-0002` | 409 | warn | This cannot be removed while other records still refer to it. | इसे हटाया नहीं जा सकता क्योंकि अन्य रिकॉर्ड अभी भी इससे जुड़े हैं। |
| `NP-ORG-0003` | 400 | info | A parent entity must be in the same or an ancestor node. | मूल संस्था उसी या पूर्वज क्षेत्र में होनी चाहिए। |

## Grievance intake

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-INTAKE-0001` | 404 | info | Grievance not found. | शिकायत नहीं मिली। |
| `NP-INTAKE-0002` | 400 | info | A grievance must target a known service or organization, or state a subject on its own. | शिकायत किसी ज्ञात सेवा या संगठन से जुड़ी होनी चाहिए, या अपना विषय स्पष्ट बताए। |
| `NP-INTAKE-0003` | 400 | info | That status change is not allowed from the current status. | वर्तमान स्थिति से यह बदलाव स्वीकार्य नहीं है। |
| `NP-INTAKE-0004` | 403 | info | Grievance intake is not switched on here yet. | शिकायत दर्ज करना अभी यहाँ सक्रिय नहीं है। |
| `NP-INTAKE-0005` | 400 | info | Only an authenticated citizen may file under their own identity; use ANONYMOUS otherwise. | केवल प्रमाणित नागरिक ही अपनी पहचान से दर्ज कर सकता है; अन्यथा गुमनाम विकल्प का उपयोग करें। |

## Case engine

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-CASE-0001` | 404 | info | Case not found. | मामला नहीं मिला। |
| `NP-CASE-0002` | 400 | info | That person cannot be assigned: no such active staff account. | उस व्यक्ति को सौंपा नहीं जा सकता: ऐसा कोई सक्रिय कर्मचारी खाता नहीं है। |
| `NP-CASE-0003` | 409 | info | This grievance is not awaiting closure confirmation. | यह शिकायत समापन पुष्टि की प्रतीक्षा में नहीं है। |
| `NP-CASE-0004` | 403 | info | Only the citizen who filed this grievance may confirm or dispute its closure. | इस शिकायत को दर्ज करने वाला नागरिक ही इसके समापन की पुष्टि या विवाद कर सकता है। |
| `NP-CASE-0005` | 410 | info | The window to confirm or dispute this closure has already passed. | इस समापन की पुष्टि या विवाद करने की समय-सीमा समाप्त हो चुकी है। |

## Official accountability & leadership reporting

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-ACC-0001` | 404 | info | Notice not found. | नोटिस नहीं मिला। |
| `NP-ACC-0002` | 400 | info | That person cannot be given a notice: no such active staff account. | उस व्यक्ति को नोटिस नहीं दिया जा सकता: ऐसा कोई सक्रिय कर्मचारी खाता नहीं है। |
| `NP-ACC-0003` | 409 | info | This notice is not in a state that allows that action. | यह नोटिस इस कार्रवाई की अनुमति देने वाली स्थिति में नहीं है। |
| `NP-ACC-0004` | 403 | info | Only the officer this notice concerns may reply to or appeal it. | इस नोटिस से संबंधित अधिकारी ही इसका उत्तर या अपील दे सकता है। |
| `NP-ACC-0005` | 410 | info | The window to reply to this notice has already passed. | इस नोटिस का उत्तर देने की समय-सीमा समाप्त हो चुकी है। |
| `NP-ACC-0006` | 400 | info | Unknown or inactive pull reason code. | अज्ञात या निष्क्रिय पुल कारण कोड। |

## Citizen identity

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-CIT-0001` | 403 | info | Citizen self-service is not switched on here yet. | नागरिक स्व-सेवा अभी यहाँ सक्रिय नहीं है। |
| `NP-CIT-0002` | 400 | info | Enter a valid 10-digit mobile number. | एक मान्य 10 अंकों का मोबाइल नंबर दर्ज करें। |
| `NP-CIT-0003` | 401 | warn | The code is incorrect or has expired. Request a new one. | कोड गलत है या समाप्त हो गया है। नया कोड माँगें। |
| `NP-CIT-0004` | 429 | warn | Too many attempts for this code. Request a new one. | इस कोड के लिए बहुत अधिक प्रयास। नया कोड माँगें। |
| `NP-CIT-0005` | 403 | warn | This citizen account is disabled. | यह नागरिक खाता निष्क्रिय है। |
| `NP-CIT-0006` | 401 | info | Your session has expired. Please verify your mobile number again. | आपका सत्र समाप्त हो गया है। कृपया अपना मोबाइल नंबर फिर से सत्यापित करें। |
| `NP-CIT-0007` | 401 | warn | This session was signed out. | यह सत्र साइन आउट कर दिया गया था। |
| `NP-CIT-0008` | 401 | info | Please verify your mobile number to continue. | जारी रखने के लिए कृपया अपना मोबाइल नंबर सत्यापित करें। |
| `NP-CIT-0009` | 503 | error | Could not send the verification code right now. Please try again shortly. | अभी सत्यापन कोड नहीं भेजा जा सका। कृपया थोड़ी देर बाद प्रयास करें। |

## Audit ledger

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-AUDIT-0001` | 500 | fatal | The audit log failed an integrity check. | ऑडिट लॉग अखंडता जाँच में विफल रहा। |
| `NP-AUDIT-0002` | 500 | error | The action could not be recorded in the audit log, so it was not performed. | कार्य ऑडिट लॉग में दर्ज नहीं हो सका, इसलिए नहीं किया गया। |
| `NP-AUDIT-0003` | 500 | error | Audit checkpoint signature is invalid. | ऑडिट चेकपॉइंट हस्ताक्षर अमान्य है। |

## Background worker

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-WORK-0001` | 500 | error | Background job failed. | पृष्ठभूमि कार्य विफल रहा। |
| `NP-WORK-0002` | 500 | error | Audit relay failed. | ऑडिट रिले विफल रहा। |
| `NP-WORK-0003` | 500 | error | Audit checkpoint signing failed. | ऑडिट चेकपॉइंट हस्ताक्षर विफल रहा। |

## Web console (client side)

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-CLIENT-0001` | — | warn | The server could not be reached. Check your connection. | सर्वर से संपर्क नहीं हो सका। कनेक्शन जाँचें। |
| `NP-CLIENT-0002` | — | error | Something went wrong on this page. | इस पृष्ठ पर कुछ गड़बड़ हुई। |

## Unexpected

| Code | HTTP | Log level | English | Hindi |
| --- | --- | --- | --- | --- |
| `NP-INT-0001` | 500 | error | Something went wrong. The incident has been logged. | कुछ गड़बड़ हुई। घटना दर्ज कर ली गई है। |
