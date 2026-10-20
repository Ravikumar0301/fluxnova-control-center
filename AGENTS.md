# Fluxnova Control Center

## Purpose and architecture

Fluxnova Control Center is a browser UI for monitoring and administering Fluxnova BPM Engine resources. It is an Nx monorepo with an Angular single-page application and a NestJS backend-for-frontend (BFF). The browser calls same-origin `/api` routes on the BFF; the BFF calls the configured Fluxnova Engine REST API and serves the built frontend. In development, the Angular dev server proxies `/api` to `http://localhost:4000`.

## Repository map

- `apps/frontend`: Angular app, bootstrapped at `src/main.ts`; `app/app.module.ts` assembles shared UI and process features, and `app/app-routing.module.ts` defines tenant-scoped pages.
- `apps/server`: NestJS BFF, bootstrapped from `src/main.ts` and configured in `src/app/main-setup.ts` / `src/app/app.module.ts`. `src/auth` contains login, session, OIDC and CSRF handling; `src/fluxnova` contains API controllers and the generated REST client integration; `src/config` validates environment configuration; `src/static-assets` serves the frontend build.
- `apps/e2e`: Playwright end-to-end, mocked end-to-end and regression suites; fixtures and BPMN/DMN test models live under `src`.
- `libs/common`: shared Angular services, auth/permission UI, layout and general components.
- `libs/process-modification`: process/decision/deployment/batch screens, diagrams, actions and engine-facing frontend services.
- `libs/grid`: shared AG Grid components and renderers.
- `libs/types`: shared TypeScript models, configuration types and permission definitions.
- `libs/shared-assets`: shared static assets and loading styles.
- `libs/test-support`: test doubles and shared test setup.
- `docs`: setup guides and configuration/authentication/workflow references. `docker`: local Keycloak/engine/control-center compose setup and local certificates. `scripts`: client generation, Vault templates and container entrypoint.

## Stack and development workflow

The manifests specify Node.js `>=24 <25`, pnpm `11.23.0` (via Corepack), Nx `23.2.1`, Angular `22.1.7`, NestJS `11`, TypeScript and Vite/Vitest. Playwright is used for browser tests. `pnpm-lock.yaml` is the dependency lockfile.

Commands below are defined in repository documentation/manifests; they were not executed during this read-only discovery:

- Setup: `corepack enable`, `corepack install`, `pnpm install`; then `./scripts/generate-fluxnova-client.sh` when regenerating the API client.
- Start both development apps: `pnpm start` (Nx serves `server` and `frontend`). Default local UI/BFF URL is `http://localhost:4000`; the engine URL must be configured separately.
- Build: `pnpm build` (Nx/Angular default build); production app builds: `pnpm build:prod` (server and frontend, then compression).
- Unit tests: `pnpm test` for the configured default app; `pnpm test:all` for all Nx projects. Individual targets can be run with `pnpm exec nx test <project>`.
- Lint/format: `pnpm lint` (Nx affected lint); `pnpm format:check` / `pnpm format:write`.
- Browser suites: `pnpm e2e`, `pnpm me2e`, and `pnpm reg`; E2E defaults to `FXN_BASE_URL` or `http://localhost:4000` and can start the app itself. Vault-backed workflows are `pnpm start:env` and `pnpm e2e:env`.
- Local Keycloak stack is described by `docker/docker-compose-keycloak.yml`; consult `docs/guides/local-oidc-setup.md` before using it. Do not change container/resource state as part of code-only work unless explicitly requested.

## Request flow and API integration

The Angular app initializes user/engine context through `./api/auth`, selects an engine (tenant), and sends its tenant context header on API requests. The `AuthInterceptor` handles session-expiry responses and adds context headers. Permission services ask `/api/authorization/check`; action-to-permission mappings are in `libs/types/src/permissions.ts`. These client checks control UI affordances and must not be treated as the sole security boundary.

Nest's global `SessionGuard` protects non-public routes. Fluxnova controllers build typed clients from `FXN_REST_API_URL` and forward the signed-in user's identity token in the configured identity header. `AuthenticationModule` can separately attach an app-level OAuth client-credentials token to engine HTTP requests when `FXN_API_AUTH_ENABLED=true`. Authorization enforcement for engine resources ultimately depends on the Fluxnova Engine and its configured authentication/authorization; verify that deployment configuration independently.

The generated engine client lives at `apps/server/src/fluxnova/generated` and is produced from `fluxnova-openapi.json` / the engine OpenAPI artifact by `scripts/generate-fluxnova-client.sh`. Generated code should not be hand-edited; regenerate from the intended API specification/version.

## Authentication and configuration

UI auth is selected with `FXN_AUTH_STRATEGY=oidc|none`; the code defaults to `none`, matching local engine development. OIDC config is loaded in `apps/server/src/config/oidc.config.ts`; required OIDC authority, authorization URL, client ID/secret, issuer, token URL and userinfo URL are validated when OIDC is selected. SSO uses authorization-code flow through `api/sso` and `api/callback`; a local username/password route is also present and depends on provider policy. The BFF stores the compressed ID token in a `cookie-session` session, refreshes tokens through MSAL, and clears expired sessions. Cookie signing keys come from `FXN_COOKIE_KEYS`; CSRF uses `FXN_CSRF_KEY`. Session cookies are signed, not encrypted, so do not put secrets or confidential data in session payloads.

The callback return path is decoded from state and constrained to an internal path by `apps/server/src/context/request.ts`. Keep redirect validation in place. CSRF protection is installed globally with explicitly documented exceptions for login and the log-level endpoint. Avoid weakening it or bypassing the global guard.

The API authentication settings are independent of UI auth. See `docs/reference/configuration.md` and `docs/reference/authentication.md` for the full environment variable catalog. `ConfigModule` ignores `.env` files; runtime configuration comes from the process environment (including the optional Vault Agent workflow). Required production values include strong, unique `FXN_COOKIE_KEYS` and `FXN_CSRF_KEY`; configure OIDC and API client credentials only through a secret manager or protected runtime environment. Never commit, log, or include secret values in documentation, tests, diagnostics, or browser configuration. Browser code must not receive server-side client secrets.

Other important settings include `FXN_REST_API_URL`, `FXN_PUBLIC_URL`, `FXN_ENGINE_TENANT_RATIO`, `FXN_ENGINE_HEADER_KEY`, `FXN_IDENTITY_HEADER_KEY`, `FXN_SSL_KEY_PATH`, `FXN_SSL_CERT_PATH`, `FXN_SSL_KEY_PASSPHRASE[_FILE]`, `FXN_FORCE_HTTP`, `FXN_OTEL_ENABLED`, and `FXN_LOG_LEVEL`. TLS startup is implemented in `apps/server/src/start-server.ts`: deployed/container mode expects certificates unless HTTP is explicitly forced; local development may fall back to HTTP.

## Security and safe-change requirements

- Treat UI permission hiding as a usability layer. Preserve authenticated BFF routes and engine-side authorization checks for every sensitive operation.
- Never deploy with the built-in cookie/CSRF fallback secrets, disabled UI auth, weak/example credentials, or HTTP/TLS-verification bypasses. The checked-in local Keycloak compose/realm fixture includes demo credentials, a sample client secret, local TLS materials and relaxed local TLS verification settings; keep these confined to isolated local development and rotate/reconfigure before any shared or deployed use.
- The BFF session cookie contains a compressed ID token. Preserve appropriate HTTPS, cookie settings, short session lifetime, CSRF checks and token redaction. Do not send tokens to the frontend or log them. Production HTTP logging redacts authorization, cookie, set-cookie and configured identity headers; retain this behavior.
- `ApplicationRoutesController` is marked `@Public()` and exposes runtime log-level read/write and cache-clear endpoints; `PUT /api/log-level` is also exempted from CSRF checks. Treat these routes as security-sensitive and verify intended exposure/network controls before changing them or deploying.
- Do not add permissive CORS, unsafe redirects, raw HTML injection, secret-bearing error messages, or unvalidated user-controlled proxy targets. No explicit CORS setup was observed in the inspected server bootstrap; reassess if adding cross-origin access.
- Treat all local `.env`, certificate/private-key files, Vault inputs and deployment credentials as sensitive. `.env` is ignored by Git. Never print secret values while inspecting configuration.
- Local example compose currently uses mutable `latest` image tags; pin versions/digests for reproducible shared/deployed environments. TLS relaxation in the local compose is for local certificates only.
- Error handling uses shared Fluxnova error scrubbing and Pino serialization; preserve scrubbing and production redaction when changing request/error paths.

## Code conventions, testing and validation

Follow nearby Angular/Nest patterns, TypeScript types, project ESLint rules and Prettier formatting. Keep engine HTTP behavior in server controllers/services and shared request/response types in `libs/types`. Add/update colocated `*.spec.ts` Vitest tests for behavior changes; add Playwright coverage for user-visible critical flows. Do not claim tests, builds, lint or dependency audits passed unless actually run. Review generated API-client diffs and configuration changes carefully.

Before changing files, inspect the relevant Nx project target and its existing tests. Prefer targeted validation (for example `pnpm exec nx test <project> --run` and `pnpm exec nx lint <project>`) after implementation, while accounting for environment needs. Avoid broad formatting commands that rewrite unrelated files.

## Known limitations and follow-up questions

- Discovery was static. No app, tests, build, containers, database, package installation, or dependency audit was run; dependency vulnerability status is therefore unknown.
- Confirm production Keycloak/OIDC client settings, redirect URI allowlists, scopes/claims and engine-side authorization for each deployment. Local realm configuration is illustrative only.
- Confirm deployment TLS termination, cookie `Secure` behavior behind any reverse proxy, and trust boundaries for the identity header between BFF and engine.
- Verify how API error bodies and telemetry are scrubbed for the deployment's log/export pipeline, and whether engine authorization is configured on all paths.
- `FXN_FORCE_HTTP` is truthy-string checked by startup code; avoid setting it in deployed environments. The local compose file's TLS bypass and demo secrets must never be reused as production configuration.
