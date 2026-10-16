/**
 * Admin operations (diagnostics / maintenance / rotation / cleanup) messages.
 * Split from the main dictionaries so the admin-ops owner edits only this
 * file; `en` must expose every key of `vi`.
 */
export const adminOpsVi = {
  title: "Vận hành",
  refresh: "Làm mới",
  nextAction: "Bước tiếp theo",
  none: "Không có",

  // Diagnostics block on the Health tab.
  diagTitle: "Chẩn đoán hệ thống",
  diagIntro:
    "Chỉ gồm id, trạng thái và bộ đếm — không có envelope, token hay URI nội bộ nào được hiển thị.",
  diagGenerated: "Sinh lúc",
  diagOAuthTitle: "OAuth catalog/upload",
  diagSaTitle: "Service account (đọc nội dung)",
  diagConnections: "kết nối",
  diagAccounts: "tài khoản",
  diagNeedsReauth: "cần đăng nhập lại",
  diagDisabled: "đã tắt",
  diagCoolingDown: "đang tạm nghỉ",
  diagRecentFailures: "lỗi gần đây",
  diagUploadsTitle: "Upload",
  diagByState: "Theo trạng thái",
  diagConfirmedBytes: "Byte đã xác nhận",
  diagTruncated: "số liệu bị cắt bớt ở giới hạn quét",
  diagBlockedReader: "Hoàn tất nhưng reader bị chặn",
  diagReadersTitle: "Trạng thái reader",
  diagAuditTitle: "Lỗi audit trong 24 giờ",
  diagNoErrors: "Không có lỗi nào trong 24 giờ qua.",
  diagCooldownsTitle: "Cooldown đang hoạt động",
  diagNoCooldowns: "Không có cooldown nào.",
  diagMaintenanceTitle: "Trạng thái bảo trì",
  diagEmpty: "Chưa có dữ liệu.",
  diagRetryAfter: "thử lại sau",

  // Maintenance mode.
  modeTitle: "Chế độ bảo trì",
  modeExplain:
    "Bật chế độ bảo trì chặn mọi admission mới: upload mới và yêu cầu cấp token đều bị từ chối cho tới khi tắt. Các yêu cầu đang chạy vẫn tiếp tục.",
  modeEnable: "Bật chế độ bảo trì",
  modeDisable: "Tắt chế độ bảo trì",
  modeConfirmEnableTitle: "Bật chế độ bảo trì?",
  modeConfirmEnableBody:
    "Mọi upload mới và admission token mới sẽ bị từ chối ngay lập tức (UPSTREAM_UNAVAILABLE, client được báo thử lại). Các yêu cầu đang chạy không bị gián đoạn.",
  modeConfirmDisableTitle: "Tắt chế độ bảo trì?",
  modeConfirmDisableBody:
    "Admission sẽ hoạt động lại bình thường. Không thể tắt khi đang có rotation khóa chạy.",
  modeLiftBlocked:
    "Không thể tắt chế độ bảo trì khi rotation đang chạy — hoàn tất hoặc hủy rotation trước.",
  modeStatus: "Chế độ",
  mode_off: "Tắt",
  mode_drain: "Bảo trì (chặn admission)",
  mode_keyRotation: "Rotation khóa",

  // Retention cleanup.
  cleanupTitle: "Dọn dữ liệu định kỳ",
  cleanupExplain:
    "Xóa audit event cũ hơn 30 ngày và phần detail tạm của upload đã kết thúc quá 7 ngày (chỉ khi tombstone đã bền). Tombstone và idempotency không bao giờ bị xóa.",
  cleanupDryRun: "Xem trước (dry-run)",
  cleanupRun: "Chạy cleanup",
  cleanupConfirmTitle: "Chạy cleanup thật?",
  cleanupConfirmBody:
    "Các bản ghi đủ điều kiện sẽ bị xóa/purge vĩnh viễn trong pass này. Thao tác này chạy theo batch giới hạn và có thể chạy lại an toàn.",
  cleanupAuditEligible: "Audit event đủ điều kiện",
  cleanupAuditDeleted: "Audit event đã xóa",
  cleanupDetailEligible: "Upload detail đủ điều kiện",
  cleanupDetailPurged: "Upload detail đã purge",
  cleanupKept: "Giữ lại vì chưa có tombstone",
  cleanupTruncated:
    "Kết quả bị cắt theo batch — chạy lại cho tới khi không còn bản ghi đủ điều kiện.",
  cleanupPreviewDone: "Kết quả xem trước (không có gì bị thay đổi).",
  cleanupDone: "Cleanup đã chạy xong.",

  // Key rotation stepper.
  rotationTitle: "Rotation khóa chủ",
  rotationExplain:
    "APP_MASTER_KEY_NEXT phải được cấu hình (secret) TRƯỚC khi bắt đầu. Rotation re-seal toàn bộ envelope trong D1; chỉ promote APP_MASTER_KEY sang giá trị NEXT và xóa NEXT sau khi complete thành công. Không bao giờ gỡ NEXT giữa chừng — envelope đã seal sẽ mở không được.",
  rotationStart: "Bắt đầu rotation",
  rotationStep: "Chạy batch tiếp",
  rotationVerify: "Verify",
  rotationComplete: "Hoàn tất rotation",
  rotationAbort: "Hủy rotation",
  rotationStartConfirmTitle: "Bắt đầu rotation khóa?",
  rotationStartConfirmBody:
    "Ngay lập tức chặn mọi admission mới và bắt đầu re-seal envelope sang khóa NEXT. APP_MASTER_KEY_NEXT phải được stage sẵn; mọi session sẽ bị thu hồi khi complete.",
  rotationCompleteConfirmTitle: "Hoàn tất rotation?",
  rotationCompleteConfirmBody:
    "Mọi phiên đăng nhập sẽ bị thu hồi — người dùng phải đăng nhập lại. Sau khi complete thành công mới được promote APP_MASTER_KEY=NEXT và gỡ APP_MASTER_KEY_NEXT.",
  rotationAbortConfirmTitle: "Hủy rotation?",
  rotationAbortConfirmBody:
    "Chỉ hủy được trước khi envelope nào bị ghi lại. Sau đó lối thoát duy nhất là hoàn tất rotation hoặc restore backup.",
  rotationStepProcessed: "đã xử lý trong batch",
  rotationStepRemaining: "còn envelope — chạy batch tiếp",
  rotationStepDone: "đã xử lý hết — chuyển sang verify",
  rotationVerifyOk: "Verify thành công: mọi envelope mở được bằng khóa NEXT.",
  rotationVerifyFailed:
    "Verify thất bại — rotation quay về re-encrypt; chạy step rồi verify lại.",
  rotationVerifiedCount: "đã verify",
  rotationFailedCount: "thất bại",
  rotationSessionsRevoked: "phiên đã thu hồi",
  rotationCompleteNext:
    "Bây giờ promote APP_MASTER_KEY sang giá trị NEXT, gỡ APP_MASTER_KEY_NEXT rồi redeploy.",
  rotationEnvelopeTotals: "Tổng envelope",
  rotationActiveNote:
    "Rotation đang chạy: mọi admission mới đang bị chặn. Hoàn tất hoặc hủy trước khi làm việc khác.",
  hintNextKey:
    "Cấu hình APP_MASTER_KEY_NEXT (canonical base64, 32 byte) rồi khởi động lại worker trước khi thử lại.",
  hintBlockedUploads:
    "Đợi các upload đang chạy kết thúc (finish/cancel/expire) rồi thử lại — admission mới đã bị chặn nên chỉ cần chờ.",
  hintPhaseConflict:
    "Trạng thái rotation không cho phép thao tác này — tải lại trạng thái và làm theo bước hiển thị.",
  hintAbortLate:
    "Đã có envelope được ghi lại — không hủy được nữa; chỉ có thể hoàn tất rotation hoặc restore backup.",
  hintVerifyRetry: "Chạy step để re-encrypt phần lỗi rồi verify lại.",
  abortHint: "Chỉ khả dụng khi chưa có envelope nào được ghi lại.",

  phase_idle: "Chưa chạy",
  phase_reencrypting: "Đang re-encrypt",
  phase_verifying: "Đang verify",
  phase_verified: "Đã verify",
  phase_done: "Hoàn tất",
  phase_failed: "Thất bại",
};

export const adminOpsEn: typeof adminOpsVi = {
  title: "Operations",
  refresh: "Refresh",
  nextAction: "Next action",
  none: "None",

  // Diagnostics block on the Health tab.
  diagTitle: "System diagnostics",
  diagIntro:
    "Ids, states and counters only — no envelopes, tokens or internal URIs are ever shown.",
  diagGenerated: "Generated at",
  diagOAuthTitle: "OAuth catalog/write",
  diagSaTitle: "Service accounts (content read)",
  diagConnections: "connections",
  diagAccounts: "accounts",
  diagNeedsReauth: "needs reauth",
  diagDisabled: "disabled",
  diagCoolingDown: "cooling down",
  diagRecentFailures: "recent failures",
  diagUploadsTitle: "Uploads",
  diagByState: "By state",
  diagConfirmedBytes: "Confirmed bytes",
  diagTruncated: "totals truncated at the scan cap",
  diagBlockedReader: "Completed with blocked reader",
  diagReadersTitle: "Reader states",
  diagAuditTitle: "Audit errors in the last 24 hours",
  diagNoErrors: "No errors in the last 24 hours.",
  diagCooldownsTitle: "Active cooldowns",
  diagNoCooldowns: "No active cooldowns.",
  diagMaintenanceTitle: "Maintenance state",
  diagEmpty: "No data yet.",
  diagRetryAfter: "retry after",

  // Maintenance mode.
  modeTitle: "Maintenance mode",
  modeExplain:
    "Enabling maintenance mode blocks every new admission: new uploads and token issuance are refused until it is lifted. In-flight requests keep running.",
  modeEnable: "Enable maintenance mode",
  modeDisable: "Disable maintenance mode",
  modeConfirmEnableTitle: "Enable maintenance mode?",
  modeConfirmEnableBody:
    "Every new upload and token admission is refused immediately (UPSTREAM_UNAVAILABLE; clients are told to retry). In-flight requests are not interrupted.",
  modeConfirmDisableTitle: "Disable maintenance mode?",
  modeConfirmDisableBody:
    "Admissions return to normal. The gate cannot be lifted while a key rotation is in flight.",
  modeLiftBlocked:
    "Maintenance mode cannot be lifted while a rotation is running — complete or abort the rotation first.",
  modeStatus: "Mode",
  mode_off: "Off",
  mode_drain: "Maintenance (admissions blocked)",
  mode_keyRotation: "Key rotation",

  // Retention cleanup.
  cleanupTitle: "Retention cleanup",
  cleanupExplain:
    "Deletes audit events older than 30 days and purges transient upload detail older than 7 days (terminal rows only, and only once the result tombstone is durable). Tombstones and the idempotency index are never deleted.",
  cleanupDryRun: "Preview (dry-run)",
  cleanupRun: "Run cleanup",
  cleanupConfirmTitle: "Run cleanup for real?",
  cleanupConfirmBody:
    "Eligible records are permanently deleted/purged in this pass. Each pass is batch-bounded and safe to re-run.",
  cleanupAuditEligible: "Audit events eligible",
  cleanupAuditDeleted: "Audit events deleted",
  cleanupDetailEligible: "Upload details eligible",
  cleanupDetailPurged: "Upload details purged",
  cleanupKept: "Kept — tombstone not durable yet",
  cleanupTruncated:
    "Results were truncated at the batch bound — re-run until no eligible records remain.",
  cleanupPreviewDone: "Dry-run complete (nothing was changed).",
  cleanupDone: "Cleanup finished.",

  // Key rotation stepper.
  rotationTitle: "Master-key rotation",
  rotationExplain:
    "APP_MASTER_KEY_NEXT must be staged as a secret BEFORE starting. The rotation re-seals every D1 envelope; promote APP_MASTER_KEY to the NEXT value and remove NEXT only after complete succeeds. Never remove NEXT mid-run — envelopes sealed during the window would become unreadable.",
  rotationStart: "Start rotation",
  rotationStep: "Run next batch",
  rotationVerify: "Verify",
  rotationComplete: "Complete rotation",
  rotationAbort: "Abort rotation",
  rotationStartConfirmTitle: "Start key rotation?",
  rotationStartConfirmBody:
    "Immediately blocks all new admissions and begins re-sealing envelopes under the NEXT key. APP_MASTER_KEY_NEXT must already be staged; every session is revoked when the run completes.",
  rotationCompleteConfirmTitle: "Complete the rotation?",
  rotationCompleteConfirmBody:
    "Every sign-in session is revoked — users must sign in again. Only after this succeeds may you promote APP_MASTER_KEY to NEXT and remove APP_MASTER_KEY_NEXT.",
  rotationAbortConfirmTitle: "Abort the rotation?",
  rotationAbortConfirmBody:
    "Abort is only possible before any envelope was rewritten. Afterwards the only exits are completing the rotation or restoring a backup.",
  rotationStepProcessed: "processed in this batch",
  rotationStepRemaining: "envelopes remain — run another batch",
  rotationStepDone: "all processed — proceed to verify",
  rotationVerifyOk: "Verify passed: every envelope opens under the NEXT key.",
  rotationVerifyFailed:
    "Verify failed — the run fell back to re-encryption; run step again, then re-verify.",
  rotationVerifiedCount: "verified",
  rotationFailedCount: "failed",
  rotationSessionsRevoked: "sessions revoked",
  rotationCompleteNext:
    "Now promote APP_MASTER_KEY to the NEXT value, remove APP_MASTER_KEY_NEXT and redeploy.",
  rotationEnvelopeTotals: "Envelope totals",
  rotationActiveNote:
    "A rotation is in flight: all new admissions are blocked. Complete or abort it before other work.",
  hintNextKey:
    "Stage APP_MASTER_KEY_NEXT (canonical base64, 32 bytes) and restart the worker before retrying.",
  hintBlockedUploads:
    "Wait for in-flight uploads to finish, cancel or expire, then retry — new admissions are already blocked so it is just a wait.",
  hintPhaseConflict:
    "The rotation state does not allow this action — refresh the status and follow the displayed step.",
  hintAbortLate:
    "Envelopes were already rewritten — abort is no longer possible; complete the rotation or restore a backup.",
  hintVerifyRetry: "Run step to re-encrypt the failures, then verify again.",
  abortHint: "Only available while no envelope has been rewritten yet.",

  phase_idle: "Idle",
  phase_reencrypting: "Re-encrypting",
  phase_verifying: "Verifying",
  phase_verified: "Verified",
  phase_done: "Done",
  phase_failed: "Failed",
};
