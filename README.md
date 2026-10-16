# Drive Worker

Workspace Google Drive chạy trên một Cloudflare Worker: React SPA, D1 và hai
SQLite Durable Objects. Google OAuth của operator xử lý catalog/upload;
service account chỉ phục vụ download và preview.

## Trạng thái

Project khởi tạo ngày 12/10/2026. Nền tảng local gồm React SPA + Hono Worker,
D1 `DB`, hai SQLite Durable Object (`ProjectCoordinator`, `UploadSession`),
setup một-owner có thể resume, Better Auth email/password, session cookie,
origin/CSRF guard, role và mount grants. OAuth catalog/write và SA content-read
có transport allowlist, vault, token coordinator và test trong workerd.

Wave 3 bổ sung catalog/admin API, content streaming/Range/revisions/share/ticket,
upload state/protocol và UI Explorer/admin. Trạng thái nghiệm thu hiện hành nằm
trong ledger bên dưới; kết quả local và kiểm thử Google thật được ghi riêng.
Wave 4/5 bổ sung browser uploader/recovery, folder batches, preview viewers,
HLS, tab onboarding admin (trang `/admin` mặc định, có Shared Drive chooser),
rotation khóa chủ có re-key UploadSession trực tiếp, diagnostics metrics
trong-isolate và journey fake-Google end-to-end. Chưa có deployment hoặc
mount kết nối Google thật được xác nhận.

Đặc tả kiến trúc, kế hoạch triển khai và bằng chứng kiểm thử nội bộ được lưu
ngoài repository public này; tài liệu vận hành nằm trong `docs/` (xem mục
"Tài liệu vận hành" bên dưới).

## Môi trường

Dùng Node 24 (xem `.nvmrc`) và npm; toolchain dev dùng runtime Node 24 riêng
(per-user), không thay Node hệ thống. Dependency đã khóa bằng `package-lock.json`
và cài bằng `npm ci` với `engine-strict` (`.npmrc`).

```sh
cp .dev.vars.example .dev.vars   # điền hai secret base64 32 byte (xem dưới)
npm ci
npm run dev                      # Vite + Worker dev server
npm run check                    # tsc -b (web + worker + tests + configs)
npm test                         # vitest trong workerd (unit + integration)
npm run build                    # tsc -b && vite build -> dist/
npm run preview                  # preview production build qua workerd
npm run test:e2e                 # Playwright: chromium + firefox projects
npm run test:e2e:journey         # build + journey qua fake Google (:8878)
npm run db:migrations:local      # wrangler d1 migrations apply DB --local
npm run cf:typegen               # wrangler types -> worker-configuration.d.ts
```

Hai secret bootstrap là `APP_MASTER_KEY` và `SETUP_TOKEN`; file example để trống
có chủ đích. Mỗi secret phải là base64 chuẩn của đúng 32 byte (ví dụ tạo bằng
`openssl rand -base64 32`). Không đưa secret thật vào Git, task brief,
screenshot hoặc log.

### Setup và auth

`POST /api/v1/setup` nhận `{token, name, email, password, canonicalOrigin}`:
`token` là `SETUP_TOKEN`; `canonicalOrigin` là origin chính thức (origin duy
nhất được trust cho CSRF/redirect của Better Auth — phải https với host
không-loopback). Thành công trả `200` `{setupState:'complete',
canonicalOrigin}`. Sau đó đăng nhập qua `POST /api/auth/sign-in/email`
`{email,password}`; `POST /api/auth/sign-out`, `GET /api/auth/get-session`
(null hoặc projection `{session,user}` an toàn, không có token thô) và
`GET /api/v1/session` (SessionView cho SPA). Public sign-up bị tắt; admin tạo
user qua Better Auth admin plugin (role mặc định `user`).

### E2E

E2E cách ly hoàn toàn khỏi môi trường dev: Playwright webServer build
rồi chạy `vite preview` với secret xác định lấy từ biến môi trường (mặc định
fixture public trong `tests/e2e/e2e-env.ts`, ghi đè bằng `E2E_SETUP_TOKEN` /
`E2E_APP_MASTER_KEY` — không đọc `.dev.vars` của dev; file `.dev.vars` build
emit vào `dist/` bị xoá trước khi preview). State binding nằm trong thư mục
riêng mỗi lần chạy `.e2e-state/w2/run-<timestamp>` (root ghi đè bằng
`CF_PERSIST_DIR`), nên suite chạy lặp lại được và không đụng `.wrangler/state`
hay preview wave-1 ở `localhost:8879`. Playwright dùng Chrome hệ thống
(`channel: "chrome"`) và serialize spec (`workers: 1`). Migration e2e chạy qua
`wrangler d1 migrations apply` lên DB test. Setup/auth/admin dùng API local thật;
mount và Google connection tổng hợp được ghi rõ là SQL fixture và dọn sau suite.
Explorer có các kịch bản `[fixture]` chặn Google-dependent API ở browser; các
kịch bản đó không phải bằng chứng Google live.

`playwright.config.ts` định nghĩa hai project chạy mặc định — `chromium`
(channel `chrome`) và `firefox`; project `webkit` chỉ được nạp khi
`E2E_WEBKIT=1` vì các gói hệ điều hành của nó chưa được cài trên máy này
(khoảng 91 gói apt chờ duyệt — chưa bao giờ chạy WebKit local). Ngoài suite
mặc định còn có `npm run test:e2e:journey`: một spec serial trên
`playwright.journey.config.ts` chạy browser → worker đã build trong Miniflare
→ fake Google trong tiến trình (`tests/e2e/fake-google/`) trên port 8878 với
control port 8898, state riêng dưới `.e2e-state/journey/`. Journey đi qua
setup → admin login → import OAuth client → consent redirect → mount → grant
→ upload/download thật qua HTTP API; nó là kiểm thử tích hợp local, không
phải bằng chứng Google live. CI workflow `.github/workflows/ci.yml` tái hiện
các gate local (check, test, build, E2E chromium+firefox, journey) cộng một
job WebKit **non-blocking**; file này mới chỉ được kiểm tra tĩnh — chưa bao
giờ chạy trên GitHub vì chưa có push được ủy quyền. Bench hiệu năng dưới
`tests/perf/` chạy fixture qua Miniflare (không TCP/TLS), không phải số liệu
Google thật.

Mục tiêu v1 gồm Explorer, upload phục hồi, preview, chia sẻ có scope và admin.
Mount v1 là toàn bộ Shared Drive. My Drive, mount cây con, transcoding, overwrite
và Office editing nằm ngoài phạm vi này.

Chưa có Git remote hoặc URL public để tạo Deploy button thật. Việc publish/deploy
và kiểm thử với Cloudflare/Google thật là các gate riêng trong kế hoạch.

## Tài liệu vận hành (operator docs)

- [SECURITY.md](SECURITY.md) — mô hình bảo mật, xử lý secret, tách hai provider plane
- [docs/google-setup.md](docs/google-setup.md) — OAuth Web client, scope, Shared Drive, service account
- [docs/deployment.md](docs/deployment.md) — dev local, provision D1/DO, staging, backup/restore
- [docs/operations.md](docs/operations.md) — rotation, recovery, retention, diagnostics (T14)
- [docs/troubleshooting.md](docs/troubleshooting.md) — bảng mã lỗi và trạng thái vận hành
- [docs/release-checklist.md](docs/release-checklist.md) — gate local và G1–G6 awaiting-external
