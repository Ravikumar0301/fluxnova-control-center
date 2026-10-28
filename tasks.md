# Implementation Plan: OAuth Client Authentication Methods

## Overview

The Client_Auth_Framework is built bottom-up in TypeScript under `apps/server/src/auth/client-auth/`. The work starts with pure building blocks (encoding, key material, keys, certificates, assertions, public JWKS). Configuration resolution and startup validation come next, then the method implementations and transport. The framework is then assembled into `ClientAuthenticator`, `ClientAuthService` and `ClientAuthModule`. The last steps wire the OIDC_Client (MSAL network client) and the API_Auth_Client (`OauthService`) through the framework and update the docs. Open decisions are implemented as the design specifies: fixed `Login failed` 401 body, cross-context same-key/same-`kid` algorithm check, `https` required for the effective token URL under mTLS methods, and `GET /api/client-auth/jwks.json` enabled by `FXN_CLIENT_AUTH_JWKS_ENDPOINT_ENABLED=true`.

All tests use Vitest (`nx test server`). Property tests use fast-check with `numRuns >= 100` and the tag comment `// Feature: oauth-client-auth-methods, Property N: <title>`.

## Tasks

- [~] 1. Set up foundations
  - [x] 1.1 Add dev dependencies and core types
    - Add `fast-check` and `@peculiar/x509` as devDependencies, pinned to exact versions
    - Create `client-auth.types.ts` (`ClientContextName`, `ClientAuthMethodName`, `CLIENT_AUTH_METHOD_NAMES`, `SupportedSigningAlgorithm`, `BodyEncoding`, `TlsClientOptions`, `ClientAuthContribution`, `ContributionInput`, `ClientAuthMethod`, `TokenRequestInput`, `TokenResponse`, `ResolvedClientAuthSettings`, `ResolvedContextSettings`, `LoadedSigningKey`, `PublicJwk`, `ConfigIssue`)
    - Create `client-auth.errors.ts` with `ClientAuthContributionError`, `TokenRequestError`, `ClientAuthConfigError`: fixed messages, `{ context, method, category?, status? }` only, never a `cause`
    - Create `config/env-names.ts` with the per-context variable name table (`FXN_OIDC_*` / `FXN_API_AUTH_*`, `_FILE` counterparts, `FXN_CLIENT_AUTH_JWKS_ENDPOINT_ENABLED`)
    - Add `libs/types/src/configuration/client-auth.config.ts`, export it from `index.ts`, and narrow `clientAuthMethod` / `clientPrivateKeyJwtAlgorithm` in `oidc.config.ts`, marking `clientSecret` / `clientPrivateKey` deprecated
    - _Requirements: 1.8, 2.4, 3.1, 10.1_

  - [-] 1.2 Create shared test helpers
    - `apps/server/src/auth/client-auth/testing/`: a key pool generated once (RSA 1024/2048/3072, RSA-PSS 2048, EC P-256/P-384, Ed25519, as PEM and JWK), a certificate factory built on `@peculiar/x509` (self-signed, CA-signed, expired, not-yet-valid, expiring), an in-memory `readFile` fake, and a capturing `Logger`
    - No committed key or certificate fixtures
    - _Requirements: 13.3, 13.8_

- [ ] 2. Implement request encoding
  - [ ] 2.1 Implement form, Basic and body encoders
    - `encoding/form-encoding.ts`: `formUrlEncode` / `formUrlDecode` per RFC 6749 Appendix B (via `URLSearchParams`)
    - `encoding/basic-credentials.ts`: `buildBasicAuthorization(id, secret)` = `Basic base64(formUrlEncode(id) ":" formUrlEncode(secret))`, plus `parseBasicAuthorization`
    - `encoding/request-body.ts`: `encodeBody(params, 'form' | 'json')`
    - _Requirements: 1.3, 4.1, 4.2, 5.1_

  - [ ]* 2.2 Write property test for Basic credentials
    - **Property 2: client_secret_basic credentials round trip**
    - **Validates: Requirements 4.1, 4.3**

  - [ ]* 2.3 Write property test for form body encoding
    - **Property 3: client_secret_post body round trip**
    - **Validates: Requirements 5.5**

- [ ] 3. Implement key material sources
  - [ ] 3.1 Implement `config/key-material-source.ts`
    - `resolveMaterial(env, inlineVar, kind, deps)` for `secret` / `pem` / `json`
    - Reject inline and `_FILE` both set (name both variables). Run the file checks in order: does not exist, is a directory, exceeds 1 MiB, permission denied, is empty/whitespace. Each issue names variable and path, never content
    - Normalisation: PEM `\r\n` and literal `\n` become `\n` for both sources; file secrets lose only trailing `\r`/`\n`; inline secrets are used as given
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7_

  - [ ]* 3.2 Write property test for key material sources
    - **Property 14: Key material source equivalence and normalisation**
    - **Validates: Requirements 10.2, 10.6, 10.7**

  - [ ]* 3.3 Write unit tests for file source errors
    - One test per reason: both set, missing, directory, >1 MiB, `EACCES`, empty, whitespace-only. Assert variable, path and reason appear and file content does not
    - _Requirements: 10.3, 10.4, 10.5, 13.4_

- [ ] 4. Implement keys, certificates, assertions and public JWKS
  - [ ] 4.1 Implement `keys/signing-key.ts`
    - Load the PEM Signing_Key via `createPrivateKey`; load Private_JWKS keys via `createPrivateKey({ format: 'jwk' })`. Public-only PEM/JWK input counts as "cannot be parsed" / "lacks private parameters"
    - `checkKeyForAlgorithm`: RS256/PS256 need RSA (or RSA-PSS for PS256) of at least 2048 bits; ES256 needs EC `prime256v1`
    - JWKS structure checks: valid JSON, `keys` array of 1–10, every `kid` present, non-empty and unique, declared `alg` equal to the configured algorithm. Issues carry context, zero-based position and `kid`, never key content
    - Active_Key selection: exact case-sensitive `kid` match, a single key without `kid`, or an issue
    - _Requirements: 7.2, 7.3, 7.4, 7.5, 7.7, 7.8, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.16, 8.17_

  - [ ]* 4.2 Write property test for key/algorithm compatibility
    - **Property 7: Key/algorithm compatibility check**
    - **Validates: Requirements 7.2, 7.3, 7.4, 7.8, 8.17**

  - [ ]* 4.3 Write property test for Active_Key selection
    - **Property 9: Active_Key selection**
    - **Validates: Requirements 8.2, 8.3, 8.4, 8.5**

  - [ ]* 4.4 Write property test for Private_JWKS structural validation
    - **Property 10: Private_JWKS structural validation identifies the offending item**
    - **Validates: Requirements 8.6, 8.16**

  - [ ] 4.5 Implement `keys/certificate.ts`
    - `loadCertificate` (first PEM block as `X509Certificate`, full chain kept for mTLS `cert`), `x5tS256` / `x5t` as unpadded base64url digests of `cert.raw`, key match via `checkPrivateKey`
    - mTLS key loading: an encrypted PEM needs a passphrase; decrypt at startup and re-export as unencrypted PKCS#8 held in memory. Report missing or wrong passphrase as an issue naming the passphrase variable
    - `classifyValidity(notBefore, notAfter, now)` returns `not_yet_valid | expired | expiring | ok` (30-day window)
    - CA bundle: parse PEM blocks; if none parse, raise an issue; count unparseable blocks in a warning; build `ca = [...tls.getCACertificates('default'), ...bundle]`
    - _Requirements: 6.11, 6.12, 7.6, 9.3, 9.4, 9.9, 9.10, 9.11, 9.12_

  - [ ]* 4.6 Write property test for certificate validity classification
    - **Property 15: Certificate validity classification**
    - **Validates: Requirements 9.10, 9.11**

  - [ ] 4.7 Implement `keys/client-assertion.ts`
    - `signClientAssertion(AssertionSigningInput)` with `jsonwebtoken.sign(..., { algorithm, header, noTimestamp: true })`
    - Header `{ alg, typ: 'JWT', kid?, 'x5t#S256'?, x5t? }`; payload exactly `{ iss, sub, aud, iat, exp: iat + 60, jti: randomUUID() }`
    - _Requirements: 1.5, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.10, 6.11, 6.12, 8.7_

  - [ ]* 4.8 Write property test for assertion sign/verify round trip
    - Exercise each of RS256, PS256 and ES256
    - **Property 5: Client assertion sign/verify round trip**
    - **Validates: Requirements 1.5, 6.3, 6.4, 6.5, 6.6, 6.8, 6.9, 6.10, 6.11, 6.12, 8.7**

  - [ ]* 4.9 Write property test for jti uniqueness
    - **Property 6: Fresh, unique jti per Token_Request**
    - **Validates: Requirements 6.1, 6.7**

  - [ ] 4.10 Implement `keys/public-jwks.ts`
    - `toPublicJwk` builds an allow-list projection from `createPublicKey(key).export({ format: 'jwk' })` plus `kid`, `use: 'sig'`, `alg`, `x5c`, `x5t#S256`, and `x5t` when enabled
    - `jwkThumbprint` (RFC 7638); `buildPublicJwks` lists OIDC keys then API keys in configuration order and de-duplicates on `(thumbprint, kid)`
    - _Requirements: 8.8, 8.9, 8.10, 8.11, 11.3_

  - [ ]* 4.11 Write property test for public JWKS projection
    - **Property 11: Public JWKS is an allow-listed, de-duplicated projection**
    - **Validates: Requirements 8.8, 8.9, 11.3**

  - [ ]* 4.12 Write property test for PEM-to-JWK round trip
    - **Property 12: PEM public key to JWK round trip**
    - **Validates: Requirements 8.10**

  - [ ]* 4.13 Write property test for public JWKS JSON round trip
    - **Property 13: Public JWKS JSON round trip**
    - **Validates: Requirements 8.11**

- [ ] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Implement configuration resolution and startup validation
  - [ ] 6.1 Implement `config/resolve-client-auth-settings.ts`
    - Per context: work out whether it is enabled (OIDC when `FXN_AUTH_STRATEGY === 'oidc'`, API when `FXN_API_AUTH_ENABLED === 'true'`). For a disabled context, read nothing and open no `_FILE` paths
    - Resolve the method: trimmed; empty means `client_secret` with source `default`; exact match against the six names; otherwise an issue naming the variable and listing all six
    - Resolve only the material the method uses (plus the CA bundle for every method) through `resolveMaterial`
    - Method checks:
      - Required ID and secret with the per-method emptiness rules (zero-length for legacy/basic; whitespace-only also empty for post). Keep the legacy error messages word for word
      - `private_key_jwt`: key missing, PEM + JWKS conflict, `P_ASSERTION_CERTIFICATE` + JWKS conflict, algorithm (default RS256), key checks, cert/key match, whitespace-only audience override
      - mTLS: missing cert/key, parse, key match, passphrase, validity window (queue a warning when expiring), `P_MTLS_TOKEN_URL` absolute `https`, effective token URL must be `https`
    - Cross-context checks when both contexts use `private_key_jwt`: a shared `kid` must have the same thumbprint, and the same key + `kid` must use the same algorithm
    - Return `{ settings, issues, warnings }`; the effective token URL is `mtlsTokenUrl ?? tokenUrl`
    - _Requirements: 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 2.6, 2.7, 2.8, 4.4, 4.5, 5.3, 5.6, 6.13, 6.14, 7.1, 7.7, 7.9, 8.6, 8.18, 9.5, 9.8, 9.9, 9.10, 9.11, 9.12, 9.13, 10.3_

  - [ ] 6.2 Implement the settings store and wire it into `validator.ts`
    - `config/client-auth-settings.store.ts` memoises resolved settings and queued warnings
    - `validateClientAuth(env)` runs the resolver with the real `fs` and clock and throws one aggregated `ClientAuthConfigError` (`Client authentication configuration is invalid:\n- ...`) or stores the settings
    - In `validator.ts`, delegate every client-credential check to `validateClientAuth`. Keep the `FXN_API_AUTH_CLIENT_ID` / `FXN_API_AUTH_TOKEN_URL` required checks; require `FXN_API_AUTH_CLIENT_SECRET` only for the secret methods
    - Add `config/client-auth.config.ts` (`registerAs('clientAuth', ...)`) reading from the store
    - _Requirements: 1.6, 1.7, 8.1, 10.8_

  - [ ]* 6.3 Write property test for method resolution
    - **Property 4: Method resolution is exact, trimmed and independent per context**
    - **Validates: Requirements 1.2, 1.4, 2.1, 2.2, 2.3, 2.4, 2.6, 2.7, 2.8**

  - [ ]* 6.4 Write property test for signing-key validation scoping
    - **Property 8: Signing-key validation is scoped to private_key_jwt**
    - **Validates: Requirements 7.9, 2.8**

  - [ ]* 6.5 Write property test for mTLS token URL validation
    - **Property 16: mTLS token endpoint URL validation**
    - **Validates: Requirements 9.13**

  - [ ]* 6.6 Write validator unit tests for every startup error
    - In `apps/server/src/config/validator.spec.ts`: one test per startup error in Requirements 2, 4, 5, 6, 7, 8, 9 and 10. Assert that startup throws, that the identifying item (variable, `kid`, position, path, date) appears, and that no material appears where required
    - Include: currently valid environments still validate; legacy missing-secret messages unchanged; a `_FILE` path is read exactly once; the open-decision checks (cross-context algorithm, `http://` effective URL under mTLS)
    - _Requirements: 1.6, 1.7, 10.8, 13.4_

- [ ] 7. Implement client authentication methods
  - [ ] 7.1 Implement the method classes and registry
    - `methods/legacy-client-secret.method.ts` (form for OIDC, JSON for API), `client-secret-basic.method.ts`, `client-secret-post.method.ts`, `private-key-jwt.method.ts` (fresh assertion per call, `aud = audienceOverride ?? endpointUrl`; a signing failure throws `ClientAuthContributionError` without `cause`), `tls-client-auth.method.ts` (shared by both mTLS names; contributes `client_id` and TLS cert/key/CA)
    - Secret and JWT methods add CA-only `tls` when a bundle is configured
    - `methods/method-registry.ts` maps the six names to factories
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 3.1, 3.4, 3.7, 4.1, 4.2, 5.1, 5.2, 6.1, 6.2, 6.15, 9.1, 9.2_

  - [ ]* 7.2 Write unit tests for each method
    - Contribution shape per method/context, CA-only TLS when a bundle is set, signing failure yields an error without credential content
    - _Requirements: 3.4, 3.7, 6.15_

- [ ] 8. Implement token transport
  - [ ] 8.1 Implement `transport/mtls-https-proxy-agent.ts`
    - Subclass `HttpsProxyAgent` that overrides `connect(req, opts)` to merge TLS client options into the per-request `opts` only, never into the constructor `connectOpts`
    - _Requirements: 9.6_

  - [ ] 8.2 Implement `transport/token-http-client.ts`
    - One axios instance per context. Agent selection per the design table (memoised per `tls` identity); `proxy: false`; proxy from `http_proxy || HTTP_PROXY`, with empty treated as unset; 5000 ms timeout for API, none for OIDC
    - `validateStatus: () => true`. A non-2xx response logs one error entry `{context, method, tokenUrl, clientId, status}` and is returned unchanged
    - A transport error is categorised as `timeout` / `dns` / `tls` / `connection`, logged once with the category, and thrown as `TokenRequestError` without `cause`. No retry, no fallback
    - _Requirements: 3.5, 3.6, 4.6, 9.1, 9.3, 9.7, 9.14, 11.2, 11.4_

  - [ ]* 8.3 Write unit tests for the token HTTP client
    - Proxy table: `http_proxy` / `HTTP_PROXY` set, empty or unset, with and without TLS options. Error categorisation. Exactly one transport call on rejection or failure. Log entry contents
    - _Requirements: 3.5, 3.6, 4.6, 9.14, 11.2, 11.4_

  - [ ]* 8.4 Write local mTLS integration tests
    - Local `https.createServer({ requestCert: true, rejectUnauthorized: true })` on `127.0.0.1:0` and a local HTTPS CONNECT proxy in test helpers
    - `tls_client_auth` success returns a token; a request with no client certificate fails with category `tls` or `connection`; a private-CA server succeeds with the CA bundle and fails without it; the proxy sees no peer certificate while the destination sees the client certificate
    - _Requirements: 9.1, 9.3, 9.6, 9.14, 13.5, 13.6, 13.8_

- [ ] 9. Assemble the framework
  - [ ] 9.1 Implement `client-authenticator.ts`
    - `send()`: contribute (on failure log `{context, method}` and rethrow, with no HTTP call), merge `grantParams` with the contribution (credential keys only from the contribution), build headers (drop passthrough `authorization` / `content-type`, set the content type for the encoding, add contribution headers), then call `TokenHttpClient.post`
    - Expose `context`, `method` and the effective `tokenUrl`
    - _Requirements: 2.5, 3.2, 3.3, 3.4, 3.7, 6.15, 9.5_

  - [ ] 9.2 Implement `client-auth.service.ts`
    - Build one `ClientAuthenticator` per enabled context from the store; `forContext(ctx)`; `getPublicJwks()`
    - `onModuleInit` logs exactly one `client authentication configured` entry per enabled context (`context`, `method`, `source`) and the queued startup warnings
    - _Requirements: 2.9, 8.8, 9.10_

  - [ ] 9.3 Implement `jwks.controller.ts` and `client-auth.module.ts`
    - `@Controller('api/client-auth')` with `@Public() @Get('jwks.json') @Header('Content-Type','application/json')`, returning `{ keys }`
    - `ClientAuthModule.register()` provides and exports `ClientAuthService`, and adds `JwksController` only when `FXN_CLIENT_AUTH_JWKS_ENDPOINT_ENABLED === 'true'`
    - _Requirements: 8.12, 8.13, 8.14, 8.15_

  - [ ]* 9.4 Write unit tests for the startup log
    - One entry per enabled context with the correct source, none for disabled contexts, no secret content, an expiring-certificate warning logged once
    - _Requirements: 2.9, 9.10_

  - [ ]* 9.5 Write JWKS endpoint tests
    - Supertest against a Nest app with `ClientAuthModule.register()`
    - When enabled: 200, `application/json`, public members only, no session. When unset or disabled: 404 identical to `/api/does-not-exist`. Empty `keys` when no context uses `private_key_jwt`
    - _Requirements: 8.12, 8.13, 8.14, 8.15, 13.7_

- [ ] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Wire the OIDC_Client through the framework
  - [ ] 11.1 Extract `strategies/oidc-msal-network-client.ts`
    - Leave GET unchanged
    - POST: parse the form body, delete `client_id` / `client_secret` / `client_assertion` / `client_assertion_type`, apply the existing `overrideTokenBodyScope` against the effective token URL, call `authenticator.send`, and return `{ status, headers, body }`
    - Map `TokenRequestError` to the synthetic 500 `{ error: 'token_request_failed', error_description: <category> }`; rethrow `ClientAuthContributionError`
    - _Requirements: 2.5, 3.2, 12.1, 12.2_

  - [ ] 11.2 Update `oidc.auth-strategy.service.ts` and the OIDC config
    - `buildMsalConfig`: placeholder `clientSecret` (`fcc-client-auth-framework-placeholder`) for every method, never `clientAssertion`, `authorityMetadata.token_endpoint = authenticator.tokenUrl`, use the extracted network client, remove the unsupported-method branch
    - Remove `private-key-jwt.ts` and its usages; inject `ClientAuthService` (import `ClientAuthModule.register()` in `AuthenticationModule` for the OIDC strategy)
    - _Requirements: 1.1, 1.2, 1.5, 2.5, 3.2, 12.1, 12.3, 12.4, 12.5_

  - [ ] 11.3 Return a fixed login failure response
    - In `AuthController.login`, replace `new UnauthorizedException(error)` with `new UnauthorizedException('Login failed')`, keeping status 401 and clearing the session. Leave the callback path unchanged
    - _Requirements: 11.5, 12.6_

  - [ ]* 11.4 Update OIDC strategy and controller tests
    - Update the existing `oidc.auth-strategy.service.spec.ts`: legacy regressions with the method unset and `client_secret` (form body, no `Authorization`), `getAuthCodeUrl` identical across methods, session tests parameterised by method, refresh failure handling unchanged
    - Controller tests: login and callback with an IdP error body neither echo the body nor create a session
    - _Requirements: 1.1, 1.2, 12.3, 12.4, 12.5, 12.6, 12.7, 13.2_

- [ ] 12. Wire the API_Auth_Client through the framework
  - [ ] 12.1 Update `OauthService` and `AuthenticationModule`
    - `GetTokenParams` becomes `{ tokenUri, clientId?, scope? }` (drop `clientSecret` and `contentType`)
    - `refreshToken` calls `clientAuthService.forContext('api').send(...)` with `grant_type: client_credentials` and `scope` only when defined
    - Non-2xx and transport failures throw `FluxnovaError('Error getting Oauth token from: <url> with client Id: <id>')` with no `cause`
    - `AuthenticationModule` imports `ClientAuthModule.register()` and stops passing the secret and content type
    - _Requirements: 1.3, 1.4, 2.5, 3.3, 11.1, 11.5_

  - [ ]* 12.2 Update `oauth.service.spec.ts` legacy regressions
    - With the method unset and `client_secret`: JSON body with `client_id`, `client_secret`, `grant_type`, `scope` when defined, and no `Authorization`. Errors carry no `cause`
    - _Requirements: 1.3, 1.4, 11.5, 13.2_

- [ ] 13. Cross-cutting framework tests
  - [ ]* 13.1 Write property test for token request shape
    - Drive OIDC cases through `OidcMsalNetworkClient` (MSAL-style body with placeholders) and API cases through `OauthService.refreshToken`, with a fake `TokenHttpClient`
    - **Property 1: Token request shape matches the method model**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 2.5, 3.2, 3.3, 3.4, 4.2, 5.1, 5.2, 5.4, 6.1, 6.2, 9.2, 12.1, 12.2**

  - [ ]* 13.2 Write the method × context matrix tests
    - `describe.each` over the 12 combinations, asserting presence or absence of `Authorization`, content type, `client_id`, `client_secret`, `client_assertion` and `client_assertion_type`
    - _Requirements: 13.1_

  - [ ]* 13.3 Write property test for credential confidentiality
    - **Property 17: Credentials never appear in logs or errors**
    - **Validates: Requirements 11.1, 11.2, 11.4**

  - [ ]* 13.4 Write certificate isolation tests
    - The OIDC userinfo GET agent, the `HttpService` agents and the other context's token agent carry no `cert` / `key`
    - _Requirements: 9.7_

- [ ] 14. Update documentation files
  - [ ] 14.1 Update `docs/reference/authentication.md` and `docs/reference/configuration.md`
    - In `authentication.md`: the six methods (credential placement, required/optional variables, contexts), the Legacy_Behaviour default and its wire differences, examples per method and context (PEM and JWKS variants), the four-step JWKS rotation with restart notes, the JWKS endpoint (path, enable flag, default disabled, anonymous, public-only), certificate renewal warnings and failures, and the startup error catalogue with fixes
    - In `configuration.md`: every variable with context, format, default, per-method requirement and `_FILE` counterpart
    - Placeholder values only
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.8, 14.9, 14.10_

  - [ ] 14.2 Update `deploy/podman/README.md` and `docs/guides/using-secrets-from-vault.md`
    - Supplying the Signing_Key, Private_JWKS, Client_Certificate, its key and the CA bundle via `_FILE`; state that setting both inline and `_FILE` stops startup
    - Placeholder values only
    - _Requirements: 14.7, 14.8_

- [ ] 15. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Each task references specific requirements for traceability; Requirement 13 is met by the test sub-tasks, so skipping them leaves 13.x unmet
- Property tests validate the 17 correctness properties from the design; unit and integration tests cover examples, edge cases, sockets and routing
- Open decisions from the design are implemented as currently specified (tasks 6.1, 9.3, 11.3)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "3.1", "4.1", "4.5", "8.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "3.2", "4.2", "4.6", "4.7", "4.10", "6.1", "8.2"] },
    { "id": 3, "tasks": ["3.3", "4.3", "4.8", "4.11", "6.2", "6.3", "7.1", "8.3", "8.4"] },
    { "id": 4, "tasks": ["4.4", "4.9", "4.12", "6.4", "6.6", "7.2", "9.1"] },
    { "id": 5, "tasks": ["4.13", "6.5", "9.2"] },
    { "id": 6, "tasks": ["9.3"] },
    { "id": 7, "tasks": ["9.4", "9.5", "11.1", "11.3", "12.1"] },
    { "id": 8, "tasks": ["11.2", "12.2"] },
    { "id": 9, "tasks": ["11.4", "13.1", "13.2", "13.3", "13.4", "14.1", "14.2"] }
  ]
}
```
