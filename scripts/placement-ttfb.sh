#!/usr/bin/env bash
# Time to first byte and the cf-placement header for one origin (docs/decisions.md 34).
# usage: scripts/placement-ttfb.sh <origin> [samples]
# Two requests per sample: the API with a well-formed but unknown token, whose
# 401 costs one D1 query, and /robots.txt, a static file the Worker never runs
# for, as the baseline of the network alone.
set -euo pipefail
origin="$1"
samples="${2:-10}"
token="tsf_$(printf 'x%.0s' $(seq 43))"
for path in /api/v1/me /robots.txt; do
	times=()
	for _ in $(seq "$samples"); do
		out="$(curl -s -o /dev/null -D - -w 'TTFB %{time_starttransfer}\n' \
			-H "Authorization: Bearer $token" "$origin$path")"
		times+=("$(printf '%s\n' "$out" | awk '/^TTFB/ { printf "%d", $2 * 1000 }')")
		placement="$(printf '%s\n' "$out" | awk 'tolower($1) == "cf-placement:" { print $2 }' | tr -d '\r')"
		status="$(printf '%s\n' "$out" | awk 'NR == 1 { print $2 }')"
	done
	sorted="$(printf '%s\n' "${times[@]}" | sort -n | tr '\n' ' ')"
	median="$(printf '%s\n' "${times[@]}" | sort -n | awk '{ a[NR] = $1 } END { print a[int((NR + 1) / 2)] }')"
	echo "$origin$path status=$status cf-placement=${placement:-none} median=${median}ms samples(ms)=$sorted"
done
