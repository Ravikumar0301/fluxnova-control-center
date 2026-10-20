#!/usr/bin/env bash

set -euo pipefail
umask 077

outDir="."

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --outDir)
      if [[ -z "${2:-}" || "${2:0:2}" == "--" ]]; then
        echo "Error: --outDir requires a value." >&2
        exit 1
      fi
      outDir="$2"
      shift 2
      ;;
    --help)
      cat <<EOF
Usage: $0 [--outDir <path>]

Generates a local OIDC client RSA private key and matching certificate.

Options:
  --outDir <path>    Root output directory (default: .)

Output:
  <outDir>/docker/keys/fluxnova-oidc-client-private.pem
  <outDir>/docker/keys/fluxnova-oidc-client-certificate.pem
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Run with --help for usage information." >&2
      exit 1
      ;;
  esac
done

keyDir="$outDir/docker/keys"
privateKeyPath="$keyDir/fluxnova-oidc-client-private.pem"
certificatePath="$keyDir/fluxnova-oidc-client-certificate.pem"

if [[ -e "$privateKeyPath" || -e "$certificatePath" ]]; then
  echo "Error: a key or certificate already exists in $keyDir; refusing to overwrite it." >&2
  exit 1
fi

mkdir -p "$keyDir"
chmod 700 "$keyDir"

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$privateKeyPath" \
  -out "$certificatePath" \
  -days 365 \
  -subj "/CN=fluxnova-control-center" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature"

chmod 600 "$privateKeyPath" "$certificatePath"

echo "Local OIDC client key pair generated:"
echo "  Private key: $privateKeyPath"
echo "  Certificate: $certificatePath"
echo
echo "Import the certificate into the Keycloak client's Keys tab."
printf 'For a local app process, set the key with:\n  export FXN_OIDC_PRIVATE_KEY="$(< %q)"\n' "$privateKeyPath"

### 4. Explanation