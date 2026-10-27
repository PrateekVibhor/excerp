#!/usr/bin/env bash
# Proves, on the real JavaScript bundles, that the stand-in for Google's sign-in (and its test tokens) is in the end-to-end
# build and in no other build (spec 12). It exports the app's bundle four ways and searches each for the stand-in's text.
# Takes a few minutes; run it before a release or after touching metro.config.js, authConfig.ts or the build profiles.
#   Exit code: 0 all four answers are as they should be, 1 not.
set -u
ROOT="$(cd "${BASH_SOURCE[0]%/*}/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
NEEDLES=("Choose an account" "Test reader: approved" "e2e:tester@example.com")
bad=0

check() { # name, "present" | "absent", then the environment to build with
  local name="$1" want="$2"; shift 2
  (cd "$ROOT" && env "$@" npx expo export --platform ios --no-bytecode --clear --output-dir "$TMP/$name" >"$TMP/$name.log" 2>&1)
  local bundle; bundle="$(ls "$TMP/$name"/_expo/static/js/ios/*.js 2>/dev/null | head -1)"
  if [ -z "$bundle" ]; then echo "  FAIL  $name: the export produced no bundle (see below)"; tail -5 "$TMP/$name.log"; bad=1; return; fi
  local found=0 needle
  for needle in "${NEEDLES[@]}"; do [ "$(grep -c "$needle" "$bundle")" -gt 0 ] && found=$((found + 1)); done
  if { [ "$want" = present ] && [ "$found" -eq ${#NEEDLES[@]} ]; } || { [ "$want" = absent ] && [ "$found" -eq 0 ]; }; then
    echo "  ok    $name: stand-in $want ($found of ${#NEEDLES[@]} marker texts found)"
  else
    echo "  FAIL  $name: expected the stand-in $want, but $found of ${#NEEDLES[@]} marker texts were found"; bad=1
  fi
}

echo "Searching real exported bundles for the Google stand-in:"
check live-style        absent  EXPO_PUBLIC_DATA_SOURCE=api EXPO_PUBLIC_API_URL=http://127.0.0.1:9 EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=web.apps.googleusercontent.com
check e2e-mock          absent  EXPO_PUBLIC_DATA_SOURCE=mock
check flag-not-true     absent  EXPO_PUBLIC_DATA_SOURCE=api EXPO_PUBLIC_API_URL=http://localhost:8787 EXPO_PUBLIC_E2E=TRUE
check e2e-api           present EXPO_PUBLIC_DATA_SOURCE=api EXPO_PUBLIC_API_URL=http://localhost:8787 EXPO_PUBLIC_E2E=true
[ "$bad" -eq 0 ] && echo "All as they should be." || echo "Something is wrong: see the lines marked FAIL."
exit "$bad"
