#!/usr/bin/env bash
# Downloads the latest finished iOS simulator build of a test profile into e2e/builds/<profile>/ (git-ignored), and records
# which EAS build it is, so a run can print it.   Usage: e2e/fetch-build.sh e2e-api | e2e-mock
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
profile="${1:-}"
case "$profile" in
  e2e-api | e2e-mock) ;;
  *) echo "Usage: e2e/fetch-build.sh e2e-api | e2e-mock" >&2; exit 2 ;;
esac
cd "$ROOT"
json="$(npx --yes eas-cli build:list --platform ios --build-profile "$profile" --status finished --limit 1 --json --non-interactive)"
fields="$(printf '%s' "$json" | node -e '
  const b = JSON.parse(require("fs").readFileSync(0, "utf8"))[0];
  if (!b) { console.error("No finished iOS build of this profile yet."); process.exit(3); }
  console.log([b.artifacts.applicationArchiveUrl, b.id, b.completedAt, (b.gitCommitHash || "").slice(0, 7)].join(" "));
')"
set -- $fields
url="$1"; id="$2"; finished="$3"; commit="$4"
dest="$ROOT/e2e/builds/$profile"
rm -rf "${dest:?}"
mkdir -p "$dest"
curl -fsSL -o "$dest/build.tar.gz" "$url"
tar -xzf "$dest/build.tar.gz" -C "$dest"
rm -f "$dest/build.tar.gz"
[ -d "$dest/Excerp.app" ] || { echo "The download did not contain Excerp.app" >&2; exit 1; }
echo "EAS build $id, finished $finished, EAS commit label $commit" >"$dest/BUILD_INFO"
echo "Fetched $profile: $(cat "$dest/BUILD_INFO")"
