#!/usr/bin/env bash
set -euo pipefail

package_dir=$(cd "$(dirname "$0")/.." && pwd)
consumer=$(mktemp -d)
trap 'rm -rf "$consumer"' EXIT

cd "$package_dir"
npm pack --pack-destination "$consumer" >/dev/null
cp -R test "$consumer/test"
cd "$consumer"
echo '{"name":"pi-consumer-test","private":true,"type":"module"}' > package.json
npm install --no-audit --no-fund ./ag-ui-pi-*.tgz \
  @ag-ui/client@1.0.4 @ag-ui/core@1.0.4 \
  @earendil-works/pi-agent-core@1.5.2 @earendil-works/pi-ai@1.5.2 \
  @earendil-works/pi-coding-agent@1.5.2 tsx@4.20.6 typescript@5.8.2 @types/node@22

cmp "$package_dir/LICENSE" node_modules/@ag-ui/pi/LICENSE
cmp "$package_dir/PROVENANCE.md" node_modules/@ag-ui/pi/PROVENANCE.md
cp "$package_dir/tsconfig.json" tsconfig.json
npm exec -- tsc --noEmit
npm exec -- tsx --test test/*.test.ts
