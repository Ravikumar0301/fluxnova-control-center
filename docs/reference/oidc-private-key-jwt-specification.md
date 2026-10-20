# OIDC `private_key_jwt` Specification

**Status:** Decisions recorded; implementation has not started.

## Goal and scope

Add `FXN_OIDC_CLIENT_AUTH_METHOD=private_key_jwt` as an OIDC client-authentication option while preserving the current `client_secret` behavior as the backward-compatible default. Keep `FXN_AUTH_STRATEGY=none` unchanged. For private-key mode, require the OIDC client ID, use a Control Center-held private key to sign assertions, and do not require, configure, or fall back to the client secret.

This is distinct from `FXN_API_AUTH_*`, which configures app-level authentication on Fluxnova Engine HTTP requests in `apps/server/src/auth/authentication.module.ts`. Do not change that behavior.

## Repository-verified findings

### Existing provider flow and MSAL usage

- `package.json` declares `@azure/msal-node` as `^3.8.1`; installed/locked version is 3.8.7. The service configures `ProtocolMode.OIDC` and explicit authorization endpoint, token endpoint, issuer, and userinfo metadata in `apps/server/src/auth/strategies/oidc.auth-strategy.service.ts` (lines 48–61).
- The SSO route calls `getAuthCodeUrl` (same file, lines 159–171). The callback exchanges the code using `acquireTokenByCode` (lines 129–138). Session creation, token storage, and redirect handling are in that service and `apps/server/src/auth/auth.controller.ts` (lines 76–91). Return-path validation is in `apps/server/src/context/request.ts`.
- `docs/guides/local-oidc-setup.md` describes the local Keycloak OIDC stack. `docker/docker-compose-keycloak.yml` configures browser authorization and container token/userinfo endpoints plus the token issuer (lines 58–66). The exported local client has standard flow enabled and is confidential, but does not configure signed-JWT client authentication or an imported client signing certificate.
- These facts verify the intended external-OIDC endpoint wiring, not a live Keycloak token exchange. The colocated OIDC strategy tests mock MSAL; no Keycloak interoperability test has been run as part of this specification work.
- Current validation in `apps/server/src/config/validator.ts` requires client ID and secret only for `FXN_AUTH_STRATEGY=oidc`. `apps/server/src/config/oidc.config.ts` maps both into the OIDC config; `oidc.auth-strategy.service.ts` passes both to MSAL. The service also retains an existing username/password login path (`userCredentialsLogin`, lines 210–220).

### Assertion support and interoperability evidence

MSAL 3.8.7 accepts a caller-provided `clientAssertion` callback and uses its result in authorization-code token requests with `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer` (`node_modules/@azure/msal-common/src/client/AuthorizationCodeClient.ts`, lines 378–394). It calls the callback with client ID and the request's token endpoint URI. This verifies MSAL request construction, but does not alone prove Keycloak compatibility.

MSAL's built-in certificate signer uses `PS256` plus `x5t#S256` with a SHA-256 thumbprint, or deprecated SHA-1 thumbprint mode using `RS256` plus `x5t`. It sets `iss` and `sub` to the client ID, `aud` to the token endpoint, `iat`, `nbf`, `jti`, and a ten-minute `exp` (`node_modules/@azure/msal-node/src/client/ClientAssertion.ts`, lines 126–169). The built-in signer is not selected for this design because its algorithm and ten-minute lifetime do not match the initial RS256/60-second project settings without further Keycloak policy changes.

Official MSAL Node documentation describes external OIDC authorities with `protocolMode: "OIDC"` and documents its certificate/client assertion options in the Microsoft identity platform context. It does not certify interoperability with the deployed Keycloak version. Keycloak's [Server Administration Guide](https://www.keycloak.org/docs/latest/server_admin/index.html) documents a signed-JWT client authenticator that can validate an imported certificate and configure signature algorithm and maximum assertion age. Its current guide describes 60 seconds as the default maximum age. The guide and repository compose both use moving/current versions; the supported deployment version and exact settings must be verified during implementation.

The existing direct dependency `jsonwebtoken` (`^9.0.0`; installed 9.0.3) can create JWTs from PEM private keys with an explicitly selected algorithm. Its broader supported-algorithm list must not become an algorithm negotiation mechanism. A maintained generic alternative is `openid-client` v6, whose official documentation provides `PrivateKeyJwt`, authorization-code grant, discovery, and refresh APIs. Adopting it would be a larger service adaptation and would require validating the existing session/token-refresh behavior. The recommended initial approach is to retain MSAL and supply the assertion callback, contingent on the Keycloak integration test below. Avoid a raw Axios implementation of the OAuth protocol.

## Confirmed design decisions

1. **Method and backwards compatibility:** Add `FXN_OIDC_CLIENT_AUTH_METHOD` with `client_secret` (default) and `private_key_jwt`. Keep `FXN_AUTH_STRATEGY=none` unchanged. For either OIDC method, require the client ID. In private-key mode, do not require, configure, or fall back to `FXN_OIDC_CLIENT_SECRET`.
2. **Private-key input:** Supply PEM private-key material via a protected runtime environment variable, proposed name `FXN_OIDC_PRIVATE_KEY`. Accept normal PEM line breaks; normalize CRLF to LF and support escaped `\\n` sequences from environment injectors. Validate the PEM/key at server startup and fail with a generic configuration error that names the variable but never includes key contents. Require an RSA private key appropriate for RS256. Do not log or return the key to the frontend. Do not commit a real credential or private key. Deploy the value through a secret manager or protected runtime environment; do not document or recommend a checked-in `.env` file for deployed use.
3. **Keycloak registration:** For the initial implementation, import the certificate containing the public key corresponding to the Control Center private key into the Keycloak client's key configuration and select Keycloak's signed-JWT client authenticator. Configure it to accept RS256. JWKS-based public-key registration is future work and out of scope. Provide operator setup guidance with the implementation, once the supported Keycloak version and its UI/API naming are verified.
4. **Configurable algorithm:** Add `FXN_OIDC_PRIVATE_KEY_JWT_ALGORITHM`, independent of `FXN_AUTH_STRATEGY` and `FXN_OIDC_CLIENT_AUTH_METHOD`. Default it to `RS256`. Validate it against an explicit allowlist of asymmetric algorithms that have been verified with the supported private-key format, imported certificate, and deployed Keycloak version. For the initial implementation, the allowlist is only `RS256`; later algorithms may be added after compatibility tests. Explicitly pass the selected algorithm to signing and validate that it is compatible with the RSA private key and matching imported public certificate. Do not allow `none`, HMAC, arbitrary values, algorithm negotiation, or silent fallback. Fail startup with a clear configuration error when the configured algorithm is unsupported or incompatible.
5. **Assertion claims and freshness:** For every applicable token request, generate a fresh assertion with `iss` and `sub` equal to the client ID; `aud` equal to the actual token endpoint used for that request; `iat`; `exp`; and a unique `jti`. The initial project target is a 60-second expiration window. This is a project decision, not a universal industry standard; confirm it is accepted by the supported Keycloak version's maximum assertion age and clock-skew configuration. Do not use MSAL's ten-minute built-in certificate assertion for this design.
6. **Login flows:** Preserve the existing local username/password login for development; do not remove or redesign it as part of this credential change. Production guidance uses the existing SSO authorization-code flow with private-key client authentication for the code exchange and refresh requests when the provider requires client authentication. The method selection configures MSAL globally, so private-key mode may also affect the username/password token request; whether Keycloak supports that grant with this client authenticator remains unresolved. Do not make production depend on the username/password flow.
7. **Security behavior:** This is a server-side credential change only. Preserve the browser redirect and callback flow, callback return-path validation, CSRF middleware, session-cookie settings/lifetime, token refresh/storage behavior, and existing token/error redaction. Do not return assertions, private keys, or token endpoint credentials to the frontend or logs. Leave engine-side authorization and `FXN_API_AUTH_*` behavior unchanged.

## Configuration and validation requirements

Validation remains conditional on `FXN_AUTH_STRATEGY=oidc`; `none` must continue to start without OIDC client credentials. When OIDC is enabled:

- Accept only `client_secret` or `private_key_jwt`; default a missing method to `client_secret` for existing deployments.
- Require the OIDC client ID for either method.
- Require the client secret only for `client_secret` mode.
- Require `FXN_OIDC_PRIVATE_KEY` only for `private_key_jwt` mode. Parse and validate its PEM and key type at startup; reject malformed or unsupported key material without printing the secret. Verify the configured algorithm is in the explicit supported allowlist and compatible with the key type; reject unsupported or mismatched combinations with a clear error and no fallback. Verify that the imported Keycloak certificate corresponds to the configured private key during deployment setup/integration testing.
- Read `FXN_OIDC_PRIVATE_KEY_JWT_ALGORITHM` independently of auth-strategy and client-auth-method configuration. When private-key JWT is in use, default it to `RS256` and accept only the initial allowlist (`RS256`). Reject unsupported values at startup. Do not treat the broad algorithm list of `jsonwebtoken` as the application's supported allowlist.
- Apply algorithm allowlist and key-compatibility validation when `private_key_jwt` is selected. The algorithm setting must not change `FXN_AUTH_STRATEGY` or select/change `FXN_OIDC_CLIENT_AUTH_METHOD`; `none` and `client_secret` retain their current behavior.
- Keep the existing required authority, authorization URL, issuer, token URL, userinfo URL, and related OIDC validation.
- In private-key mode, ensure the MSAL configuration contains the caller assertion and does not contain `clientSecret`, even when the secret environment variable happens to be set.
- Do not add key material to the public frontend runtime configuration or any API response.

Update the OIDC config type in `libs/types/src/configuration/oidc.config.ts` and document the new settings in `docs/reference/configuration.md` when implementing. No dependency addition is currently required by the proposed design.

## Implementation test plan

Update/add colocated tests in:

- `apps/server/src/config/oidc.config.spec.ts`: default method, explicit method, private-key environment mapping/newline normalization, algorithm default, and explicitly configured algorithm mapping.
- `apps/server/src/config/validator.spec.ts`: backward-compatible secret mode; private-key mode without a secret; missing client ID/key; invalid method; malformed/non-RSA key; default RS256; explicitly configured supported algorithms; unsupported algorithms; key/algorithm incompatibility; and unchanged `none` behavior.
- `apps/server/src/auth/strategies/oidc.auth-strategy.service.spec.ts`: correct method-specific MSAL config, no secret in private-key mode, callback inputs, selected algorithm in the assertion header, required claims, 60-second target, fresh unique `jti`/assertion per token request, and behavior for authorization-code and refresh requests. Verify the default and each explicitly supported algorithm (initially `RS256`), and assert unsupported or key-incompatible algorithms fail without fallback. Preserve and test the local username/password path according to the final Keycloak grant decision.
- Add a real authorization-code integration test against the supported Keycloak version and a client configured with the imported matching certificate. Verify successful browser login and token exchange; assertion `iss`, `sub`, `aud`, `iat`, `exp`, `jti`, and configured `alg`; that the algorithm matches the imported certificate and Keycloak policy; no `client_secret` in private-key mode; and preservation of callback validation, session creation, CSRF, token handling, and existing secret-mode behavior. A mocked MSAL unit test alone is not proof of Keycloak interoperability.

## Remaining blockers and deployment questions

The following decisions are set, but their deployment-specific implementation details remain blockers for final rollout:

1. **Key provisioning and rotation:** The source is the `FXN_OIDC_PRIVATE_KEY` environment variable. Each deployment must decide how its secret manager injects it, how the matching certificate is issued/imported, and how key/certificate rotation is coordinated. Never place actual key material in repository files or test fixtures.
2. **Keycloak version and certificate selection:** Confirm the supported Keycloak version, the exact client authenticator and certificate-import UI/API path, and how that version identifies the certificate for verification (including whether any assertion JOSE header such as `kid`, `x5t`, or `x5c` is required). The initial design uses an imported certificate; JWKS is future work.
3. **Algorithm compatibility:** The variable and initial RS256-only allowlist are decided. Confirm the supported Keycloak version accepts RS256 for signed client assertions using the selected imported-certificate configuration, and confirm the private key and certificate are a compatible pair. Additional algorithms remain out of scope until separately verified and explicitly allowlisted.
4. **Assertion age and clock skew:** 60 seconds is the chosen initial target. Confirm Keycloak's configured maximum assertion age and acceptable clock skew, and keep the assertion lifetime within those values.
5. **Username/password grant:** Preserve the existing development path, but confirm whether Keycloak's direct-access-grant path supports `private_key_jwt` for the deployed version. Production SSO uses authorization-code flow; this uncertainty must not cause removal or redesign of local development login.
6. **Interoperability evidence:** During implementation, execute the real Keycloak authorization-code integration test described above against the supported version/configuration before claiming provider compatibility.

## Approval readiness

The method selection and default, environment-backed PEM key source, imported-certificate Keycloak setup, configurable algorithm variable with an initial `RS256`-only allowlist, assertion claims, 60-second initial target, local-versus-production flow policy, and required integration test are confirmed design decisions. The remaining items above are deployment verification blockers, not open design alternatives. This specification is **ready for implementation approval**, with the explicit requirement that the Keycloak version, imported-certificate details, algorithm/key compatibility, assertion age/clock skew, and end-to-end interoperability be verified during implementation before rollout. No feature implementation has been made.
