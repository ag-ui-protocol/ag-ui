#!/usr/bin/env bash
# Packs every .NET package in a release package list (the dotnet-packages.json
# publish-release.yml builds) into OUT_DIR, already built with --no-build.
#
# Usage: pack-dotnet-packages.sh <stable|prerelease> <packages.json> <out-dir>
#
# Each entry is {name, version, path, file}: `file` is the package's own
# Directory.Build.props (release.config.json's versionSource), whose
# VersionPrefix is the base the prerelease suffix is derived from.
#
# Shared by publish-release.yml and the claude-managed-agents .NET unit
# workflow, which packs a test list with it to check the NuGet versions.
set -euo pipefail

MODE=$1
PACKAGES=$2
OUT_DIR=$3

mkdir -p "$OUT_DIR"
while read -r pkg; do
  NAME=$(echo "$pkg" | jq -r '.name')
  VERSION=$(echo "$pkg" | jq -r '.version')
  PKG_PATH=$(echo "$pkg" | jq -r '.path')
  PROPS=$(echo "$pkg" | jq -r '.file')
  BASE_VERSION=$(sed -nE 's/.*<VersionPrefix[^>]*>([^<]+)<\/VersionPrefix>.*/\1/p' "$PROPS" | head -n1)
  if [ -z "$BASE_VERSION" ]; then
    echo "::error::Could not read VersionPrefix from ${PROPS} for ${NAME}"
    exit 1
  fi
  CSPROJ="${PKG_PATH}/${NAME}.csproj"
  EXTRA_ARGS=()
  if [ "$MODE" = "prerelease" ]; then
    SUFFIX="${VERSION#"$BASE_VERSION"-}"
    if [ "$SUFFIX" = "$VERSION" ] || [ -z "$SUFFIX" ]; then
      echo "::error::Could not derive VersionSuffix for ${NAME}@${VERSION} from VersionPrefix ${BASE_VERSION}"
      exit 1
    fi
    if [ "$PROPS" = "sdks/dotnet/Directory.Build.props" ]; then
      # SDK scope: the global property is wanted, so AGUI.Server's
      # dependency on AGUI.Abstractions carries the same suffix.
      EXTRA_ARGS+=("-p:VersionSuffix=${SUFFIX}")
    else
      # Integration scope: a global VersionSuffix would flow into the
      # ProjectReferenced SDK projects and make the package depend on
      # SDK prereleases that do not exist. The integration's
      # Directory.Build.props maps this property onto its own
      # VersionSuffix only. If an integration lacks that mapping, the
      # nupkg-name check below fails the pack.
      EXTRA_ARGS+=("-p:AGUIPackVersionSuffix=${SUFFIX}")
    fi
  fi
  echo "Packing ${NAME}@${VERSION} from ${CSPROJ}"
  dotnet pack "$CSPROJ" -c Release --no-build -o "$OUT_DIR" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
  if [ ! -f "${OUT_DIR}/${NAME}.${VERSION}.nupkg" ]; then
    echo "::error::Expected ${OUT_DIR}/${NAME}.${VERSION}.nupkg after pack"
    exit 1
  fi
done < <(jq -c '.[]' "$PACKAGES")
