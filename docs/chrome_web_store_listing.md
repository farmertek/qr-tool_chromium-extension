# Chrome Web Store Listing - QR-Tool

## Short Description (EN)
Generate, decode, scan, and verify QR content locally with a high-performance Rust WebAssembly engine.

## Short Description (VI)
Tạo, giải mã, quét, và xác minh nội dung QR cực nhanh bằng Rust WebAssembly chạy cục bộ.

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
QR-Tool là tiện ích cho trình duyệt Chromium, hỗ trợ toàn bộ quy trình làm việc với mã QR trong một giao diện duy nhất.

Tính năng chính:
- Tạo mã QR từ văn bản hoặc URL.
- Giải mã QR từ ảnh tải lên, kéo-thả tệp, hoặc ảnh từ clipboard.
- Quét camera realtime với tùy chọn chu kỳ quét, auto-stop, và tự động sao chép kết quả.
- Xác minh liên kết HTTP/HTTPS bằng pipeline Rust WebAssembly.
- Lưu lịch sử thao tác ở local để sử dụng lại nhanh.
- Chuyển ngôn ngữ (Anh/Viet) và giao diện (system/light/dark).

Hiệu năng và quyền riêng tư:
- Engine QR viết bằng Rust WebAssembly để tối ưu tốc độ và độ ổn định.
- Xử lý dữ liệu ngay trong extension, không cần đăng ký tài khoản.
- Không bắt buộc gửi nội dung QR lên server để sử dụng cơ bản.

Giải thích quyền truy cập:
- storage: lưu cấu hình và lịch sử local.
- clipboardRead / clipboardWrite: đọc ảnh từ clipboard và sao chép kết quả.
- host permissions (<all_urls>): phục vụ xác minh liên kết HTTP/HTTPS.

## Privacy Statement Template
QR-Tool processes QR content primarily in the local extension context. User settings and history are stored locally via browser extension storage. The extension does not require account registration. If cloud features are introduced in future versions, they must be documented in the privacy policy and release notes.

## Suggested Store Metadata
- Category: Productivity
- Language listing: English and Vietnamese
- Support URL: <your_support_url>
- Homepage URL: <your_project_url>
- Privacy policy URL: <your_privacy_policy_url>
