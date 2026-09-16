# Web Actions Recorder 2.5

## Quy trình sử dụng

1. Cập nhật `web-actions-recorder.user.js` trong Tampermonkey, tải lại trang.
2. Ghi thao tác, tạm dừng và mở **Quản lý các bước**.
3. Bấm **Biến** trên bước nhập/chọn/checkbox/upload để đặt tên như `MA_HO_SO`.
4. Bấm **Kiểm tra kịch bản** để xem lỗi cấu trúc và các biến bắt buộc.
5. Xuất Playwright. Lỗi cấu trúc sẽ chặn xuất và chỉ rõ số bước cần sửa.

Kiểm tra trước xuất không truy cập môi trường chạy Playwright và không biết biến môi trường đã được cấp hay chưa. Danh sách biến là yêu cầu để chuẩn bị trước khi chạy; không phải xác nhận dữ liệu hợp lệ trên VBDLIS.

## Biến có tên

Tên gồm chữ Latin, số, dấu `_`, không bắt đầu bằng số. Gán cùng tên cho nhiều bước để dùng chung dữ liệu. Tên được lưu trong JSON bằng thuộc tính `variable`.

PowerShell:

```powershell
$env:MA_HO_SO = 'HS-2026-001'
$env:DA_CHON = 'true'
$env:DON_VI = 'dv01'
$env:DON_VI_OPTIONS = '[{"value":"dv01","text":"Đơn vị 01"}]'
$env:NHIEU_GIA_TRI = '["a","b"]'
$env:TAI_LIEU = 'D:\TaiLieu\hoso.pdf|D:\TaiLieu\phuluc.pdf'
npx playwright test web-actions.spec.js --reporter=html
```

- Input và select đơn: chuỗi.
- Checkbox: JSON `true` hoặc `false`.
- Select nhiều lựa chọn: mảng chuỗi JSON.
- Upload: đường dẫn file, ngăn cách bằng `|` khi có nhiều file.
- Select2 AJAX: khi đổi giá trị sang mục chưa có sẵn, cấp thêm `<TÊN_BIẾN>_OPTIONS`, mảng `{value,text}` mô tả các mục mới.
- Bỏ tên biến bằng nút **Biến**, xóa nội dung và xác nhận.
- Các bước cũ vẫn hỗ trợ `RECORDER_VALUE_<số bước>`, cùng các biến file, nội dung hàng và đường dẫn cây được liệt kê khi kiểm tra.

## Báo cáo lỗi

Mỗi thao tác xuất thành `test.step` có số bước, action và tên biến nếu có. Khi thất bại, Playwright giữ trace, chụp ảnh theo cơ chế tích hợp và đính kèm JSON `recorder-failure` với trạng thái/lỗi/stack.

```powershell
npx playwright show-report
```

Dùng Playwright hiện hành (ít nhất 1.51 do locator sử dụng `filter({ visible: true })`). Cài `@playwright/test` và trình duyệt Playwright trong dự án chạy trước khi thực thi. Trace và ảnh có thể chứa nội dung hồ sơ đang hiển thị.

## Phạm vi

Phiên bản này bổ sung kiểm tra cấu trúc, biến có tên và chẩn đoán lỗi. Khóa nghiệp vụ của bảng, phân trang, popup và điều kiện thành công riêng của từng quy trình vẫn cần tích hợp dựa trên giao diện VBDLIS thực tế.

Kiểm tra mã nguồn tại thư mục script:

```powershell
node --check web-actions-recorder.user.js
node web-actions-recorder.test.cjs
```
