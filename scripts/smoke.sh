#!/usr/bin/env bash
# Smoke test run after every deploy. Exits non-zero unless the home page at the
# given origin answers 200 with the product name in the body.
# Usage: scripts/smoke.sh https://timesifier.com [--www]
#   --www also requires https://www.<host> to redirect to the origin.
set -euo pipefail

ORIGIN="${1:?usage: smoke.sh <origin> [--www]}"
ORIGIN="${ORIGIN%/}"
ATTEMPTS=6 # a new deployment can take a few seconds to reach every location

status=""
for attempt in $(seq 1 "$ATTEMPTS"); do
	status="$(curl --silent --output /tmp/smoke-body --write-out '%{http_code}' --max-time 15 "$ORIGIN/" || true)"
	[ "$status" = "200" ] && break
	echo "attempt $attempt of $ATTEMPTS: $ORIGIN/ answered ${status:-nothing}" >&2
	[ "$attempt" -lt "$ATTEMPTS" ] && sleep 5
done

if [ "$status" != "200" ]; then
	echo "FAIL: $ORIGIN/ answered ${status:-nothing}, expected 200" >&2
	exit 1
fi
if ! grep --quiet "Timesifier" /tmp/smoke-body; then
	echo "FAIL: $ORIGIN/ answered 200 but the page does not contain \"Timesifier\"" >&2
	exit 1
fi
echo "ok: $ORIGIN/ answered 200"

if [ "${2:-}" = "--www" ]; then
	alias_url="https://www.${ORIGIN#https://}/smoke?check=1"
	location="$(curl --silent --output /dev/null --write-out '%{redirect_url}' --max-time 15 "$alias_url" || true)"
	if [ "$location" != "$ORIGIN/smoke?check=1" ]; then
		echo "FAIL: $alias_url redirected to \"${location}\", expected $ORIGIN/smoke?check=1" >&2
		exit 1
	fi
	echo "ok: $alias_url redirects to the apex"
fi
