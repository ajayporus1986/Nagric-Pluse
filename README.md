# Nagrik Pulse · नागरिक पल्स

A public-grievance and accountability platform built one district at a time. The pilot district is **Gautam Buddh Nagar (LGD 144), Uttar Pradesh**. Every other district is replicated from the same district package: jurisdiction tree, offices and posts, service timelines (editable per district; the UP Janhit Guarantee Act is the baseline), languages (Hindi and English), and module defaults.

## Layout

| Path | What it is |
| --- | --- |
| `packages/shared` | Role catalogue, scope levels, decision lattice, module manifest schema, hi/en messages |
| `packages/policy` | Pure policy resolver: availability (module → feature → realm → kill switch → election overlay) and authorization, with a trace |
| `apps/api` | Fastify API (modular monolith; each module owns its schema) |
| `apps/worker` | Background jobs: audit relay, checkpoint signing, kill-switch expiry |
| `apps/web` | Admin and citizen web app (Hindi and English) |
| `db/migrations` | Ordered SQL migrations |
| `docker` | Production images and compose file |

## Lego control model

Everything that can be switched is a **module** with **features**, and every feature has **actions** granted to **roles**. Settings are placed on nodes of the jurisdiction tree (nation → state → district → tehsil/block, urban body or authority → ward/village):

- a module or feature switched **off** at a node is off for the whole subtree;
- otherwise the nearest setting wins, falling back to the module's default;
- permission overrides at the nearest node replace the manifest's default grants;
- invariant functions (grievance intake, tracking, emergency, whistleblower, data-rights requests) can never be switched off, though they still require authorization;
- changes go through quorum change requests by Realm Governors, with an impact preview.

## Development

```bash
pnpm install
pnpm build && pnpm test
```

Requires Node 22 and pnpm 10. See `SECURITY.md` before contributing.
