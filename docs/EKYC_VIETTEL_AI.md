# Tài liệu Kiến trúc, Tích hợp & Kiểm thử eKYC Viettel AI (Full Liveness 5 Tư Thế)

> **Phạm vi nghiệp vụ hiện tại (`verificationMethod = DOCUMENT_AND_LIVENESS`):**  
> Hệ thống kiểm tra giả mạo cặp ảnh CCCD (`id_pack_spoof_check`), bóc tách thông tin CCCD (`id_card`) và kiểm tra thực thể sống với đầy đủ 5 tư thế khuôn mặt (`face_liveness`: `Portrait`, `Left`, `Right`, `Top`, `Bottom`).  
> **Lưu ý giới hạn nghiệp vụ:** Quy trình này **không thực hiện đối sánh khuôn mặt với CCCD** (`faceMatchingVerified = null`) và **không đối chiếu với Cơ sở dữ liệu quốc gia về dân cư** (`cccdOwnershipVerified = false`). Các tài khoản lịch sử từng xác minh theo `DOCUMENT_AND_FACE_MATCH` vẫn được giữ nguyên toàn bộ metadata lịch sử.

---

## 1. Workflow & Ngân sách API

1. **Desktop (`/account`)** tạo `VerificationSession` → sinh mã QR nội bộ chuẩn ISO/IEC 18004 (hoặc mở luồng `DIRECT` nếu đang trên trình duyệt di động).
2. **Mobile (`/verify-identity`)** quét QR → claim phiên một lần duy nhất (atomic) → xóa ngay `?token=` khỏi URL → đồng ý xử lý dữ liệu cá nhân.
3. Chụp trực tiếp mặt trước & mặt sau CCCD bằng camera chính `1x` → Backend gọi tuần tự:
   - `POST /ekyc/id_pack_spoof_check` (`1` request)
   - `POST /ekyc/id_card` (`1` request — chỉ gọi khi Spoof Check trả `code = 1`)
4. Người dùng kiểm tra thông tin OCR chỉ đọc và xác nhận → Backend sinh thứ tự thử thách gồm **`Portrait` đầu tiên + 4 tư thế `Left`, `Right`, `Top`, `Bottom` trộn ngẫu nhiên bằng CSPRNG**.
5. Camera trước trên Mobile giữ kết nối xuyên suốt để thực hiện lần lượt `1/5` → `5/5` tư thế qua `POST /ekyc/face_liveness` (`5` request).
6. Chỉ khi **cả 5/5 tư thế đều đạt**, Backend mới lưu `IdentityProfile`, cập nhật `User.ekycStatus = 'verified'`, tính lại `TrustScore` (`+20`) và phát sự kiện Socket.IO `ekyc_session_updated` về Desktop.

**Tổng số lượt gọi Viettel AI lý tưởng cho 1 phiên thành công:** `1` (Spoof Check) + `1` (OCR) + `5` (Face Liveness) = **7 request** (0 request Face Matching).

---

## 2. Cấu hình Biến Môi Trường

```env
VIETTEL_AI_BASE_URL=https://viettelai.vn
VIETTEL_AI_TOKEN=<YOUR_VIETTEL_AI_TOKEN>
# Danh sách giá trị verify_result hợp lệ (phân tách dấu phẩy) sau khi xác nhận từ response thực tế của Viettel AI
VIETTEL_AI_LIVENESS_ACCEPTED_VALUES=
# Ngưỡng điểm Liveness tối thiểu [0..1] (tùy chọn, chỉ bật sau khi kiểm thử thực tế)
VIETTEL_AI_LIVENESS_MIN_SCORE=
# Tùy chọn header Cookie nếu môi trường Viettel AI yêu cầu
VIETTEL_AI_LIVENESS_COOKIE=
VIETTEL_AI_TIMEOUT_SECONDS=30

EKYC_SESSION_TTL_MINUTES=15
EKYC_LIVENESS_CONTINUITY_SECONDS=180
EKYC_MAX_DOCUMENT_ATTEMPTS=3
EKYC_MAX_LIVENESS_RETRIES=5
EKYC_POLICY_VERSION=2026.2-doc-liveness-5pose
EKYC_HMAC_SECRET=<64_HEX_RANDOM_SECRET>
EKYC_ENCRYPTION_KEY=<64_HEX_RANDOM_SECRET>
```

---

## 3. REST API Endpoints (`/api/ekyc`)

| Method | Endpoint | Mô tả |
|---|---|---|
| `GET` | `/api/ekyc/status` | Trạng thái xác minh tài khoản (`verificationMethod`, `livenessVerified`, `faceMatchingVerified`, `cccdOwnershipVerified`). |
| `POST` | `/api/ekyc/sessions` | Tạo phiên xác minh (`QR` hoặc `DIRECT`). |
| `POST` | `/api/ekyc/sessions/claim` | Đổi QR handoff token một lần lấy `X-Ekyc-Session-Token`. |
| `GET` | `/api/ekyc/sessions/:sessionId` | Lấy tiến trình phiên (bao gồm `livenessProgress` `1/5..5/5` cho Mobile). |
| `POST` | `/api/ekyc/sessions/:sessionId/consent` | Ghi nhận đồng ý xử lý dữ liệu cá nhân. |
| `POST` | `/api/ekyc/sessions/:sessionId/documents` | Kiểm tra giả mạo cặp CCCD + OCR (`frontImage`, `backImage`). |
| `POST` | `/api/ekyc/sessions/:sessionId/confirm-document` | Xác nhận OCR (`CONFIRM` sinh chuỗi 5 tư thế ngẫu nhiên; `RETAKE` chụp lại CCCD). |
| `POST` | `/api/ekyc/sessions/:sessionId/liveness` | `multipart/form-data` gồm `file` và `pose` (`Portrait`, `Left`, `Right`, `Top`, `Bottom`). Kiểm tra đúng thứ tự thử thách, chống replay khung hình trùng SHA-256 và giữ kết quả các tư thế đã đạt khi thử lại. |
| `POST` | `/api/ekyc/sessions/:sessionId/face` | Deprecated (`410 Gone`) — bước Face Matching đã ngừng sử dụng. |
| `POST` | `/api/ekyc/sessions/:sessionId/cancel` | Hủy phiên xác minh. |

---

## 4. Những điểm chưa được mô tả rõ trong tài liệu Viettel AI (Cần xác nhận khi kiểm thử thực tế)

1. **Giá trị cụ thể của `verify_result` trong `/ekyc/face_liveness`:**
   - Tài liệu khai báo kiểu `String` nhưng không liệt kê giá trị chuỗi khi đạt/không đạt.
   - Hiện tại `viettelAi.provider.js` hoạt động ở chế độ **fail-closed**: nếu `VIETTEL_AI_LIVENESS_ACCEPTED_VALUES` chưa cấu hình và API trả về một chuỗi chưa biết, hệ thống **không tự phê duyệt**, đồng thời ghi nhận giá trị literal (không chứa PII) vào log kỹ thuật để cấu hình chính xác vào `VIETTEL_AI_LIVENESS_ACCEPTED_VALUES`.
2. **Ngưỡng `score` của `/ekyc/face_liveness`:**
   - Tài liệu chỉ ghi `score` thuộc `[0–1]` mà không công bố ngưỡng khuyến nghị. Hệ thống kiểm tra `0 <= score <= 1` và cho phép cấu hình `VIETTEL_AI_LIVENESS_MIN_SCORE` sau khi đo đạc thực tế.
3. **Quy ước hướng `Left` / `Right` đối với ảnh selfie:**
   - Camera trước trên Mobile hiển thị dạng gương (`scaleX(-1)`) để người dùng dễ xoay đầu tự nhiên, trong khi ảnh gửi đi mặc định là khung hình gốc không lật của cảm biến. Nếu model Viettel AI quy ước `Left`/`Right` theo ảnh đã lật gương, có thể bật biến `REACT_APP_EKYC_MIRROR_LIVENESS=true` mà không cần sửa code.
4. **Header `Cookie` trong ví dụ cURL của Viettel AI:**
   - Ví dụ cURL có `Cookie: auth.strategy=local; i18n_redirected=vi` (thường do xuất tự động từ Postman của Nuxt/web portal). Mặc định không gửi header này; nếu môi trường thực tế yêu cầu có thể cấu hình qua `VIETTEL_AI_LIVENESS_COOKIE`.

---

## 5. Chạy Kiểm thử Tự động

```powershell
cd backend
npm test
```
