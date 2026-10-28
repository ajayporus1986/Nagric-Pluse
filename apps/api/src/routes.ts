/**
 * Route registry: every module's routes are registered here. Adding a module
 * means adding its manifest to modules/manifests.ts and its routes below.
 */
import type { App, AppDeps } from './http/app.js';
import { registerSystemRoutes } from './http/routes-system.js';
import { registerAuthRoutes } from './iam/routes-auth.js';
import { registerUserRoutes } from './iam/routes-users.js';
import { registerPlatformRoutes } from './platform/routes.js';
import { registerAuditRoutes } from './audit/routes.js';
import { registerRegistryRoutes } from './registry/routes.js';
import { registerCitizenRoutes } from './citizen/routes.js';
import { registerOrgRoutes } from './org/routes.js';
import { registerIntakeRoutes } from './intake/routes.js';
import { registerCaseRoutes } from './case/routes.js';
import { registerAccountabilityRoutes } from './accountability/routes.js';

export function registerRoutes(app: App, deps: AppDeps): void {
  registerSystemRoutes(app, deps);
  registerAuthRoutes(app, deps);
  registerUserRoutes(app, deps);
  registerPlatformRoutes(app, deps);
  registerAuditRoutes(app, deps);
  registerRegistryRoutes(app, deps);
  registerCitizenRoutes(app, deps);
  registerOrgRoutes(app, deps);
  registerIntakeRoutes(app, deps);
  registerCaseRoutes(app, deps);
  registerAccountabilityRoutes(app, deps);
}
