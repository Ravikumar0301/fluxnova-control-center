# Local OIDC `private_key_jwt` Setup

This guide runs Keycloak and the Fluxnova BPM platform with Docker Compose and runs the Control Center from the repository with `pnpm start`. It uses the separate Keycloak client `fluxnova-control-center-private-jwt`; the existing `fluxnova-control-center` client remains available for client-secret testing.

This is a local development setup. Do not reuse its demo users, local credentials, or TLS configuration in a shared or deployed environment. A successful unit test does not prove Keycloak interoperability. Record the Keycloak image version and complete a real browser authorization-code login before reporting interoperability as verified.

## Prerequisites

- Node.js 24, pnpm, Docker Compose, and OpenSSL
- The Keycloak client `fluxnova-control-center-private-jwt` in `docker/keycloak/realm-export.json`
- The Keycloak Admin Console credentials configured for your local Compose environment

## 1. Generate the local client key pair

From the repository root, run:

```bash
bash ./scripts/generate-oidc-client-key.sh
```

The script creates:

- `docker/keys/fluxnova-oidc-client-private.pem` — Control Center signing key; keep it private.
- `docker/keys/fluxnova-oidc-client-certificate.pem` — matching public certificate to register with Keycloak.

The key directory is ignored by Git, and the script sets restrictive file permissions and refuses to overwrite an existing pair. Never mount or send the private key to Keycloak.

If the Keycloak HTTPS certificate has not been generated, create it with:

```bash
bash ./scripts/generate-cert.sh
```

## 2. Start local Keycloak and the engine

```bash
docker compose -f docker/docker-compose-keycloak-local.yml up -d
```

The local Compose file starts Keycloak at `https://localhost:8443` and the BPM platform at `http://localhost:8080`.

Keycloak's `--import-realm` startup option imports `docker/keycloak/realm-export.json` only when the `fluxnova` realm does not already exist. If the realm was created before the private-key client was added, the startup import will not update that existing realm. In that case, create/configure the client in the Admin Console or use a separate, deliberate realm update procedure; do not remove Keycloak data unless you intend to reset it. See Keycloak's [realm import documentation](https://www.keycloak.org/server/importExport).

## 3. Register the public certificate with Keycloak

The current Compose setup does not automatically register the client certificate. Register it in the Keycloak Admin Console:

1. Open `https://localhost:8443` and sign in with the local Keycloak administrator account.
2. Select the `fluxnova` realm and open the `fluxnova-control-center-private-jwt` client.
3. Confirm client authentication and the standard authorization-code flow are enabled, and select the signed-JWT client authenticator.
4. In the client Keys settings, import `docker/keys/fluxnova-oidc-client-certificate.pem` as the certificate for client JWT verification.
5. Set the token endpoint authentication signing algorithm to `RS256` and the maximum assertion expiration to 60 seconds, if those controls are available in the deployed Keycloak version.

The certificate must match the private key generated in step 1. Keycloak's [26.8 administration guide](https://www.keycloak.org/docs/26.8.0/server_admin/) describes the signed-JWT client authenticator and certificate-based verification. The Compose file currently uses a mutable `latest` image tag, so check the actual Keycloak version and verify these settings in that version.

## 4. Configure the host-run Control Center

The Control Center reads process environment variables; Nest's `ConfigModule` does not load `.env` files. Export the settings in the shell that will run `pnpm start`. The URLs below use `localhost` because the app runs on the host, not inside the Compose network.

```bash
export FXN_AUTH_STRATEGY=oidc
export FXN_OIDC_CLIENT_AUTH_METHOD=private_key_jwt
export FXN_OIDC_CLIENT_ID=fluxnova-control-center-private-jwt
export FXN_OIDC_PRIVATE_KEY_JWT_ALGORITHM=RS256
export FXN_OIDC_PRIVATE_KEY="$(< docker/keys/fluxnova-oidc-client-private.pem)"

export FXN_OIDC_AUTHORITY=https://localhost:8443/realms/fluxnova
export FXN_OIDC_AUTH_URL=https://localhost:8443/realms/fluxnova/protocol/openid-connect/auth
export FXN_OIDC_ISSUER=https://localhost:8443/realms/fluxnova
export FXN_OIDC_TOKEN_URL=https://localhost:8443/realms/fluxnova/protocol/openid-connect/token
export FXN_OIDC_USERINFO_URL=https://localhost:8443/realms/fluxnova/protocol/openid-connect/userinfo
export FXN_PUBLIC_URL=http://localhost:4000
export FXN_REST_API_URL=http://localhost:8080/engine-rest
```

The local server uses HTTP on port 4000 when no server TLS certificate paths are configured. The Keycloak HTTPS endpoint uses the local self-signed certificate. To keep Node TLS verification enabled, trust that local certificate for this process:

```bash
export NODE_EXTRA_CA_CERTS="$PWD/docker/certs/fluxnova-local.crt"
unset NODE_TLS_REJECT_UNAUTHORIZED
```

Do not set `FXN_OIDC_CLIENT_SECRET` for this private-key client. In this mode the Control Center signs an assertion with the private key; Keycloak verifies it using the registered public certificate. The app generates a new short-lived assertion for each applicable token request. `FXN_AUTH_STRATEGY=none` and the default `client_secret` method remain separate options.

Start the Control Center from the same shell:

```bash
pnpm start
```

Open `http://localhost:4000` and use the existing SSO authorization-code login. For the local username/password workflow, use the original `fluxnova-control-center` client with its client-secret configuration; the private-key client is intended for the SSO test.

## 5. Verify the setup

First, run the focused strategy tests:

```bash
pnpm exec nx test server --run src/auth/strategies/oidc.auth-strategy.service.spec.ts
```

Then verify against the live local Keycloak instance:

- Complete browser login and confirm the callback succeeds.
- Confirm the authenticated session still works after reloading the page.
- Confirm Keycloak accepts the configured RS256 assertion and certificate.
- Record the Keycloak image version used for the run.

Unit tests do not establish live Keycloak compatibility. Do not claim interoperability until the authorization-code login and token exchange succeed against the Keycloak version being used.

## Return to client-secret testing

In the same shell, switch the app back to `FXN_OIDC_CLIENT_ID=fluxnova-control-center` and `FXN_OIDC_CLIENT_AUTH_METHOD=client_secret`, and provide that local client's configured secret through the runtime environment. The `client_secret` method is the default when `FXN_OIDC_CLIENT_AUTH_METHOD` is omitted.

## Stop local services

```bash
docker compose -f docker/docker-compose-keycloak-local.yml down
```
