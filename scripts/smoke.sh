#!/usr/bin/env bash
# Smoke test run after every deploy. Exits non-zero unless the home page at the
# given origin answers 200 with the product name in the body.
# Usage: scripts/smoke.sh https://timesifier.com [--production [version-host]]
#   --production also requires: https://www.<host> redirects to the origin;
#   http://<host> redirects to https; and, when a version host is given (the
#   workers.dev address of the version just deployed), that it answers 404.
set -euo pipefail

ORIGIN="${1:?usage: smoke.sh <origin> [--production [version-host]]}"
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

# Fails unless a request for $1 is redirected to $2.
expect_redirect() {
	local location
	location="$(curl --silent --output /dev/null --write-out '%{redirect_url}' --max-time 15 "$1" || true)"
	if [ "$location" != "$2" ]; then
		echo "FAIL: $1 redirected to \"${location}\", expected $2" >&2
		exit 1
	fi
	echo "ok: $1 redirects to $2"
}

if [ "${2:-}" = "--production" ]; then
	host="${ORIGIN#https://}"
	expect_redirect "https://www.$host/smoke?check=1" "$ORIGIN/smoke?check=1"
	expect_redirect "http://$host/smoke?check=1" "$ORIGIN/smoke?check=1"

	if [ -n "${3:-}" ]; then
		status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 15 "https://$3/" || true)"
		if [ "$status" != "404" ]; then
			echo "FAIL: https://$3/ answered ${status:-nothing}, expected 404: a production version is reachable outside $host" >&2
			exit 1
		fi
		echo "ok: https://$3/ answered 404"
	fi
fi
