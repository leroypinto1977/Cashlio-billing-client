#!/usr/bin/env bash
# Builds the Windows terminal installer from any machine.
#
# better-sqlite3 is a native addon: the copy in node_modules is compiled for
# whatever machine ran `npm install`, and electron-builder is configured not to
# rebuild it. Packaging for Windows from a Mac therefore ships a macOS binary,
# and the till dies on launch with a module-load error naming a file nobody
# recognises.
#
# The project publishes prebuilt binaries for every Electron ABI, so the right
# one is fetched and swapped in for the length of the build, then put back.
# Leaving a Windows .node in a developer's tree would break their next
# `npm run dev` in exactly the same confusing way.
set -euo pipefail
cd "$(dirname "$0")/.."

BSQ_VERSION="$(node -p "require('./node_modules/better-sqlite3/package.json').version")"
ELECTRON_VERSION="$(node -p "require('./node_modules/electron/package.json').version")"
ABI="$(node -p "require('node-abi').getAbi('${ELECTRON_VERSION}','electron')")"
TARGET="build/Release/better_sqlite3.node"
NATIVE="node_modules/better-sqlite3/${TARGET}"
BACKUP="node_modules/better-sqlite3/${TARGET}.host-backup"

echo "▸ better-sqlite3 ${BSQ_VERSION}, Electron ${ELECTRON_VERSION} (ABI ${ABI})"

ASSET="better-sqlite3-v${BSQ_VERSION}-electron-v${ABI}-win32-x64.tar.gz"
URL="https://github.com/WiseLibs/better-sqlite3/releases/download/v${BSQ_VERSION}/${ASSET}"

TMP="$(mktemp -d)"
restore() {
  if [ -f "$BACKUP" ]; then
    mv -f "$BACKUP" "$NATIVE"
    echo "▸ restored this machine's better-sqlite3"
  fi
  rm -rf "$TMP"
}
trap restore EXIT

echo "▸ fetching the Windows build of better-sqlite3"
curl -fL --silent --show-error -o "${TMP}/bsq.tar.gz" "$URL"
tar -xzf "${TMP}/bsq.tar.gz" -C "$TMP"
[ -f "${TMP}/${TARGET}" ] || { echo "the prebuild did not contain ${TARGET}" >&2; exit 1; }

# Confirm it is actually a Windows binary before trusting it into a build.
if ! file "${TMP}/${TARGET}" | grep -q "MS Windows"; then
  echo "the downloaded binary is not a Windows one — refusing to package it" >&2
  exit 1
fi

cp -p "$NATIVE" "$BACKUP"
cp -f "${TMP}/${TARGET}" "$NATIVE"
echo "▸ swapped in the Windows binary"

npm run build
npx electron-builder --win --x64

echo "▸ done"
