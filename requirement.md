# Requirements Document

## Introduction

Fluxnova Control Center (FCC) makes outbound OAuth 2.0 token requests in two places, and each authenticates itself to the token endpoint in its own way:

1. **OIDC login client** (`apps/server/src/auth/strategies/oidc.auth-strategy.service.ts`, config in `apps/server/src/config/oidc.config.ts`). It uses `@azure/msal-node` `ConfidentialClientApplication` with a custom axios network client. `FXN_OIDC_CLIENT_AUTH_METHOD` already accepts:
   - `client_secret` (the default): MSAL sends `client_id` and `client_secret` in the form body. That is the `client_secret_post` wire format.
   - `private_key_jwt`: an RS256 assertion signed with a PEM key from `FXN_OIDC_PRIVATE_KEY`. It has `iss`/`sub` = client ID, `aud` = token URL, a unique `jti`, a 60-second lifetime, and an optional `kid` from `FXN_OIDC_KEY_ID`.
2. **API auth client** (`apps/server/src/auth/oauth.service.ts`, `authentication.module.ts`, config in `apps/server/src/config/api-auth.config.ts`). It runs the `client_credentials` grant to get a token, which it attaches to outbound Fluxnova API requests. Today it always sends `client_id` and `client_secret` in a JSON request body. This client has no method selection and no support for key-based or certificate-based authentication.

Validation lives in `apps/server/src/config/validator.ts`, and the config types live in `libs/types/src/configuration/`.

**Correction to the feature brief:** the brief describes the existing behaviour as `client_secret_basic`. In the code, neither client uses HTTP Basic. The OIDC client sends the secret in the form body, and the API auth client sends it in a JSON body. To keep existing deployments working without changes, the current wire formats have to stay the defaults. `client_secret_basic` becomes a new, opt-in method.

This feature adds a single pluggable client authentication framework that both clients share. It supports `client_secret_basic`, `client_secret_post`, `private_key_jwt`, mutual-TLS client authentication (`tls_client_auth` and `self_signed_tls_client_auth`, per RFC 8705), and JWKS-backed key management for signed client assertions. The method is selected through configuration. User-facing login flows (authorization code with PKCE, username/password, refresh) stay the same.

Out of scope: vendor-specific IdP integrations, organisation-specific security implementations, custom deployment workarounds (sidecars, proxies, forks), and changes to user-facing authentication flows.

## Glossary

- **FCC_Server**: The Fluxnova Control Center NestJS server application (`apps/server`).
- **OIDC_Client**: The FCC_Server component that requests tokens from the OIDC provider's token endpoint during user login and token refresh (configured by `FXN_OIDC_*` variables).
- **API_Auth_Client**: The FCC_Server component that obtains `client_credentials` access tokens for outbound Fluxnova API requests (configured by `FXN_API_AUTH_*` variables).
- **Client_Context**: Either the OIDC_Client or the API_Auth_Client; each Client_Context has an independent client authentication configuration.
- **Enabled Client_Context**: A Client_Context is enabled as follows. The OIDC_Client is enabled when `FXN_AUTH_STRATEGY` selects OIDC. The API_Auth_Client is enabled when `FXN_API_AUTH_ENABLED` is `true`.
- **Client_Auth_Framework**: The shared, pluggable FCC_Server component that applies the configured client authentication method to a token request for a Client_Context.
- **Client_Auth_Method**: The configured client authentication mechanism for a Client_Context. Valid values: `client_secret` (legacy alias), `client_secret_basic`, `client_secret_post`, `private_key_jwt`, `tls_client_auth`, `self_signed_tls_client_auth`. The OIDC_Client method is set by `FXN_OIDC_CLIENT_AUTH_METHOD`. The API_Auth_Client method is set by `FXN_API_AUTH_CLIENT_AUTH_METHOD`.
- **Legacy_Behaviour**: The token-request wire format each Client_Context uses today. For the OIDC_Client, `client_id` and `client_secret` go in the form-encoded body. For the API_Auth_Client, `client_id` and `client_secret` go in a JSON body.
- **Config_Validator**: The FCC_Server startup validation of environment configuration (`apps/server/src/config/validator.ts`).
- **Token_Request**: An HTTP POST from a Client_Context to an OAuth 2.0 token endpoint.
- **Client_Assertion**: A signed JWT that a Client_Context sends as `client_assertion` with `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer` under `private_key_jwt`.
- **Signing_Key**: The private key that signs a Client_Assertion, supplied either as a PEM-encoded key or as a JWK.
- **Private_JWKS**: A configured JSON Web Key Set (RFC 7517) containing one or more private Signing_Keys, each identified by a `kid`.
- **Active_Key**: The Signing_Key selected from the Private_JWKS (or the single PEM Signing_Key) to sign new Client_Assertions.
- **Public_JWKS**: The JSON Web Key Set containing only the public parameters of the configured Signing_Keys.
- **JWKS_Endpoint**: An optional FCC_Server HTTP endpoint that serves the Public_JWKS so an identity provider can fetch the client's public keys.
- **Client_Certificate**: The X.509 certificate and matching private key that a Client_Context presents during the TLS handshake with the token endpoint under `tls_client_auth` or `self_signed_tls_client_auth`.
- **Key_Material_Source**: How a key, certificate, JWKS or secret is supplied: as an inline environment variable value or as a file path the FCC_Server reads at startup.
- **Supported_Signing_Algorithm**: One of `RS256`, `PS256` or `ES256`.

## Requirements

### Requirement 1: Backwards compatibility for existing deployments

**User Story:** As an operator of an existing Fluxnova Control Center deployment, I want my current configuration to keep working after upgrading, so that I do not have to change anything to adopt the new release.

#### Acceptance Criteria

1. WHILE `FXN_OIDC_CLIENT_AUTH_METHOD` is absent from the environment, THE OIDC_Client SHALL send each Token_Request using the OIDC_Client Legacy_Behaviour: an `application/x-www-form-urlencoded` body containing `client_id` set to `FXN_OIDC_CLIENT_ID` and `client_secret` set to `FXN_OIDC_CLIENT_SECRET`, no `Authorization` header, and no `client_assertion` or `client_assertion_type` parameters.
2. WHILE `FXN_OIDC_CLIENT_AUTH_METHOD` is `client_secret`, THE OIDC_Client SHALL send each Token_Request using the OIDC_Client Legacy_Behaviour as defined in criterion 1, with the same headers and body parameters as when `FXN_OIDC_CLIENT_AUTH_METHOD` is absent.
3. WHILE the API_Auth_Client Client_Auth_Method variable is absent from the environment, THE API_Auth_Client SHALL send each Token_Request using the API_Auth_Client Legacy_Behaviour: a `Content-Type: application/json` request whose JSON body contains `client_id` set to `FXN_API_AUTH_CLIENT_ID`, `client_secret` set to `FXN_API_AUTH_CLIENT_SECRET`, `grant_type` set to `client_credentials` and the configured `scope`, with no `Authorization` header and no `client_assertion` or `client_assertion_type` parameters, sent to `FXN_API_AUTH_TOKEN_URL`.
4. WHILE the API_Auth_Client Client_Auth_Method is `client_secret`, THE API_Auth_Client SHALL send each Token_Request using the API_Auth_Client Legacy_Behaviour as defined in criterion 3, with the same headers and body parameters as when the API_Auth_Client Client_Auth_Method variable is absent.
5. WHILE the OIDC_Client Client_Auth_Method is `private_key_jwt` and no Signing_Key, Private_JWKS, certificate, thumbprint or audience override variables introduced by this feature are set, THE OIDC_Client SHALL produce each Client_Assertion signed with the key from `FXN_OIDC_PRIVATE_KEY`, with header `alg`=`RS256`, header `kid` equal to `FXN_OIDC_KEY_ID` if and only if `FXN_OIDC_KEY_ID` is set, no `x5t` or `x5t#S256` header, and exactly the claims `iss` and `sub` equal to `FXN_OIDC_CLIENT_ID`, `aud` equal to the OIDC token endpoint URL, `iat`, `exp` equal to `iat` plus 60 seconds, and a unique `jti`.
6. WHEN the FCC_Server starts with an environment configuration that the current release accepts and none of the variables introduced by this feature are set, THE Config_Validator SHALL complete validation without error and THE FCC_Server SHALL start without requiring any additional environment variable.
7. IF the Client_Auth_Method of an enabled Client_Context is absent or `client_secret` and that Client_Context's client secret variable (`FXN_OIDC_CLIENT_SECRET` for the OIDC_Client, `FXN_API_AUTH_CLIENT_SECRET` for the API_Auth_Client) is absent or empty, THEN THE Config_Validator SHALL stop FCC_Server startup with an error that names the missing variable, matching the rejection behaviour of the current release.
8. THE FCC_Server SHALL keep the existing environment variable names with their current meaning: `FXN_OIDC_CLIENT_AUTH_METHOD` (OIDC_Client Client_Auth_Method, default `client_secret`), `FXN_OIDC_CLIENT_SECRET` (OIDC_Client client secret), `FXN_OIDC_PRIVATE_KEY` (inline PEM Signing_Key for the OIDC_Client, with literal `\n` sequences and `\r\n` line endings normalised to `\n`), `FXN_OIDC_PRIVATE_KEY_JWT_ALGORITHM` (OIDC_Client signing algorithm, default `RS256`), `FXN_OIDC_KEY_ID` (OIDC_Client Client_Assertion `kid`), `FXN_API_AUTH_CLIENT_ID` (API_Auth_Client client identifier), `FXN_API_AUTH_CLIENT_SECRET` (API_Auth_Client client secret) and `FXN_API_AUTH_TOKEN_URL` (API_Auth_Client token endpoint URL).

### Requirement 2: Configurable client authentication method per Client_Context

**User Story:** As an operator, I want to choose the client authentication method separately for the OIDC login client and the API auth client, so that each integration can meet its identity provider's requirements.

#### Acceptance Criteria

1. WHEN the FCC_Server starts, THE FCC_Server SHALL read the OIDC_Client Client_Auth_Method from `FXN_OIDC_CLIENT_AUTH_METHOD`, after removing leading and trailing whitespace.
2. WHEN the FCC_Server starts, THE FCC_Server SHALL read the API_Auth_Client Client_Auth_Method from `FXN_API_AUTH_CLIENT_AUTH_METHOD`, after removing leading and trailing whitespace.
3. IF the Client_Auth_Method variable of a Client_Context is unset, or is empty after whitespace removal, THEN THE FCC_Server SHALL resolve the Client_Auth_Method of that Client_Context to `client_secret` (Legacy_Behaviour).
4. THE FCC_Server SHALL treat Client_Auth_Method values as case-sensitive and accept only the exact lowercase valid Client_Auth_Method values listed in the Glossary.
5. THE Client_Auth_Framework SHALL apply the resolved Client_Auth_Method of a Client_Context to every Token_Request that Client_Context sends, for the whole time the FCC_Server process runs. The OIDC_Client Token_Requests in scope are the authorization code exchange, the refresh token exchange and the username/password exchange. The API_Auth_Client Token_Requests in scope are `client_credentials` requests.
6. THE Client_Auth_Framework SHALL resolve the OIDC_Client Client_Auth_Method only from `FXN_OIDC_CLIENT_AUTH_METHOD` and the API_Auth_Client Client_Auth_Method only from `FXN_API_AUTH_CLIENT_AUTH_METHOD`. Setting, changing or removing one variable SHALL NOT change the resolved Client_Auth_Method of the other Client_Context.
7. IF the Client_Context is enabled and its Client_Auth_Method value, after whitespace removal, is non-empty and is not one of the valid Client_Auth_Method values, THEN THE Config_Validator SHALL stop FCC_Server startup before any Token_Request is sent. The error SHALL name the offending variable and list all six valid Client_Auth_Method values. The OIDC_Client is enabled when `FXN_AUTH_STRATEGY` selects OIDC. The API_Auth_Client is enabled when `FXN_API_AUTH_ENABLED` is `true`.
8. WHILE a Client_Context is not enabled, THE Config_Validator SHALL NOT reject FCC_Server startup because of the value of that Client_Context's Client_Auth_Method variable.
9. WHEN the FCC_Server completes startup configuration validation, THE FCC_Server SHALL write exactly one log entry per enabled Client_Context, before that Client_Context sends its first Token_Request. Each entry SHALL state the Client_Context name and its resolved Client_Auth_Method. It SHALL say whether the method came from the default or from the variable. It SHALL exclude client secret, Signing_Key, Client_Certificate, private key and passphrase content.

### Requirement 3: Pluggable client authentication framework

**User Story:** As a Fluxnova maintainer, I want client authentication methods implemented behind one shared interface, so that new standards-based methods can be added without changing the OIDC or API auth clients.

#### Acceptance Criteria

1. THE Client_Auth_Framework SHALL expose a single interface through which each Client_Auth_Method contributes zero or more request headers, zero or more request body parameters and zero or more TLS client options (client certificate, client private key, private key passphrase and CA bundle) to a Token_Request, so that adding a new Client_Auth_Method requires no change to the OIDC_Client or the API_Auth_Client.
2. THE OIDC_Client SHALL obtain the client authentication headers, body parameters and TLS client options for every Token_Request (authorization code exchange, refresh token exchange and username/password token exchange) exclusively through the Client_Auth_Framework, and SHALL add no client credential to a Token_Request outside the Client_Auth_Framework.
3. THE API_Auth_Client SHALL obtain the client authentication headers, body parameters and TLS client options for every `client_credentials` Token_Request exclusively through the Client_Auth_Framework, and SHALL add no client credential to a Token_Request outside the Client_Auth_Framework.
4. THE Client_Auth_Framework SHALL include exactly one of the following client credential mechanisms in each Token_Request, as required by RFC 6749 section 2.3: an HTTP Basic `Authorization` header (`client_secret_basic`), a `client_secret` body parameter (`client_secret`, `client_secret_post`), a `client_assertion` body parameter (`private_key_jwt`), or a Client_Certificate presented in the TLS handshake (`tls_client_auth`, `self_signed_tls_client_auth`); a `client_id` body parameter sent alongside the selected mechanism SHALL NOT count as a second credential mechanism.
5. WHILE `http_proxy` or `HTTP_PROXY` is set to a non-empty value, THE Client_Auth_Framework SHALL route every Token_Request through the configured proxy under every Client_Auth_Method, using the `http_proxy` value when both variables are set, matching the current OIDC_Client and API_Auth_Client behaviour.
6. WHILE neither `http_proxy` nor `HTTP_PROXY` is set to a non-empty value, THE Client_Auth_Framework SHALL send every Token_Request directly to the token endpoint without a proxy under every Client_Auth_Method.
7. IF a Client_Auth_Method fails to produce its client authentication contribution for a Token_Request (for example, Client_Assertion signing fails), THEN THE Client_Auth_Framework SHALL abort that Token_Request without sending it, and SHALL return an error to the calling Client_Context that identifies the Client_Context and the Client_Auth_Method, excluding credential values.

### Requirement 4: client_secret_basic

**User Story:** As an operator whose identity provider requires HTTP Basic client authentication, I want to select `client_secret_basic`, so that FCC authenticates the way the provider expects.

#### Acceptance Criteria

1. WHILE the Client_Auth_Method of a Client_Context is `client_secret_basic`, THE Client_Auth_Framework SHALL send exactly one `Authorization` header of the form `Basic base64(urlencode(client_id) ":" urlencode(client_secret))` on each Token_Request, where `urlencode` is the `application/x-www-form-urlencoded` encoding of the UTF-8 bytes defined in RFC 6749 Appendix B and `base64` is the standard base64 alphabet with `=` padding (RFC 4648 section 4), as defined in RFC 6749 section 2.3.1.
2. WHILE the Client_Auth_Method of a Client_Context is `client_secret_basic`, THE Client_Auth_Framework SHALL send the Token_Request body as `application/x-www-form-urlencoded` for both the OIDC_Client and the API_Auth_Client, containing the grant parameters of the request and omitting the `client_id`, `client_secret`, `client_assertion` and `client_assertion_type` parameters.
3. FOR ALL client identifiers and client secrets of 1 to 1024 Unicode characters, including space, `:`, `%`, `+`, `=`, `/` and non-ASCII characters, base64-decoding the `Authorization` header credentials produced under `client_secret_basic`, splitting at the first `:` and form-url-decoding each part SHALL yield the original client identifier and client secret (round-trip property).
4. IF the Client_Auth_Method of an enabled Client_Context is `client_secret_basic` and the client secret for that Client_Context is unset or a zero-length string, THEN THE Config_Validator SHALL stop FCC_Server startup before any Token_Request is sent, with an error that names the missing variable (`FXN_OIDC_CLIENT_SECRET` for the OIDC_Client, `FXN_API_AUTH_CLIENT_SECRET` for the API_Auth_Client) and excludes any secret value.
5. IF the Client_Auth_Method of an enabled Client_Context is `client_secret_basic` and the client identifier for that Client_Context is unset or a zero-length string, THEN THE Config_Validator SHALL stop FCC_Server startup before any Token_Request is sent, with an error that names the missing client identifier variable (`FXN_API_AUTH_CLIENT_ID` for the API_Auth_Client).
6. IF the token endpoint rejects a Token_Request sent under `client_secret_basic`, THEN THE Client_Auth_Framework SHALL return the failure to the calling Client_Context without resending the Token_Request under any other Client_Auth_Method.

### Requirement 5: client_secret_post

**User Story:** As an operator, I want to select `client_secret_post` explicitly, so that FCC sends credentials as form parameters in the token request body to match RFC 6749.

#### Acceptance Criteria

1. WHILE the Client_Auth_Method of a Client_Context is `client_secret_post`, THE Client_Auth_Framework SHALL send each Token_Request for that Client_Context with a `Content-Type` header of `application/x-www-form-urlencoded` and a form-encoded body containing the `client_id` parameter exactly once and the `client_secret` parameter exactly once, as defined in RFC 6749 section 2.3.1. For the API_Auth_Client, this form-encoded body SHALL replace the JSON body used by the API_Auth_Client Legacy_Behaviour.
2. WHILE the Client_Auth_Method of a Client_Context is `client_secret_post`, THE Client_Auth_Framework SHALL omit the `Authorization` header, the `client_assertion` parameter and the `client_assertion_type` parameter from the Token_Request.
3. IF the Client_Auth_Method of an enabled Client_Context is `client_secret_post` and the client secret for that Client_Context is unset, empty or whitespace-only, THEN THE Config_Validator SHALL stop FCC_Server startup with an error that names the missing variable (`FXN_OIDC_CLIENT_SECRET` for the OIDC_Client, `FXN_API_AUTH_CLIENT_SECRET` for the API_Auth_Client), excluding any secret content.
4. WHILE the Client_Auth_Method of a Client_Context is `client_secret_post`, THE Client_Auth_Framework SHALL include in the same form-encoded Token_Request body every grant parameter that the Client_Context sends under Legacy_Behaviour for the same grant (including `grant_type` and, where applicable, `code`, `code_verifier`, `redirect_uri`, `refresh_token`, `username`, `password` and `scope`), with unchanged values.
5. FOR ALL client identifiers and client secrets of 1 to 1024 printable characters, including the reserved characters `&`, `=`, `+`, `%`, `:` and space, form-decoding the Token_Request body produced under `client_secret_post` SHALL yield the original `client_id` and `client_secret` values (round-trip property).
6. IF the Client_Auth_Method of an enabled Client_Context is `client_secret_post` and the client identifier for that Client_Context is unset, empty or whitespace-only, THEN THE Config_Validator SHALL stop FCC_Server startup with an error that names the missing client identifier variable.

### Requirement 6: private_key_jwt for both Client_Contexts

**User Story:** As an operator whose identity provider requires signed client assertions, I want to use `private_key_jwt` for both the OIDC login client and the API auth client, so that no shared secret is needed.

#### Acceptance Criteria

1. WHILE the Client_Auth_Method of a Client_Context is `private_key_jwt`, WHEN the Client_Context sends a Token_Request (including any retry of a failed Token_Request), THE Client_Auth_Framework SHALL include `client_id`, `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer` and a Client_Assertion signed for that individual Token_Request as `application/x-www-form-urlencoded` body parameters, so that no Client_Assertion is sent in more than one Token_Request.
2. WHILE the Client_Auth_Method of a Client_Context is `private_key_jwt`, THE Client_Auth_Framework SHALL omit the `client_secret` body parameter and the `Authorization` header from every Token_Request of that Client_Context, even when a client secret variable is also configured for that Client_Context.
3. WHILE the Client_Auth_Method of a Client_Context is `private_key_jwt`, THE Client_Auth_Framework SHALL set both the Client_Assertion `iss` claim and the Client_Assertion `sub` claim to a value identical to the configured client identifier of that Client_Context.
4. WHILE the Client_Auth_Method of a Client_Context is `private_key_jwt` and no Client_Assertion audience override is configured for that Client_Context, THE Client_Auth_Framework SHALL set the Client_Assertion `aud` claim to a single string identical to the token endpoint URL to which that Token_Request is sent.
5. WHERE a non-empty Client_Assertion audience override is configured for a Client_Context, THE Client_Auth_Framework SHALL set the Client_Assertion `aud` claim to a single string identical to the configured audience value, replacing the token endpoint URL.
6. WHILE the Client_Auth_Method of a Client_Context is `private_key_jwt`, THE Client_Auth_Framework SHALL set the Client_Assertion `iat` claim to the FCC_Server system time at signing, in whole seconds since the Unix epoch, and the `exp` claim to exactly `iat` + 60.
7. FOR ALL pairs of Client_Assertions generated by the Client_Auth_Framework, including pairs generated in the same second, by different Client_Contexts, or before and after an FCC_Server restart, the `jti` claims SHALL be non-empty strings that differ from each other (uniqueness property).
8. WHILE the Client_Auth_Method of a Client_Context is `private_key_jwt`, THE Client_Auth_Framework SHALL sign each Client_Assertion with the Active_Key of that Client_Context using the configured Supported_Signing_Algorithm, defaulting to `RS256` when no signing algorithm is configured, and SHALL set the Client_Assertion `alg` header to the algorithm used.
9. FOR ALL Client_Assertions generated by the Client_Auth_Framework, verifying the Client_Assertion signature with the public key of the Active_Key and the algorithm in the `alg` header SHALL succeed, and the verified `iss`, `sub`, `aud`, `iat`, `exp` and `jti` claims SHALL equal the claims set at signing (round-trip property).
10. WHERE a `kid` is configured for the Active_Key, THE Client_Auth_Framework SHALL include a `kid` header with a value identical to the configured `kid` in the Client_Assertion; WHERE no `kid` is configured for the Active_Key, THE Client_Auth_Framework SHALL omit the `kid` header.
11. WHERE an X.509 certificate is configured for the Active_Key, THE Client_Auth_Framework SHALL include in the Client_Assertion an `x5t#S256` header whose value is the unpadded base64url encoding of the SHA-256 digest of the DER-encoded certificate.
12. WHERE an X.509 certificate is configured for the Active_Key and inclusion of the SHA-1 thumbprint is enabled, THE Client_Auth_Framework SHALL include in the Client_Assertion an `x5t` header whose value is the unpadded base64url encoding of the SHA-1 digest of the DER-encoded certificate; THE Client_Auth_Framework SHALL keep SHA-1 thumbprint inclusion disabled by default and omit the `x5t` header while it is disabled.
13. IF the Client_Auth_Method of an enabled Client_Context is `private_key_jwt` and the client identifier of that Client_Context is empty, THEN THE Config_Validator SHALL stop FCC_Server startup with an error that names the missing client identifier variable.
14. IF a Client_Assertion audience override is configured for a Client_Context and its value is empty or whitespace-only, THEN THE Config_Validator SHALL stop FCC_Server startup with an error that names the audience override variable.
15. IF signing a Client_Assertion fails at runtime, THEN THE Client_Auth_Framework SHALL not send the Token_Request, SHALL return an error to the calling Client_Context indicating that client assertion signing failed, and SHALL leave any previously obtained tokens and sessions of that Client_Context unchanged.

### Requirement 7: Signing key and algorithm validation

**User Story:** As an operator, I want misconfigured signing keys rejected at startup, so that authentication failures surface immediately rather than at the first login or API call.

#### Acceptance Criteria

1. IF the Client_Auth_Method of an enabled Client_Context is `private_key_jwt` and no Signing_Key is configured for that Client_Context (no PEM Signing_Key and no Private_JWKS, through any Key_Material_Source, where an empty or whitespace-only value counts as not configured), THEN THE Config_Validator SHALL stop FCC_Server startup before the FCC_Server accepts HTTP requests, with an error that names the Client_Context and the missing variable.
2. IF the signing algorithm configured for a Client_Context whose Client_Auth_Method is `private_key_jwt` is not a Supported_Signing_Algorithm (exact, case-sensitive match against `RS256`, `PS256` or `ES256`), THEN THE Config_Validator SHALL stop FCC_Server startup before the FCC_Server accepts HTTP requests, with an error that names the Client_Context, names the algorithm variable and lists the Supported_Signing_Algorithms.
3. IF the configured signing algorithm of a Client_Context is `RS256` or `PS256` and any configured Signing_Key for that Client_Context (the PEM Signing_Key or any key in the Private_JWKS) is not an RSA private key with a modulus of at least 2048 bits, THEN THE Config_Validator SHALL stop FCC_Server startup before the FCC_Server accepts HTTP requests, with an error that names the Client_Context, identifies the offending key by variable name and, for a Private_JWKS, by `kid`, and states that an RSA private key of at least 2048 bits is required.
4. IF the configured signing algorithm of a Client_Context is `ES256` and any configured Signing_Key for that Client_Context (the PEM Signing_Key or any key in the Private_JWKS) is not an EC private key on the P-256 curve, THEN THE Config_Validator SHALL stop FCC_Server startup before the FCC_Server accepts HTTP requests, with an error that names the Client_Context, identifies the offending key by variable name and, for a Private_JWKS, by `kid`, and states that an EC P-256 private key is required.
5. IF a configured Signing_Key cannot be parsed as a PEM-encoded private key or a private JWK, including when the value contains only public key parameters, THEN THE Config_Validator SHALL stop FCC_Server startup before the FCC_Server accepts HTTP requests, with an error that names the Client_Context and the variable and that contains no part of the configured key content.
6. IF a configured X.509 certificate for the Active_Key does not contain the public key matching the Active_Key, THEN THE Config_Validator SHALL stop FCC_Server startup before the FCC_Server accepts HTTP requests, with an error that names the Client_Context and the certificate variable and states that the certificate and key do not match, excluding certificate and key content.
7. WHILE the Client_Auth_Method of a Client_Context is `private_key_jwt` and no signing algorithm is configured for that Client_Context, THE Config_Validator SHALL treat the signing algorithm as `RS256` and apply criteria 3 to 6 accordingly.
8. IF a key in a configured Private_JWKS declares an `alg` parameter whose value differs from the signing algorithm configured for that Client_Context, THEN THE Config_Validator SHALL stop FCC_Server startup before the FCC_Server accepts HTTP requests, with an error that names the Client_Context, the `kid` of the offending key, the declared `alg` and the configured algorithm.
9. WHILE the Client_Auth_Method of a Client_Context is not `private_key_jwt`, or the Client_Context is not enabled, THE Config_Validator SHALL skip the validations in criteria 1 to 8 for that Client_Context, so that unused signing-key and algorithm variables do not stop FCC_Server startup.

### Requirement 8: JWKS-backed key management for client assertions

**User Story:** As a security engineer, I want to manage client assertion signing keys as a JWKS with key IDs, so that I can rotate keys without downtime and let the identity provider discover public keys.

#### Acceptance Criteria

1. WHERE a Private_JWKS is configured for a Client_Context, THE Client_Auth_Framework SHALL load every key in the Private_JWKS (1 to 10 keys) as a candidate Signing_Key for that Client_Context once at FCC_Server startup, so that changes to the Private_JWKS take effect only after the FCC_Server restarts.
2. WHERE a Private_JWKS is configured and an active `kid` is configured for a Client_Context, THE Client_Auth_Framework SHALL select the Private_JWKS key whose `kid` exactly matches the configured active `kid` (case-sensitive comparison) as the Active_Key.
3. WHERE a Private_JWKS containing exactly one key is configured and no active `kid` is configured, THE Client_Auth_Framework SHALL select that key as the Active_Key.
4. IF a Private_JWKS contains more than one key and no active `kid` is configured, THEN THE Config_Validator SHALL stop FCC_Server startup with an error that names the Client_Context and requests an active `kid`.
5. IF the configured active `kid` does not exactly match (case-sensitive) the `kid` of any key in the Private_JWKS, THEN THE Config_Validator SHALL stop FCC_Server startup with an error that names the Client_Context and the unmatched `kid`.
6. IF a key in the Private_JWKS lacks a `kid`, has an empty `kid`, or shares its `kid` with another key in the same Private_JWKS, or shares its `kid` with a key of the other Client_Context that has different public key parameters, THEN THE Config_Validator SHALL stop FCC_Server startup with an error that identifies the offending key by Client_Context and zero-based position, excluding key content.
7. WHILE a Private_JWKS is configured for a Client_Context, THE Client_Auth_Framework SHALL set the Client_Assertion `kid` header to the `kid` of the Active_Key on every Client_Assertion for that Client_Context.
8. THE Client_Auth_Framework SHALL derive the Public_JWKS from all configured Signing_Keys of every Client_Context that uses `private_key_jwt`, including every active and non-active Private_JWKS key, listing each distinct public key exactly once, and including for each key its `kty`, its `kid` where one is configured, `use`=`sig`, `alg` set to the configured Supported_Signing_Algorithm, and only the public key parameters (`n` and `e` for RSA keys; `crv`, `x` and `y` for EC keys).
9. FOR ALL configured Signing_Keys, the Public_JWKS SHALL omit the private parameters `d`, `p`, `q`, `dp`, `dq`, `qi` and `oth` (invariant).
10. FOR ALL Signing_Keys supplied as PEM, converting the public key to a JWK and back to a public key SHALL produce a key with identical public parameters to the original public key (identical modulus and exponent for RSA keys; identical curve and x and y coordinates for EC keys) (round-trip property).
11. FOR ALL Public_JWKS documents produced by the Client_Auth_Framework, serialising the Public_JWKS to JSON and parsing the result SHALL produce a key set with the same number of keys, in the same order, with identical member names and values for each key (round-trip property).
12. WHERE the JWKS_Endpoint is enabled, WHEN the JWKS_Endpoint receives an HTTP GET request, THE FCC_Server SHALL respond with HTTP 200, content type `application/json`, and a JWK Set whose `keys` array contains the Public_JWKS keys for every Client_Context that uses `private_key_jwt`, or an empty `keys` array if no Client_Context uses `private_key_jwt`.
13. WHERE the JWKS_Endpoint is enabled, THE FCC_Server SHALL serve the JWKS_Endpoint without requiring a user session, because identity providers fetch the Public_JWKS anonymously.
14. WHILE the JWKS_Endpoint is disabled, THE FCC_Server SHALL respond to requests on the JWKS_Endpoint path with HTTP 404, with the same response as for any unregistered route.
15. THE FCC_Server SHALL disable the JWKS_Endpoint by default.
16. IF a configured Private_JWKS is not valid JSON, has no `keys` array, contains zero keys, or contains more than 10 keys, THEN THE Config_Validator SHALL stop FCC_Server startup with an error that names the variable and states the reason, excluding key content.
17. IF a key in the Private_JWKS lacks its private parameters, or its key type or curve does not satisfy the Requirement 7 key requirements for the configured Supported_Signing_Algorithm, THEN THE Config_Validator SHALL stop FCC_Server startup with an error that identifies the key by Client_Context, zero-based position and `kid`, excluding key content.
18. IF both a PEM Signing_Key and a Private_JWKS are configured for the same Client_Context, THEN THE Config_Validator SHALL stop FCC_Server startup with an error that names both variables.

### Requirement 9: Mutual-TLS client authentication (RFC 8705)

**User Story:** As an operator whose identity provider authenticates clients by certificate, I want FCC to present a client certificate when calling the token endpoint, so that I can meet certificate-based authentication policies without a proxy or sidecar.

#### Acceptance Criteria

1. WHILE the Client_Auth_Method of a Client_Context is `tls_client_auth` or `self_signed_tls_client_auth`, THE Client_Auth_Framework SHALL present the configured Client_Certificate during the TLS handshake of each Token_Request for that Client_Context.
2. WHILE the Client_Auth_Method of a Client_Context is `tls_client_auth` or `self_signed_tls_client_auth`, THE Client_Auth_Framework SHALL send `client_id` as an `application/x-www-form-urlencoded` Token_Request body parameter, and SHALL omit `client_secret`, `client_assertion`, `client_assertion_type` and the `Authorization` header from the Token_Request.
3. WHERE a CA bundle is configured for a Client_Context, THE Client_Auth_Framework SHALL accept a token endpoint server certificate that chains to either a certificate in the configured CA bundle or a certificate in the default trust store, and SHALL reject a server certificate that chains to neither.
4. WHERE a passphrase is configured for the Client_Certificate private key, THE Client_Auth_Framework SHALL decrypt the Client_Certificate private key with the configured passphrase at FCC_Server startup.
5. WHERE an mTLS token endpoint URL is configured for a Client_Context, THE Client_Auth_Framework SHALL send every Token_Request for that Client_Context to the mTLS token endpoint URL instead of the standard token endpoint URL of that Client_Context.
6. WHILE an HTTP proxy is configured through `http_proxy` or `HTTP_PROXY` and the Client_Auth_Method is `tls_client_auth` or `self_signed_tls_client_auth`, THE Client_Auth_Framework SHALL present the Client_Certificate in the end-to-end TLS session established with the token endpoint through the proxy tunnel, and SHALL NOT present the Client_Certificate to the proxy itself.
7. THE Client_Auth_Framework SHALL NOT present a Client_Certificate on any outbound request other than Token_Requests of the Client_Context it is configured for, including Token_Requests of the other Client_Context and outbound Fluxnova API requests.
8. IF the Client_Auth_Method of an enabled Client_Context is `tls_client_auth` or `self_signed_tls_client_auth` and the Client_Certificate or its private key is not configured, THEN THE Config_Validator SHALL stop FCC_Server startup with an error that names each missing variable.
9. IF the configured Client_Certificate cannot be parsed as a PEM-encoded X.509 certificate, the private key does not match the certificate public key, or a configured CA bundle contains no parseable PEM-encoded X.509 certificate, THEN THE Config_Validator SHALL stop FCC_Server startup with an error that names the offending variable, excluding the certificate, key and CA bundle content.
10. WHEN the FCC_Server starts with a Client_Certificate whose `notAfter` date is later than the startup time and no more than 30 days after the startup time, THE FCC_Server SHALL log exactly one warning per affected Client_Context at startup, stating the Client_Context and the certificate `notAfter` date, and SHALL continue startup.
11. IF the configured Client_Certificate `notAfter` date is at or before the FCC_Server startup time, or its `notBefore` date is after the startup time, THEN THE Config_Validator SHALL stop FCC_Server startup with an error that names the Client_Context and states the certificate validity period.
12. IF the Client_Certificate private key is encrypted and no passphrase is configured, or the configured passphrase does not decrypt the private key, THEN THE Config_Validator SHALL stop FCC_Server startup with an error that names the passphrase variable, excluding the key and passphrase content.
13. IF a configured mTLS token endpoint URL is not an absolute URL with the `https` scheme, THEN THE Config_Validator SHALL stop FCC_Server startup with an error that names the variable.
14. IF the TLS handshake for a Token_Request under `tls_client_auth` or `self_signed_tls_client_auth` fails, or the token endpoint server certificate fails validation, THEN THE Client_Auth_Framework SHALL abort the Token_Request without sending the request body, report the Token_Request as failed to the Client_Context, log the failure as defined in Requirement 11 criterion 4, and SHALL NOT resend the Token_Request without the Client_Certificate or under a different Client_Auth_Method.

### Requirement 10: Key material sources

**User Story:** As an operator deploying with Kubernetes, Podman or Vault secrets, I want to supply keys, certificates, JWKS and secrets as either inline values or mounted files, so that I can use my existing secret-management tooling.

#### Acceptance Criteria

1. THE FCC_Server SHALL accept each client secret, Signing_Key, Private_JWKS, Client_Certificate, Client_Certificate private key, Client_Certificate private key passphrase and CA bundle through either an inline environment variable or a file path environment variable. The file path variable SHALL be named as the inline variable with the suffix `_FILE`. For example, `FXN_OIDC_PRIVATE_KEY_FILE` is the file path variable for `FXN_OIDC_PRIVATE_KEY`.
2. WHEN an item is supplied through a file path Key_Material_Source, THE FCC_Server SHALL produce the same Token_Requests, Client_Assertions, Public_JWKS and validation results as when the same content is supplied through the inline environment variable.
3. IF both the inline variable and the file path variable are set to non-empty values for the same item, THEN THE Config_Validator SHALL stop FCC_Server startup with an error that names both variables. The error SHALL exclude the item content.
4. IF a configured file path Key_Material_Source does not exist, is a directory, cannot be read due to permissions, or is larger than 1 MiB (1,048,576 bytes), THEN THE Config_Validator SHALL stop FCC_Server startup with an error that names the variable, the path and the reason. The error SHALL exclude any file content.
5. IF a configured file path Key_Material_Source is readable but empty, or contains only whitespace, THEN THE Config_Validator SHALL stop FCC_Server startup with an error that names the variable and the path.
6. WHEN a PEM value, from an inline variable or from a file, contains literal `\n` sequences or `\r\n` line endings, THE FCC_Server SHALL normalise the value to `\n` line endings before parsing. This matches the current `FXN_OIDC_PRIVATE_KEY` handling.
7. WHEN a client secret or passphrase is read from a file path Key_Material_Source, THE FCC_Server SHALL remove trailing `\r` and `\n` characters from the file content before use. All other characters, including leading and inner whitespace, SHALL be kept.
8. WHEN the FCC_Server starts, THE FCC_Server SHALL read each configured file path Key_Material_Source exactly once. Changes to the file contents after startup SHALL have no effect until the FCC_Server restarts.

### Requirement 11: Credential confidentiality

**User Story:** As a security engineer, I want credentials kept out of logs and error output, so that enabling new authentication methods does not leak secrets.

#### Acceptance Criteria

1. THE FCC_Server SHALL exclude the following credential values from all log entries at every log level and from all error messages, including Config_Validator startup errors: client secrets, `Authorization` header values sent on Token_Requests, Signing_Key private parameters, PEM-encoded private key content, Private_JWKS content, Client_Certificate private keys, passphrases and Client_Assertion values. A log entry or error message fails this criterion if it contains a configured credential value verbatim or the base64 encoding of a configured credential value.
2. IF a Token_Request receives an HTTP response with a status code outside the 200–299 range, THEN THE Client_Auth_Framework SHALL write one error-level log entry that contains the Client_Context, the Client_Auth_Method, the token endpoint URL, the client identifier and the HTTP status code, and that excludes the credential values listed in criterion 1.
3. THE FCC_Server SHALL include in each key served through the JWKS_Endpoint only the public key parameters for its key type and the key metadata parameters `kid`, `kty`, `use`, `alg`, `x5c`, `x5t` and `x5t#S256`, and SHALL omit the private parameters `d`, `p`, `q`, `dp`, `dq`, `qi`, `oth` and `k`.
4. IF a Token_Request fails without an HTTP response because of a connection error, DNS resolution failure, TLS handshake failure or timeout, THEN THE Client_Auth_Framework SHALL write one error-level log entry that contains the Client_Context, the Client_Auth_Method, the token endpoint URL, the client identifier and the failure category, and that excludes the credential values listed in criterion 1.
5. IF a Token_Request fails during a user-facing login, callback or refresh flow, or during an outbound Fluxnova API request, THEN THE FCC_Server SHALL return to the caller an error response that excludes the credential values listed in criterion 1 and excludes the token endpoint response body.

### Requirement 12: Unchanged user-facing authentication flows

**User Story:** As an end user of FCC, I want login to work the same way whichever client authentication method the operator chooses, so that the change is invisible to me.

#### Acceptance Criteria

1. WHEN the OIDC_Client sends a Token_Request for an authorization code exchange, a refresh token exchange or a username/password token exchange, THE OIDC_Client SHALL apply the configured Client_Auth_Method of the OIDC_Client to that Token_Request.
2. WHEN the OIDC_Client sends a Token_Request under any Client_Auth_Method, THE OIDC_Client SHALL include the same grant parameters with the same values (`grant_type`, `code`, `code_verifier`, `redirect_uri`, `scope`, `refresh_token`, `username` and `password`, as applicable to the grant) that the OIDC_Client sends under Legacy_Behaviour for the same configuration, differing only in the client authentication headers, body parameters and TLS client options defined in Requirements 4, 5, 6 and 9.
3. WHEN a user starts a login, THE FCC_Server SHALL produce an authorization redirect whose target URL and query parameters (including the PKCE `code_challenge` and `code_challenge_method`, `scope` with any configured scope override, `prompt` and `acr_values`) match those produced under Legacy_Behaviour for the same configuration under every Client_Auth_Method, with no additional browser redirects or user prompts.
4. WHEN the OIDC_Client receives a successful token response under any Client_Auth_Method, THE FCC_Server SHALL resolve user claims and create the user session in the same way as under Legacy_Behaviour, so that a token response with identical tokens yields an identical resolved user identity, roles and session lifetime.
5. THE FCC_Server SHALL keep the existing login, SSO, callback and logout routes with the same paths, HTTP methods, response status codes and redirect targets as the current release under every Client_Auth_Method.
6. IF an authorization code exchange or username/password token exchange fails because the token endpoint rejects the client authentication, THEN THE FCC_Server SHALL return to the user the same failure response that the current release returns for a failed token exchange, SHALL NOT create a user session, and SHALL NOT include the Client_Auth_Method or any credential value in the user-facing response.
7. IF a refresh token exchange fails under any Client_Auth_Method, THEN THE FCC_Server SHALL handle the user session in the same way as the current release handles a failed refresh token exchange under Legacy_Behaviour.

### Requirement 13: Test coverage

**User Story:** As a Fluxnova maintainer, I want automated tests for every client authentication method, so that the feature is safe for upstream inclusion and regressions are caught in CI.

#### Acceptance Criteria

1. THE FCC_Server test suite SHALL include, for each of the 12 combinations of the 6 valid Client_Auth_Method values and the 2 Client_Contexts, at least one test that asserts the presence or absence of each of the following in the captured Token_Request: the `Authorization` header, the request content type, and the `client_id`, `client_secret`, `client_assertion` and `client_assertion_type` body parameters, as defined in Requirements 4, 5, 6 and 9.
2. THE FCC_Server test suite SHALL include regression tests that, with the Client_Auth_Method both unset and set to `client_secret`, assert that the OIDC_Client sends `client_id` and `client_secret` in a form-encoded body with no `Authorization` header, and that the API_Auth_Client sends `client_id` and `client_secret` in a JSON body with no `Authorization` header.
3. THE FCC_Server test suite SHALL include property-based tests, each run against at least 100 generated inputs per execution, for the properties stated in Requirement 4 criterion 3, Requirement 5 criterion 5, Requirement 6 criteria 7 and 9 (criterion 9 exercised for each Supported_Signing_Algorithm), and Requirement 8 criteria 9, 10 and 11.
4. THE Config_Validator test suite SHALL include at least one test for each startup validation error defined in Requirements 2, 4, 5, 6, 7, 8, 9 and 10, and each test SHALL assert that FCC_Server startup is stopped, that the error identifies the item stated in the corresponding criterion (variable name, `kid`, key position, path or expiry date), and, where the corresponding criterion requires it, that the error excludes key content.
5. THE FCC_Server test suite SHALL include an integration test for `tls_client_auth` in which a local HTTPS token endpoint that requires a client certificate returns a token to a Client_Context that presents the configured Client_Certificate.
6. THE FCC_Server test suite SHALL include an integration test in which the local HTTPS token endpoint from criterion 5 rejects a Token_Request sent without the configured Client_Certificate, and the test SHALL assert that the Client_Context reports the Token_Request as failed.
7. THE FCC_Server test suite SHALL include tests asserting that the JWKS_Endpoint responds as defined in Requirement 8 criteria 12 to 15: HTTP 200 with the Public_JWKS and no private key parameters when enabled, no user session required, and HTTP 404 when disabled or left at its default.
8. THE FCC_Server test suite SHALL run every test in criteria 1 to 7 as part of the existing project test command, without network access to any token endpoint other than local test endpoints started by the tests.

### Requirement 14: Documentation and deployment guidance

**User Story:** As an operator, I want each authentication method documented with configuration examples, so that I can configure FCC for my identity provider without reading the source.

#### Acceptance Criteria

1. THE FCC documentation SHALL describe, in `docs/reference/authentication.md`, each of the six Client_Auth_Method values (`client_secret`, `client_secret_basic`, `client_secret_post`, `private_key_jwt`, `tls_client_auth`, `self_signed_tls_client_auth`), stating for each value: where the client credentials are placed in the Token_Request (header, body parameter or TLS handshake), the environment variables it requires, the environment variables it accepts as optional, and the Client_Contexts it applies to.
2. THE FCC documentation SHALL list, in `docs/reference/configuration.md`, every environment variable introduced or used by the Client_Auth_Framework for both Client_Contexts, stating for each variable: its Client_Context, the accepted values or value format, the default value (or that it has no default), whether it is required for each Client_Auth_Method, and the name of its file path Key_Material_Source counterpart where one exists.
3. THE FCC documentation SHALL state that the default for both Client_Contexts is Legacy_Behaviour, that `client_secret` is an alias for Legacy_Behaviour, and how Legacy_Behaviour differs on the wire from `client_secret_basic` and `client_secret_post` for each Client_Context (credential location and request body encoding: form-encoded for the OIDC_Client, JSON for the API_Auth_Client).
4. THE FCC documentation SHALL include one complete configuration example for each of `client_secret_basic`, `client_secret_post`, `private_key_jwt` with a single PEM Signing_Key, `private_key_jwt` with a Private_JWKS, `tls_client_auth` and `self_signed_tls_client_auth`, for each of the OIDC_Client and the API_Auth_Client, where each example lists every variable required by that Client_Auth_Method.
5. THE FCC documentation SHALL describe JWKS key rotation as four ordered steps (add the new key to the Private_JWKS, publish the Public_JWKS containing both keys, switch the active `kid` to the new key, then remove the old key from the Private_JWKS) and SHALL state which of these steps require an FCC_Server restart to take effect.
6. THE FCC documentation SHALL describe the JWKS_Endpoint path, the setting that enables the endpoint, its default of disabled, that the endpoint is served without a user session, that the response contains only public key parameters, and that any client able to reach the FCC_Server can read the Public_JWKS when the endpoint is enabled.
7. THE FCC deployment guidance SHALL describe, in `deploy/podman/README.md` for Podman and in `docs/guides/using-secrets-from-vault.md` for Vault, how to supply each Signing_Key, Private_JWKS, Client_Certificate, Client_Certificate private key and CA bundle through a file path Key_Material_Source, and SHALL state that configuring both the inline value and the file path for the same item stops FCC_Server startup.
8. THE FCC documentation SHALL use only placeholder values for client identifiers, client secrets, private keys, certificates, JWKS content and passphrases in every configuration example, with no working credential or key material.
9. THE FCC documentation SHALL list each Config_Validator startup error defined in Requirements 2, 4, 5, 6, 7, 8, 9 and 10, stating for each error the configuration condition that causes it and the configuration change that resolves it.
10. THE FCC documentation SHALL describe Client_Certificate renewal for `tls_client_auth` and `self_signed_tls_client_auth`, including the startup warning logged when the Client_Certificate expires within 30 days and the startup failure when the Client_Certificate has already expired.
