#!/usr/bin/env bash
# Credential-free staging and artifact-only deployment for the Kotlin SDK.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIBRARY="$SCRIPT_DIR/library"
stage_only=false
deploy_only=false
dry_run=false
repository=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --stage-only) stage_only=true; shift ;;
    --deploy-only) deploy_only=true; shift ;;
    --dry-run) dry_run=true; shift ;;
    --repository)
      option="$1"
      [ "$#" -ge 2 ] || { echo "ERROR: $option needs a value" >&2; exit 1; }
      repository="$2"
      shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--stage-only | --dry-run | --deploy-only --repository DIR]"
      echo "Default: clean, test, stage, deploy the full repository."
      echo "Dry run performs real tests and staging without deployment or credentials."
      exit 0 ;;
    *) echo "ERROR: unknown option $1" >&2; exit 1 ;;
  esac
done
if { [ "$stage_only" = true ] || [ "$dry_run" = true ]; } && [ "$deploy_only" = true ]; then
  echo "ERROR: stage/dry-run and deploy-only are mutually exclusive; cannot combine" >&2
  exit 1
fi
if [ "$deploy_only" = false ] && [ -n "$repository" ]; then
  echo "ERROR: explicit repository option requires deploy-only" >&2
  exit 1
fi
[ "$dry_run" = false ] || stage_only=true
repository="${repository:-$LIBRARY/build/staging-deploy}"
if [ "$deploy_only" = false ]; then mkdir -p "$(dirname "$repository")"; fi
repository="$(cd "$(dirname "$repository")" && pwd)/$(basename "$repository")"
gradle_args=(--no-daemon --max-workers=2 --no-parallel
  '-Dorg.gradle.jvmargs=-Xmx1536m -XX:MaxMetaspaceSize=768m -Dfile.encoding=UTF-8'
  -Pkotlin.compiler.execution.strategy=in-process)
cd "$LIBRARY"

if [ "$deploy_only" = false ]; then
  echo "Staging unsigned Kotlin artifacts (no deployment credentials needed)." >&2
  ./gradlew clean "${gradle_args[@]}"
  ./gradlew allTests "${gradle_args[@]}"
  ./gradlew publish exportReleaseCoordinates "${gradle_args[@]}"
  jq -e 'type == "array" and length > 0' build/release/coordinates.json >/dev/null
  while IFS=$'\t' read -r group name version; do
    group_path=$(printf '%s' "$group" | tr '.' '/')
    pom="$repository/$group_path/$name/$version/$name-$version.pom"
    [ -s "$pom" ] || { echo "ERROR: missing staged POM $pom" >&2; exit 1; }
  done < <(jq -r '.[] | [.groupId, .name, .version] | @tsv' build/release/coordinates.json)
  if [ "$stage_only" = true ]; then
    echo "Staging complete: $repository (no deployment)." >&2
    exit 0
  fi
fi

[ -d "$repository" ] && [ -n "$(find "$repository" -name '*.pom' -print -quit)" ] || {
  echo "ERROR: staging repository has no Maven POMs: $repository" >&2; exit 1;
}
for variable in JRELEASER_MAVENCENTRAL_SONATYPE_USERNAME JRELEASER_MAVENCENTRAL_SONATYPE_PASSWORD \
  JRELEASER_GPG_PASSPHRASE JRELEASER_GPG_PUBLIC_KEY JRELEASER_GPG_SECRET_KEY; do
  if [ -z "${!variable:-}" ]; then echo "ERROR: missing required deployment variable $variable" >&2; exit 1; fi
done
# This task has no publish/test/build dependencies; JReleaser signs and uploads.
./gradlew jreleaserDeploy "-PreleaseStagingRepository=$repository" "${gradle_args[@]}"
