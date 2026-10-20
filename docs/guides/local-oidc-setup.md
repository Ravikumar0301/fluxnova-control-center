# Local OIDC Setup (Keycloak + fluxnova-bpm-platform)

This guide runs `control-center` and `bpm-platform` with OIDC provided by Keycloak using
`docker/docker-compose-keycloak.yml`.

## What this stack provides

- Keycloak on `https://localhost:8443`
- bpm-platform on `http://localhost:8080`
- control-center on `https://localhost:4000`
- OIDC login for control-center and JWT validation in bpm-platform

## Prerequisites

- Docker Desktop (or Docker Engine + Compose plugin)
- `openssl` installed
- Access to pull images from your configured `DOCKER_REGISTRY` (default `docker.io`)

## 1) Generate local TLS certs used by Keycloak and control-center

From repo root:

```bash
bash ./scripts/generate-cert.sh
```

This creates:

- `docker/certs/fluxnova-local.crt`
- `docker/certs/fluxnova-local.key`

## 2) Start the OIDC stack

From repo root:

- Use `--build` if you want to build `control-center` from local source changes.
- Omit `--build` to use/pull images from your configured registry.

```bash
docker compose -f docker/docker-compose-keycloak.yml up -d --build
```

```bash
docker compose -f docker/docker-compose-keycloak.yml up -d
```

Optional: if your environment needs internal registry mirrors, set these first:

```bash
export DOCKER_REGISTRY=<your-registry>
export ALPINE_REGISTRY=<your-alpine-mirror>
```

## 3) Verify services are up

```bash
docker compose -f docker/docker-compose-keycloak.yml ps
```

Check logs if needed:

```bash
docker compose -f docker/docker-compose-keycloak.yml logs -f keycloak
docker compose -f docker/docker-compose-keycloak.yml logs -f control-center
docker compose -f docker/docker-compose-keycloak.yml logs -f bpm-platform
```

## 4) Sign in to control-center

Open:

- `https://localhost:4000`

Test users from `docker/keycloak/realm-export.json`:

- `demo` / `demo`
- `john` / `john`
- `mary` / `mary`
- `peter` / `peter`

## Verify `private_key_jwt` against local Keycloak

The Keycloak image in `docker/docker-compose-keycloak.yml` uses the mutable `latest` tag. The locally available image inspected while preparing this procedure reported Keycloak 26.8.1 with digest `sha256:79c623a22abacf3fe6c00a5fb30f5b7843d717b234033b80995891c06116d244`. Record the version and digest of the image actually used for each run; the compose tag alone does not pin the test version.

Keycloak's [26.8 Server Administration Guide](https://www.keycloak.org/docs/26.8.0/server_admin/) documents the `Signed JWT issued by the client` authenticator, certificate import in the client's Keys tab, signature-algorithm policy, and maximum assertion expiration. This procedure targets the locally available 26.8.1 image. The interoperability test has not been run, so this guide does not assert that login currently succeeds with `private_key_jwt`.

1. Generate a temporary RSA key and certificate outside the repository:

   ```bash
   export OIDC_TEST_DIR="$(mktemp -d)"
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$OIDC_TEST_DIR/client-key.pem"
   openssl req -new -x509 -key "$OIDC_TEST_DIR/client-key.pem" -out "$OIDC_TEST_DIR/client-cert.pem" -days 30 -subj "/CN=fluxnova-control-center"
   ```

   Keep the private key in this temporary directory and do not add it to the repository.

2. In the Keycloak Admin Console, open the `fluxnova` realm and the `fluxnova-control-center` client. Keep client authentication enabled and the standard authorization-code flow enabled. In the client's Credentials settings, select the signed-JWT client authenticator. In the Keys tab, import `client-cert.pem` as the client's certificate. Set the client assertion signature algorithm to `RS256` and the maximum assertion expiration to 60 seconds. The imported certificate must contain the public key corresponding to `client-key.pem`.

3. Create a temporary Compose override outside the repository:

   ```bash
   cat > "$OIDC_TEST_DIR/compose.override.yml" <<'YAML'
   services:
     control-center:
       environment:
         FXN_OIDC_CLIENT_AUTH_METHOD: private_key_jwt
         FXN_OIDC_PRIVATE_KEY: "${FXN_OIDC_PRIVATE_KEY:?Set FXN_OIDC_PRIVATE_KEY in the shell}"
         FXN_OIDC_PRIVATE_KEY_JWT_ALGORITHM: RS256
   YAML
   ```

   Export the temporary key into the shell environment without printing it, then recreate the Control Center service with the override:

   ```bash
   export FXN_OIDC_PRIVATE_KEY="$(< "$OIDC_TEST_DIR/client-key.pem")"
   docker compose -f docker/docker-compose-keycloak.yml -f "$OIDC_TEST_DIR/compose.override.yml" up -d --build control-center
   ```

   The base compose file still supplies its local demo client-secret environment value. Private-key mode must omit that value from MSAL configuration and authenticate with the signed assertion.

4. Open `https://localhost:4000` and complete the existing SSO authorization-code login. Verify that Keycloak returns to the Control Center callback, the authenticated application loads, and the authenticated session remains usable after a page reload. Run the OIDC strategy unit tests as well; they check the assertion signature, `iss`, `sub`, `aud`, `iat`, `exp`, `jti`, `RS256`, and absence of `clientSecret` from the MSAL configuration:

   ```bash
   pnpm exec nx test server --run src/auth/strategies/oidc.auth-strategy.service.spec.ts
   ```

   The unit tests do not prove Keycloak interoperability. Record a successful live authorization-code login against the version and digest above before reporting interoperability as verified. Do not use this procedure to claim that the local username/password grant supports `private_key_jwt`.

## Notes about hostname usage

The compose file intentionally mixes hostnames:

- `keycloak:8443` for container-to-container calls (token, userinfo, JWKS)
- `localhost:8443` for browser-reachable URLs and issuer matching

This keeps browser redirects working while preserving internal Docker DNS routing.

```bash
docker compose -f docker/docker-compose-keycloak.yml run --rm --entrypoint sh control-center
```

## Stop and clean up

```bash
docker compose -f docker/docker-compose-keycloak.yml down
```

To also remove volumes:

```bash
docker compose -f docker/docker-compose-keycloak.yml down -v
```
