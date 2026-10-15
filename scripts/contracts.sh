#!/bin/sh
# @t3tools/contracts is unpublished. Check out its source at the t3code tag pinned in package.json
# (config.t3code) so tsc can type-import it. Type-only: nothing from it ships at runtime.
set -eu
ref=${npm_package_config_t3code:?run through npm, e.g. npm run typecheck}
dir=vendor/t3code
[ "$(git -C "$dir" describe --tags --exact-match 2>/dev/null)" = "$ref" ] && exit 0
rm -rf "$dir"
git -c advice.detachedHead=false clone --quiet --depth 1 --filter=blob:none --sparse --branch "$ref" https://github.com/pingdotgg/t3code.git "$dir"
git -C "$dir" sparse-checkout set packages/contracts
