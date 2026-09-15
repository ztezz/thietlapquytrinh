# Web Actions Recorder 2.3 — VBDLIS

## Sửa lỗi từ bản ghi VBDLIS thực tế

- Giữ các bước chọn/bỏ chọn jsTree có chủ ý. Phát lại đối chiếu các thuộc tính thực sự thay đổi (`checked`, `selected`, `expanded`), click đúng control ban đầu và kiểm tra từng thuộc tính.
- Cuộn chính modal không còn tìm modal lồng trong nó.
- ID có hậu tố UUID được chuyển thành selector theo tiền tố. Class `.jstree-<số>` được thay bằng cây trong đúng modal có nhãn node phù hợp; kết quả mơ hồ sẽ báo lỗi.
- Bản ghi mới lưu ngữ cảnh hàng cho nút/link tác vụ, chọn theo nội dung các ô thay vì số thứ tự hàng. Click trực tiếp `tr` cũng được quan sát trạng thái chọn.
- Dữ liệu định danh bị che có thể truyền vào khi chạy: `RECORDER_TREE_PATH_<bước>` là mảng JSON nhãn cha → con, `RECORDER_ROW_CELLS_<bước>` là mảng JSON nội dung từng ô. Giữ định dạng khoảng trắng đã chuẩn hóa và tối đa 500 ký tự mỗi ô như bản ghi. Không dùng chuỗi `[REDACTED...]` làm định danh thực.

Ví dụ PowerShell:

```powershell
$env:RECORDER_ROW_CELLS_6 = '["", "Nội dung thực đầy đủ của ô hồ sơ"]'
$env:RECORDER_TREE_PATH_17 = '["Nhãn GCN thực đầy đủ"]'
```

Các bước 6 và 17 chỉ là ví dụ từ bản ghi mẫu; dùng số bước trong file mới xuất. Có thể nhập lại JSON cũ để xuất lại với các sửa lỗi modal/jsTree/UUID và tham số dữ liệu che. Ngữ cảnh hàng/tác vụ mới cần ghi lại vì JSON cũ không chứa thông tin đó.

## Sử dụng

1. Thay nội dung userscript trong Tampermonkey bằng `web-actions-recorder.user.js`, lưu và tải lại VBDLIS. Chấp nhận quyền `unsafeWindow` nếu được hỏi (dùng để nghe sự kiện jQuery/Select2).
2. Điền domain VBDLIS trong cài đặt. Bấm **Phiên mới**, thao tác một hồ sơ mẫu, **Tạm dừng**, rồi xuất JSON và Playwright.
3. Chờ bảng/modal/thông báo hoàn tất khi thao tác mẫu. Ghi cả nút xác nhận và bước Lưu trước khi Tiếp tục.
4. Dùng nút **Tìm** để kiểm tra selector trên trang đang mở.

## Nội dung bổ sung

- jsTree: giữ nguyên target checkbox/nút mở/tên node; ghi cây, node ID, đường dẫn nhãn và trạng thái trước/sau (checked, selected, expanded, indeterminate).
- DataTables: ghi ô td, chỉ số cột, nội dung các ô và trạng thái chọn hàng. Link/nút thao tác trong hàng vẫn là click riêng.
- Modal: ghi selector và tiêu đề modal bao quanh phần tử.
- Select2: nghe thêm change/select/unselect/clear của jQuery khi truy cập được thư viện trang.
- Playwright: tìm node theo đường dẫn nhãn, mở cha nếu cần, chỉ click khi trạng thái khác trạng thái đã ghi và xác nhận kết quả. Hàng bảng phải khớp duy nhất toàn bộ nội dung ô; không tự chọn hàng đầu tiên nếu mơ hồ.
- Chờ: thêm nhịp nghỉ 700 ms, 2.500 ms cho các nút tra cứu/lưu/chọn/chuyển bước; sau đó chờ jQuery AJAX và các chỉ báo loading thông dụng với timeout 20 giây.

## Chạy Playwright

Trong thư mục dự án Playwright (Node.js, Playwright >= 1.51):

```powershell
npm install -D @playwright/test
npx playwright install chromium
npx playwright test web-actions.spec.js --headed
```

File xuất dùng fixture `page` thông thường. Cần cấu hình `storageState` đã đăng nhập cho dự án, hoặc tự điều chỉnh để kết nối trình duyệt CDP đang được mở với remote debugging. Recorder không tự chuyển cookie/phiên đăng nhập sang Playwright.

Giá trị đã che lấy từ biến môi trường, ví dụ:

```powershell
$env:RECORDER_VALUE_5 = 'giá trị thực của bước 5'
$env:RECORDER_FILE_12 = 'D:\ho-so\tai-lieu.pdf'
npx playwright test web-actions.spec.js --headed
```

## Phạm vi và kiểm chứng

Đây là công cụ ghi và sinh kịch bản một lượt thao tác. Chưa phải runner đọc Excel và xử lý hàng loạt. Muốn dùng cho nhiều hồ sơ, cần thay dữ liệu mẫu/định danh hàng/path node bằng biến của từng hồ sơ (đặc biệt số phát hành GCN, số thửa).

Không tự gọi hàm lưu nội bộ VBDLIS, không tự bấm mọi popup hay dọn modal ngoài kịch bản đã ghi. Chờ AJAX hoàn tất không phải bằng chứng lưu nghiệp vụ thành công; cần bổ sung assertion thông báo thành công cụ thể của trang sau khi có DOM thực tế.

Node trùng nhãn dưới cùng cha, hàng trùng dữ liệu, selector động không còn khớp, iframe lồng chưa xác định và node trung gian sẽ cần chỉnh kịch bản. Khi che dữ liệu làm thay đổi định danh widget, mã xuất dừng và yêu cầu bổ sung dữ liệu thay vì đoán phần tử.

Đã kiểm thử DOM giả lập; cần chạy thử một hồ sơ trên VBDLIS thực tế và kiểm tra kết quả lưu trước khi sử dụng rộng hơn.
