# Chrome Web Store Listing - QR-Tool

## Short Description (EN)
Generate, decode, scan, and verify QR content locally with a high-performance Rust WebAssembly engine.

## Short Description (VI)
Tao, giai ma, quet, va xac minh noi dung QR cuc nhanh bang Rust WebAssembly chay cuc bo.

## Full Description (EN)
QR-Tool is a productivity extension for Chromium-based browsers that helps you work with QR codes end-to-end in one interface.

Key capabilities:
- Generate QR codes from text or URL.
- Decode QR codes from uploaded images, drag-and-drop files, or clipboard images.
- Realtime camera scanning with configurable scan interval and auto-stop options.
- Verify HTTP/HTTPS links through a Rust WebAssembly verification pipeline.
- Keep a local action history for quick replay.
- Switch language (English/Vietnamese) and theme (system/light/dark).

Performance and privacy:
- QR encode/decode logic runs with Rust WebAssembly for fast and consistent behavior.
- Processing is done locally in the extension context.
- No sign-up is required.

Permission rationale:
- storage: save settings and local history.
- clipboardRead / clipboardWrite: read image data from clipboard and copy results.
- host permissions (<all_urls>): enable link verification and related HTTP/HTTPS checks.

Best use cases:
- Quickly generate QR for links, Wi-Fi text payloads, and plain notes.
- Decode QR from screenshots without leaving your browser.
- Validate destination links before opening them.

## Full Description (VI)
QR-Tool la tien ich cho trinh duyet Chromium, ho tro toan bo quy trinh lam viec voi ma QR trong mot giao dien duy nhat.

Tinh nang chinh:
- Tao ma QR tu van ban hoac URL.
- Giai ma QR tu anh tai len, keo-tha tep, hoac anh tu clipboard.
- Quet camera realtime voi tuy chon chu ky quet, auto-stop, va tu dong sao chep ket qua.
- Xac minh lien ket HTTP/HTTPS bang pipeline Rust WebAssembly.
- Luu lich su thao tac o local de su dung lai nhanh.
- Chuyen ngon ngu (Anh/Viet) va giao dien (system/light/dark).

Hieu nang va quyen rieng tu:
- Engine QR viet bang Rust WebAssembly de toi uu toc do va do on dinh.
- Xu ly du lieu ngay trong extension, khong can dang ky tai khoan.
- Khong bat buoc gui noi dung QR len server de su dung co ban.

Giai thich quyen truy cap:
- storage: luu cau hinh va lich su local.
- clipboardRead / clipboardWrite: doc anh tu clipboard va sao chep ket qua.
- host permissions (<all_urls>): phuc vu xac minh lien ket HTTP/HTTPS.

## Privacy Statement Template
QR-Tool processes QR content primarily in the local extension context. User settings and history are stored locally via browser extension storage. The extension does not require account registration. If cloud features are introduced in future versions, they must be documented in the privacy policy and release notes.

## Suggested Store Metadata
- Category: Productivity
- Language listing: English and Vietnamese
- Support URL: <your_support_url>
- Homepage URL: <your_project_url>
- Privacy policy URL: <your_privacy_policy_url>
