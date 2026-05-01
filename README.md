# QR-Tool Chromium Extension (Rust + WASM)

Browser extension for Chromium-based browsers, powered by Rust WebAssembly.

## Implemented features

- Full-page application UI in browser tab (desktop-like workspace layout).
- Generate QR from text or URL using Rust WASM.
- Center overlay for generated QR (text/logo) in PNG workflow.
- Decode QR from uploaded image using Rust WASM.
- Decode QR from clipboard image.
- Drag-drop image to decode panel.
- Realtime QR scan from camera using Rust WASM decoder.
- Advanced camera options: scan interval, auto stop, auto copy, low-CPU decode option (ROI/downscale), torch (if device supports), zoom (if device supports).
- Verify HTTP/HTTPS links using Rust WASM pipeline only.
- Action history stored in extension local storage.
- i18n via i18next with Vietnamese and English.
- Theme setting: system, light, dark.

## Project structure

- `extension/`: unpacked extension package (full-page app UI, manifest, locale files, WASM output).
- `wasm_qr/`: Rust crate compiled to WebAssembly.
- `scripts/build_extension.ps1`: build automation for WASM + i18next runtime copy.
- `scripts/build_extension.sh`: Linux build automation for WASM + i18next runtime copy.
- `scripts/dist_github_sync.ps1`: sync only `chromium_ext` subtree to dedicated GitHub repository.
- `scripts/dist_publish_extension.ps1`: build, package, upload, and publish to Chrome Web Store.
- `docs/chrome_web_store_listing.md`: prepared listing copy for Chrome Web Store submission.

## Prerequisites

- Rust toolchain
- `wasm-pack`
- Node.js + npm

## Build

Run from `chromium_ext` on Windows:

```powershell
npm run build
```

Build debug profile:

```powershell
npm run build:debug
```

Run from `chromium_ext` on Linux:

```bash
npm run build:linux
```

Linux debug build:

```bash
npm run build:linux:debug
```

## Load extension in browser

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable Developer mode.
3. Click Load unpacked.
4. Select the `chromium_ext/extension` directory.
5. Click the QR-Tool extension icon to open the app in a dedicated browser tab.

## Distribution and publish

Sync only extension code to dedicated repository:

```powershell
powershell -ExecutionPolicy Bypass -File ./scripts/dist_github_sync.ps1 -RepoUrl "https://github.com/<owner>/qr-tool_chromium-extension.git" -Branch main
```

Preview sync result without pushing:

```powershell
powershell -ExecutionPolicy Bypass -File ./scripts/dist_github_sync.ps1 -RepoUrl "https://github.com/<owner>/qr-tool_chromium-extension.git" -DryRun
```

Build/package/upload/publish to Chrome Web Store (requires OAuth access token and extension ID):

```powershell
powershell -ExecutionPolicy Bypass -File ./scripts/dist_publish_extension.ps1 -ExtensionId <chrome_web_store_item_id> -AccessToken <oauth_access_token>
```

Local release zip files are stored in `dist/<manifest-version>/`.

Link to official Chrome Web Store listing: https://chromewebstore.google.com/detail/qr-tool/dijoabooaglgpnofooamjhpoicjmbbin

## Notes

- The extension runs fully local in extension app page context.
- Camera access requires browser permission when starting scan.
- Some native desktop workflows are not directly portable to browser extension context, for example direct access to local temp workspace conventions and OS-level integrations.
