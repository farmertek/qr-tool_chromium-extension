#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${ROOT_DIR}"

if ! command -v wasm-pack >/dev/null 2>&1; then
    echo "Command 'wasm-pack' was not found. Install from https://rustwasm.github.io/wasm-pack/installer/"
    exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
    echo "Command 'npm' was not found. Install Node.js LTS from https://nodejs.org/"
    exit 1
fi

VENDOR_SOURCE="${ROOT_DIR}/node_modules/i18next/dist/esm/i18next.js"
if [[ ! -f "${VENDOR_SOURCE}" ]]; then
    echo "Installing Node dependencies (i18next)..."
    npm install
fi

WASM_OUTPUT_DIR="${ROOT_DIR}/extension/wasm"
rm -rf "${WASM_OUTPUT_DIR}"

WASM_ARGS=(
    build
    ./wasm_qr
    --target
    web
    --out-dir
    ../extension/wasm
    --out-name
    wasm_qr
)

if [[ "${1:-}" != "--debug" ]]; then
    WASM_ARGS+=(--release)
fi

echo "Building Rust WebAssembly package..."
wasm-pack "${WASM_ARGS[@]}"

VENDOR_DIR="${ROOT_DIR}/extension/vendor"
mkdir -p "${VENDOR_DIR}"

echo "Copying i18next runtime into extension package..."
cp "${VENDOR_SOURCE}" "${VENDOR_DIR}/i18next.js"

echo
echo "Build completed."
echo "Load unpacked extension from: ${ROOT_DIR}/extension"
