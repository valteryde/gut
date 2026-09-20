#!/bin/sh
# Make a self-signed code-signing certificate for the macOS app and print
# the two GitHub secrets release.yml consumes (MAC_CSC_LINK / MAC_CSC_PASSWORD).
#
# Why this exists: adhoc-signed builds get a new code identity every build,
# so macOS treats each update as a different app and revokes TCC grants
# (Local Network -> the app silently loses its backends after every update).
# A stable cert keeps the designated requirement identical across builds,
# so a grant given once sticks forever. No Apple developer account needed;
# Gatekeeper still won't trust the cert, but install/update strips the
# quarantine bit anyway.
#
# Usage: packaging/make-signing-cert.sh [output.p12]
set -e

NAME="gut self-signed"
OUT="${1:-gut-sign.p12}"
PASS="$(LC_ALL=C tr -dc 'a-zA-Z0-9' </dev/urandom | head -c 24)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/openssl.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions    = v3
prompt             = no
[dn]
CN = $NAME
[v3]
basicConstraints     = critical, CA:TRUE
keyUsage             = critical, digitalSignature, keyCertSign
extendedKeyUsage     = critical, codeSigning
subjectKeyIdentifier = hash
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -config "$TMP/openssl.cnf" \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem"
# -legacy: openssl 3 exports PBES2/AES p12s that macOS `security import`
# can't verify ("MAC verification failed"); legacy 3DES/RC2 imports fine.
openssl pkcs12 -export -legacy -out "$OUT" \
  -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -password "pass:$PASS" 2>/dev/null \
|| openssl pkcs12 -export -out "$OUT" \
  -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -password "pass:$PASS" \
     -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES

cat <<EOF

Created $OUT  (CN "$NAME", valid 10 years)

Set these repo secrets — GitHub -> Settings -> Secrets -> Actions:

  MAC_CSC_LINK      base64 of the .p12 (printed below)
  MAC_CSC_PASSWORD  $PASS

Or with gh:
  base64 -i "$OUT" | gh secret set MAC_CSC_LINK
  gh secret set MAC_CSC_PASSWORD --body "$PASS"

MAC_CSC_LINK:
EOF
base64 -i "$OUT"
