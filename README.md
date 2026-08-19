# Web Actions Recorder

Userscript dành cho Tampermonkey trên Chrome và Edge, dùng để ghi thao tác trên website và xuất thành kịch bản JSON. Dữ liệu được giữ qua reload, điều hướng SPA và chuyển domain.

## Tính năng

- Giao diện nổi ở góc màn hình, có thể kéo thả.
- Bắt đầu, dừng, xóa dữ liệu và hoàn tác bước cuối.
- Xem, sửa hoặc xóa từng bước trước khi xuất.
- Nhập lại JSON để xem, chỉnh sửa và tiếp tục ghi.
- Ghi `click`, `input`, `select`, `navigate`, `keypress`, `scroll`, `hover`, `drag_drop`, `upload` và thời gian chờ `wait`.
- Ghi trường `input`, `textarea` và phần tử `contenteditable`.
- Thu thập text, label, thuộc tính, CSS selector, XPath, đường dẫn Shadow DOM và thông tin iframe.
- Ưu tiên selector bền như `data-testid`, `data-test`, `data-cy`, `name`, `aria-label` và `placeholder`.
- Chống bước trùng trong khoảng thời gian ngắn.
- Lưu bằng `sessionStorage` và bộ nhớ Tampermonkey.
- Đồng bộ trạng thái giữa các tab khi trình quản lý userscript hỗ trợ.
- Có danh sách domain cho phép để giới hạn phạm vi ghi.
- Mặc định che mật khẩu, token, OTP, email, điện thoại và thông tin thẻ.

## Cài đặt

1. Cài Tampermonkey cho Chrome hoặc Edge.
2. Mở Tampermonkey Dashboard và chọn **Create a new script**.
3. Mở file `web-actions-recorder.user.js`, dán toàn bộ nội dung vào trình soạn thảo Tampermonkey.
4. Lưu bằng `Ctrl + S`.
5. Tải lại website cần thao tác.

Userscript dùng `@match http://*/*` và `@match https://*/*`, do đó Tampermonkey sẽ yêu cầu quyền chạy trên các website. Có thể giới hạn quyền website trong phần cài đặt tiện ích của trình duyệt hoặc dùng mục **Domain cho phép** trên bảng điều khiển.

## Sử dụng

1. Nhấn **Bắt đầu ghi**. Nếu đang có dữ liệu, recorder sẽ hỏi trước khi xóa phiên cũ.
2. Thực hiện các thao tác trên website.
3. Nhấn **Dừng ghi** khi hoàn tất.
4. Mở **Quản lý các bước** để sửa hoặc xóa từng bước nếu cần.
5. Nhấn **Tải JSON kịch bản** để tải `web_actions_record.json`.

Nút **Nhập JSON và tiếp tục** chấp nhận cả object có thuộc tính `steps` và một mảng bước JSON trực tiếp. Sau khi nhập thành công, recorder tự chuyển sang trạng thái ghi và bước tiếp theo được nối vào cuối danh sách. Nhấn **Dừng ghi** ngay nếu chỉ muốn xem hoặc chỉnh sửa file đã nhập.

## Cài đặt ghi

- **Domain cho phép**: nhập hostname cách nhau bằng dấu phẩy, ví dụ `example.com, internal.test`. Subdomain cũng được chấp nhận. Để trống để cho phép mọi domain phù hợp với metadata.
- **Che dữ liệu nhạy cảm**: thay giá trị nhạy cảm bằng các chuỗi như `[REDACTED]`, `[REDACTED_EMAIL]` hoặc `[REDACTED_PHONE]`.
- **Ghi hover**: chỉ ghi khi con trỏ giữ trên mục tiêu khoảng 0,8 giây để hạn chế nhiễu.

Không nên tắt che dữ liệu nhạy cảm khi kịch bản được chia sẻ hoặc đưa vào Git.

## Định dạng JSON

```json
{
  "name": "Web Actions Record",
  "schema_version": 2,
  "exported_at": "2026-08-19T10:00:00.000Z",
  "settings": {
    "allowedHosts": [],
    "maskSensitive": true,
    "recordHover": false
  },
  "total_steps": 2,
  "steps": [
    {
      "step": 1,
      "action": "click",
      "target": {
        "tag": "BUTTON",
        "text": "Đăng ký ngay",
        "css_selector": "#register-btn",
        "xpath": "//button[@id='register-btn']",
        "attributes": {
          "id": "register-btn"
        },
        "label": "Đăng ký ngay",
        "shadow_path": []
      },
      "value": null,
      "url": "https://example.com/register",
      "timestamp": "2026-08-19T10:00:01.000Z",
      "frame": null
    }
  ]
}
```

Các action bổ sung có dữ liệu riêng:

| Action | `value` hoặc dữ liệu bổ sung |
| --- | --- |
| `input` | Nội dung nhập và `field_name` |
| `select` | Giá trị, `field_name`, `option.text`, `option.value` |
| `keypress` | Tên phím và `modifiers` |
| `scroll` | Object `{ "x": ..., "y": ... }` |
| `wait` | Thời gian chờ tính bằng mili giây |
| `upload` | Danh sách tên, MIME type và kích thước file; không lưu nội dung file |
| `drag_drop` | Target đích và thuộc tính `source` |

## Lưu trữ và khôi phục

- `sessionStorage` giữ dữ liệu khi reload hoặc điều hướng trong cùng origin và cùng tab.
- `GM_setValue` giữ dữ liệu khi chuyển origin/domain và cho phép đồng bộ giữa các tab.
- File JSON chỉ được tạo khi nhấn nút tải xuống.
- Nhấn **Xóa dữ liệu** sẽ xóa danh sách bước trong trạng thái đang dùng.

## Giới hạn

- Trình duyệt không cho userscript đọc nội dung bên trong iframe khác origin từ trang cha. Tampermonkey có thể chạy một instance riêng trong iframe nếu quyền và `@match` cho phép; trường `frame` được ghi để hỗ trợ nhận diện ngữ cảnh.
- Open Shadow DOM được nhận diện qua `composedPath()` và `shadow_path`. Closed Shadow DOM không thể được truy cập do giới hạn nền tảng web.
- Canvas, WebGL, bản đồ và các ứng dụng stream hình ảnh không cung cấp DOM mục tiêu chi tiết; recorder chỉ có thể ghi sự kiện trên phần tử canvas ngoài cùng.
- Upload chỉ ghi metadata file, không ghi đường dẫn cục bộ hoặc nội dung file vì lý do bảo mật.
- CSS selector và XPath có thể mất hiệu lực nếu website dùng ID/class sinh ngẫu nhiên hoặc thay đổi DOM sau mỗi lần tải.
- Việc phát lại không nằm trong userscript này. JSON có thể được chuyển đổi cho Playwright, Selenium hoặc công cụ tự động hóa khác.
- Một số website dùng CSP nghiêm ngặt, sự kiện tổng hợp hoặc chặn userscript có thể làm giảm phạm vi ghi.

## Phát triển

Kiểm tra cú pháp JavaScript:

```powershell
node --check "web-actions-recorder.user.js"
```

Kiểm tra lỗi whitespace trong Git:

```powershell
git diff --check
```
