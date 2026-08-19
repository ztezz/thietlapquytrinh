// ==UserScript==
// @name         Web Actions Recorder
// @namespace    https://tampermonkey.net/
// @version      2.0.0
// @description  Ghi, quan ly, nhap va xuat kich ban thao tac web JSON.
// @match        http://*/*
// @match        https://*/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_KEY = '__web_actions_recorder_v1__';
    const INPUT_DELAY = 500;
    const SCROLL_DELAY = 400;
    const HOVER_DELAY = 800;
    const WAIT_THRESHOLD = 2000;
    const pendingInputs = new Map();
    let inputId = 0;
    let panelHost;
    let scrollTimer;
    let hoverTimer;
    let draggedTarget;
    let lastRecordedAt = 0;
    let applyingRemoteState = false;
    let state = loadState();

    function emptyState() {
        return {
            recording: false,
            steps: [],
            lastUrl: '',
            updatedAt: Date.now(),
            settings: { allowedHosts: [], maskSensitive: true, recordHover: false }
        };
    }

    function normalize(value) {
        if (!value || typeof value !== 'object') return null;
        return {
            recording: Boolean(value.recording),
            steps: Array.isArray(value.steps) ? value.steps : [],
            lastUrl: typeof value.lastUrl === 'string' ? value.lastUrl : '',
            updatedAt: Number(value.updatedAt) || 0,
            settings: {
                allowedHosts: Array.isArray(value.settings?.allowedHosts) ? value.settings.allowedHosts : [],
                maskSensitive: value.settings?.maskSensitive !== false,
                recordHover: Boolean(value.settings?.recordHover)
            }
        };
    }

    function loadState() {
        let local = null;
        let shared = null;
        try {
            local = normalize(JSON.parse(sessionStorage.getItem(STORAGE_KEY)));
        } catch (_) {
            // Ignore unavailable or invalid session storage.
        }
        try {
            shared = normalize(GM_getValue(STORAGE_KEY, null));
        } catch (_) {
            // sessionStorage still handles reloads in the current origin.
        }
        if (local && shared) return local.updatedAt >= shared.updatedAt ? local : shared;
        return local || shared || emptyState();
    }

    function saveState() {
        state.updatedAt = Date.now();
        try {
            sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (_) {
            // Continue with Tampermonkey storage if sessionStorage is blocked.
        }
        try {
            if (!applyingRemoteState) GM_setValue(STORAGE_KEY, state);
        } catch (_) {
            // The current-origin session remains usable without GM storage.
        }
        updatePanel();
        renderSteps();
    }

    function isHostAllowed() {
        const hosts = state.settings.allowedHosts;
        return !hosts.length || hosts.some((host) => location.hostname === host || location.hostname.endsWith(`.${host}`));
    }

    function addStep(action, target, value = null, extra = {}) {
        if (!state.recording || !isHostAllowed()) return;
        const now = Date.now();
        const previous = state.steps[state.steps.length - 1];
        const selector = target?.css_selector || '';
        if (previous && previous.action === action && previous.target?.css_selector === selector && JSON.stringify(previous.value) === JSON.stringify(value) && now - lastRecordedAt < 300) return;
        if (lastRecordedAt && now - lastRecordedAt >= WAIT_THRESHOLD && action !== 'wait') {
            state.steps.push({
                step: state.steps.length + 1,
                action: 'wait',
                target: null,
                value: now - lastRecordedAt,
                url: location.href,
                timestamp: new Date(now).toISOString(),
                frame: frameContext()
            });
        }
        state.steps.push({
            step: state.steps.length + 1,
            action,
            target,
            value,
            url: location.href,
            timestamp: new Date(now).toISOString(),
            frame: frameContext(),
            ...extra
        });
        lastRecordedAt = now;
        state.lastUrl = location.href;
        saveState();
    }

    function startRecording() {
        if (state.steps.length && !confirm('Bắt đầu phiên mới sẽ xóa các bước hiện tại. Tiếp tục?')) return;
        clearPendingInputs();
        const settings = state.settings;
        state = emptyState();
        state.settings = settings;
        state.recording = true;
        state.lastUrl = location.href;
        lastRecordedAt = 0;
        addStep('navigate', null);
    }

    function stopRecording() {
        flushPendingInputs();
        state.recording = false;
        saveState();
    }

    function recordNavigation() {
        if (window !== window.top || !state.recording || state.lastUrl === location.href) return;
        flushPendingInputs();
        addStep('navigate', null);
    }

    function isPanelEvent(event) {
        return panelHost && event.composedPath().includes(panelHost);
    }

    function eventElement(event) {
        return event.composedPath().find((item) => item instanceof Element && item !== panelHost) || event.target;
    }

    function actionableElement(target) {
        if (!(target instanceof Element)) return null;
        return target.closest('button, a, input, textarea, select, label, [role="button"], [role="link"], [onclick]') || target;
    }

    function handleClick(event) {
        if (!state.recording || isPanelEvent(event)) return;
        const element = actionableElement(eventElement(event));
        if (element) addStep('click', describeTarget(element));
    }

    function handleInput(event) {
        if (!state.recording || isPanelEvent(event)) return;
        const element = eventElement(event);
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element?.isContentEditable)) return;

        if (!element.dataset.webRecorderId) element.dataset.webRecorderId = String(++inputId);
        const key = element.dataset.webRecorderId;
        if (pendingInputs.has(key)) clearTimeout(pendingInputs.get(key).timer);
        const timer = setTimeout(() => {
            recordInput(element);
            pendingInputs.delete(key);
        }, INPUT_DELAY);
        pendingInputs.set(key, { element, timer });
    }

    function handleChange(event) {
        if (!state.recording || isPanelEvent(event)) return;
        const element = eventElement(event);
        if (element instanceof HTMLSelectElement) {
            const option = element.options[element.selectedIndex];
            addStep('select', describeTarget(element), element.value, {
                field_name: fieldName(element),
                option: { text: cleanText(option?.textContent), value: option?.value ?? element.value }
            });
            return;
        }
        if (element instanceof HTMLInputElement && element.type === 'file') {
            addStep('upload', describeTarget(element), Array.from(element.files || []).map((file) => ({ name: file.name, type: file.type, size: file.size })), { field_name: fieldName(element) });
        } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element?.isContentEditable) {
            cancelPendingInput(element);
            recordInput(element);
        }
    }

    function recordInput(element) {
        if (!state.recording || !element?.isConnected) return;
        let value;
        if (element instanceof HTMLInputElement && element.type === 'password') {
            value = '[REDACTED]';
        } else if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) {
            value = element.checked;
        } else if (element.isContentEditable) {
            value = cleanText(element.innerText || element.textContent);
        } else {
            value = element.value;
        }
        value = maskValue(element, value);
        addStep('input', describeTarget(element), value, { field_name: fieldName(element) });
    }

    function cancelPendingInput(element) {
        const pending = pendingInputs.get(element.dataset.webRecorderId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingInputs.delete(element.dataset.webRecorderId);
    }

    function flushPendingInputs() {
        for (const { element, timer } of pendingInputs.values()) {
            clearTimeout(timer);
            recordInput(element);
        }
        pendingInputs.clear();
    }

    function clearPendingInputs() {
        for (const { timer } of pendingInputs.values()) clearTimeout(timer);
        pendingInputs.clear();
    }

    function describeTarget(element) {
        if (!(element instanceof Element)) return null;
        return {
            tag: element.tagName,
            text: elementText(element),
            css_selector: shortestSelector(element),
            xpath: uniqueXPath(element),
            attributes: attributesOf(element),
            label: fieldName(element),
            shadow_path: shadowPath(element)
        };
    }

    function cleanText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    }

    function elementText(element) {
        if (element instanceof HTMLInputElement) {
            return cleanText(['button', 'submit', 'reset'].includes(element.type)
                ? element.value
                : element.getAttribute('aria-label') || element.placeholder);
        }
        if (element instanceof HTMLSelectElement) {
            return cleanText(element.options[element.selectedIndex]?.textContent);
        }
        if (element.isContentEditable && state.settings.maskSensitive) {
            return cleanText(element.getAttribute('aria-label') || fieldName(element));
        }
        return cleanText(element.innerText || element.textContent);
    }

    function attributesOf(element) {
        const result = {};
        const names = ['id', 'class', 'name', 'type', 'role', 'placeholder', 'title', 'aria-label', 'href'];
        for (const name of names) {
            if (element.hasAttribute(name)) result[name] = element.getAttribute(name);
        }
        for (const attribute of element.attributes) {
            if (attribute.name.startsWith('data-') && attribute.name !== 'data-web-recorder-id') {
                result[attribute.name] = attribute.value;
            }
        }
        return result;
    }

    function maskValue(element, value) {
        if (!state.settings.maskSensitive || typeof value !== 'string') return value;
        const hint = [element.type, element.name, element.id, element.placeholder, element.autocomplete, fieldName(element)].join(' ').toLowerCase();
        if (/password|passcode|otp|token|secret|api.?key|credit|card|cvv|cvc|security.?code/.test(hint)) return '[REDACTED]';
        if (/email/.test(hint) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return '[REDACTED_EMAIL]';
        if (/phone|mobile|tel/.test(hint)) return '[REDACTED_PHONE]';
        return value;
    }

    function frameContext() {
        if (window === window.top) return null;
        try {
            const frame = window.frameElement;
            return frame ? { css_selector: shortestSelector(frame), name: frame.name || '', src: frame.src || '' } : { url: location.href };
        } catch (_) {
            return { url: location.href, cross_origin: true };
        }
    }

    function shadowPath(element) {
        const path = [];
        let root = element.getRootNode();
        while (root instanceof ShadowRoot) {
            path.unshift(shortestSelector(root.host));
            root = root.host.getRootNode();
        }
        return path;
    }

    function fieldName(element) {
        if (!(element instanceof Element)) return '';
        const labels = element.labels ? Array.from(element.labels).map((label) => cleanText(label.textContent)).filter(Boolean) : [];
        if (labels.length) return labels.join(' / ');
        const parentLabel = element.closest('label');
        return cleanText(parentLabel?.textContent) || element.getAttribute('aria-label') || element.placeholder || element.name || element.id || '';
    }

    function cssEscape(value) {
        if (window.CSS?.escape) return CSS.escape(String(value));
        return String(value).replace(/(^-?\d)|[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
    }

    function attributeEscape(value) {
        return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    function isUniqueSelector(selector) {
        try {
            return document.querySelectorAll(selector).length === 1;
        } catch (_) {
            return false;
        }
    }

    function shortestSelector(element) {
        const tag = element.tagName.toLowerCase();
        const candidates = [];
        if (element.id) candidates.push(`#${cssEscape(element.id)}`);
        for (const name of ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label', 'placeholder']) {
            const value = element.getAttribute(name);
            if (value) {
                candidates.push(`[${name}="${attributeEscape(value)}"]`);
                candidates.push(`${tag}[${name}="${attributeEscape(value)}"]`);
            }
        }
        for (const className of Array.from(element.classList).slice(0, 5)) {
            candidates.push(`.${cssEscape(className)}`, `${tag}.${cssEscape(className)}`);
        }
        candidates.push(tag);
        const root = element.getRootNode();
        const uniqueInRoot = (selector) => {
            try { return root.querySelectorAll(selector).length === 1; } catch (_) { return false; }
        };
        const unique = [...new Set(candidates)].filter(uniqueInRoot).sort((a, b) => a.length - b.length)[0];
        return unique || cssPath(element);
    }

    function cssPath(element) {
        const parts = [];
        let current = element;
        while (current && current !== document.documentElement) {
            if (current.id) {
                const selector = `#${cssEscape(current.id)}`;
                if (isUniqueSelector(selector)) {
                    parts.unshift(selector);
                    return parts.join(' > ');
                }
            }
            let part = current.tagName.toLowerCase();
            const parent = current.parentElement;
            if (parent) {
                const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
                if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
            }
            parts.unshift(part);
            if (isUniqueSelector(parts.join(' > '))) return parts.join(' > ');
            current = parent;
        }
        return ['html', ...parts].join(' > ');
    }

    function xpathLiteral(value) {
        if (!value.includes("'")) return `'${value}'`;
        if (!value.includes('"')) return `"${value}"`;
        return `concat(${value.split("'").map((part) => `'${part}'`).join(', "\'", ')})`;
    }

    function uniqueXPath(element) {
        if (element.id) return `//${element.tagName.toLowerCase()}[@id=${xpathLiteral(element.id)}]`;
        const parts = [];
        let current = element;
        while (current?.nodeType === Node.ELEMENT_NODE) {
            const tag = current.tagName.toLowerCase();
            const siblings = current.parentElement
                ? Array.from(current.parentElement.children).filter((child) => child.tagName === current.tagName)
                : [current];
            parts.unshift(siblings.length > 1 ? `${tag}[${siblings.indexOf(current) + 1}]` : tag);
            current = current.parentElement;
        }
        return `/${parts.join('/')}`;
    }

    function handleKeydown(event) {
        if (!state.recording || isPanelEvent(event)) return;
        const keys = ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Backspace'];
        if (!keys.includes(event.key) && !(event.ctrlKey || event.metaKey || event.altKey)) return;
        addStep('keypress', describeTarget(actionableElement(eventElement(event))), event.key, {
            modifiers: { ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey }
        });
    }

    function handleScroll() {
        if (!state.recording || !isHostAllowed()) return;
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => addStep('scroll', null, { x: Math.round(scrollX), y: Math.round(scrollY) }), SCROLL_DELAY);
    }

    function handleMouseOver(event) {
        if (!state.recording || !state.settings.recordHover || isPanelEvent(event)) return;
        clearTimeout(hoverTimer);
        const element = actionableElement(eventElement(event));
        hoverTimer = setTimeout(() => element?.isConnected && addStep('hover', describeTarget(element)), HOVER_DELAY);
    }

    function handleMouseOut() {
        clearTimeout(hoverTimer);
    }

    function handleDragStart(event) {
        if (!state.recording || isPanelEvent(event)) return;
        draggedTarget = describeTarget(actionableElement(eventElement(event)));
    }

    function handleDrop(event) {
        if (!state.recording || isPanelEvent(event)) return;
        addStep('drag_drop', describeTarget(actionableElement(eventElement(event))), null, { source: draggedTarget });
        draggedTarget = null;
    }

    function renumberSteps() {
        state.steps.forEach((step, index) => { step.step = index + 1; });
    }

    function undoStep() {
        flushPendingInputs();
        state.steps.pop();
        renumberSteps();
        saveState();
        renderSteps();
    }

    function clearRecording() {
        if (!state.steps.length || !confirm('Xóa toàn bộ kịch bản đã ghi?')) return;
        clearPendingInputs();
        state.steps = [];
        state.lastUrl = location.href;
        lastRecordedAt = 0;
        saveState();
        renderSteps();
    }

    function deleteStep(index) {
        state.steps.splice(index, 1);
        renumberSteps();
        saveState();
        renderSteps();
    }

    function editStep(index) {
        const current = JSON.stringify(state.steps[index], null, 2);
        const edited = prompt('Sửa object JSON của bước:', current);
        if (edited === null) return;
        try {
            const parsed = JSON.parse(edited);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Bước phải là một object JSON.');
            state.steps[index] = parsed;
            renumberSteps();
            saveState();
            renderSteps();
        } catch (error) {
            alert(`JSON không hợp lệ: ${error.message}`);
        }
    }

    function importJson(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const parsed = JSON.parse(reader.result);
                const steps = Array.isArray(parsed) ? parsed : parsed.steps;
                if (!Array.isArray(steps)) throw new Error('Không tìm thấy mảng steps.');
                if (state.steps.length && !confirm('Thay thế các bước hiện tại bằng file đã nhập?')) return;
                state.steps = steps.filter((step) => step && typeof step === 'object');
                state.recording = true;
                state.lastUrl = location.href;
                lastRecordedAt = Date.now();
                renumberSteps();
                saveState();
                renderSteps();
                alert('Đã nhập kịch bản và tiếp tục ghi từ bước kế tiếp.');
            } catch (error) {
                alert(`Không thể nhập file: ${error.message}`);
            }
        };
        reader.readAsText(file);
    }

    function updateSettings() {
        const shadow = panelHost.shadowRoot;
        state.settings.allowedHosts = shadow.querySelector('.hosts').value.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
        state.settings.maskSensitive = shadow.querySelector('.mask').checked;
        state.settings.recordHover = shadow.querySelector('.hover').checked;
        saveState();
    }

    function downloadJson() {
        flushPendingInputs();
        const output = {
            name: 'Web Actions Record',
            schema_version: 2,
            exported_at: new Date().toISOString(),
            settings: state.settings,
            total_steps: state.steps.length,
            steps: state.steps
        };
        const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(output, null, 2)], { type: 'application/json;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = 'web_actions_record.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    }

    function createPanel() {
        if (panelHost || !document.body) return;
        panelHost = document.createElement('div');
        panelHost.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;font-family:Arial,sans-serif';
        const shadow = panelHost.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
            <style>
                *{box-sizing:border-box}.panel{width:310px;max-height:calc(100vh - 24px);display:flex;flex-direction:column;color:#f8fafc;background:#111827;border:1px solid #334155;border-radius:12px;overflow:hidden;box-shadow:0 14px 35px #0006;font:13px Arial,sans-serif;user-select:none}
                .header{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#1e293b;cursor:move;touch-action:none;font-weight:700}.status{font-size:11px;color:#cbd5e1;font-weight:400}.dot{display:inline-block;width:8px;height:8px;margin-right:5px;border-radius:50%;background:#64748b}.dot.on{background:#ef4444;box-shadow:0 0 0 4px #ef444433}
                .body{padding:12px;overflow:auto}.count{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;color:#cbd5e1}.count strong{color:white;font-size:18px}.buttons{display:grid;grid-template-columns:1fr 1fr;gap:7px}button{padding:8px;border:0;border-radius:7px;color:white;background:#475569;font:700 12px Arial,sans-serif;cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}.start{background:#16a34a}.stop{background:#dc2626}.download{background:#2563eb}.wide{grid-column:1/-1}
                details{margin-top:10px;border-top:1px solid #334155;padding-top:8px}summary{cursor:pointer;color:#cbd5e1}.settings{display:grid;gap:7px;margin-top:8px}.settings label{color:#cbd5e1;font-size:11px}.hosts{width:100%;margin-top:4px;padding:7px;color:#f8fafc;background:#0f172a;border:1px solid #475569;border-radius:6px}.check{display:flex;gap:7px;align-items:center}.check input{margin:0}
                .steps{max-height:210px;overflow:auto;margin-top:8px;display:grid;gap:5px}.step{display:grid;grid-template-columns:30px 1fr auto;gap:6px;align-items:center;padding:7px;background:#0f172a;border:1px solid #293548;border-radius:6px}.step-main{overflow:hidden}.step-action{font-weight:700;color:#93c5fd}.step-target{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#94a3b8;font-size:11px}.step-actions{display:flex;gap:3px}.step-actions button{padding:4px 6px;background:#334155;font-size:11px}.empty{color:#64748b;text-align:center;padding:10px}.hidden{display:none}
            </style>
            <div class="panel">
                <div class="header"><span>Web Actions Recorder</span><span class="status"><i class="dot"></i><span class="status-text"></span></span></div>
                <div class="body">
                    <div class="count"><span>Số bước đã ghi</span><strong>0</strong></div>
                    <div class="buttons">
                        <button class="start">Bắt đầu ghi</button><button class="stop">Dừng ghi</button>
                        <button class="undo">Hoàn tác bước cuối</button><button class="clear">Xóa dữ liệu</button>
                        <button class="download wide">Tải JSON kịch bản</button>
                        <button class="import wide">Nhập JSON và tiếp tục</button><input class="file hidden" type="file" accept="application/json,.json">
                    </div>
                    <details class="manager"><summary>Quản lý các bước</summary><div class="steps"></div></details>
                    <details class="options"><summary>Cài đặt ghi</summary>
                        <div class="settings">
                            <label>Domain cho phép, cách nhau bằng dấu phẩy<input class="hosts" placeholder="example.com, internal.test"></label>
                            <label class="check"><input class="mask" type="checkbox"> Che email, điện thoại, mật khẩu, token và thẻ</label>
                            <label class="check"><input class="hover" type="checkbox"> Ghi hover khi giữ chuột 0,8 giây</label>
                        </div>
                    </details>
                </div>
            </div>`;
        document.body.appendChild(panelHost);
        shadow.querySelector('.start').addEventListener('click', startRecording);
        shadow.querySelector('.stop').addEventListener('click', stopRecording);
        shadow.querySelector('.undo').addEventListener('click', undoStep);
        shadow.querySelector('.clear').addEventListener('click', clearRecording);
        shadow.querySelector('.download').addEventListener('click', downloadJson);
        const fileInput = shadow.querySelector('.file');
        shadow.querySelector('.import').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => { importJson(fileInput.files[0]); fileInput.value = ''; });
        shadow.querySelector('.hosts').addEventListener('change', updateSettings);
        shadow.querySelector('.mask').addEventListener('change', updateSettings);
        shadow.querySelector('.hover').addEventListener('change', updateSettings);
        enableDragging(shadow.querySelector('.header'));
        updatePanel();
        renderSteps();
    }

    function updatePanel() {
        const shadow = panelHost?.shadowRoot;
        if (!shadow) return;
        shadow.querySelector('.count strong').textContent = state.steps.length;
        shadow.querySelector('.status-text').textContent = state.recording ? 'Đang ghi' : 'Đã dừng';
        shadow.querySelector('.dot').classList.toggle('on', state.recording);
        shadow.querySelector('.start').disabled = state.recording;
        shadow.querySelector('.stop').disabled = !state.recording;
        shadow.querySelector('.undo').disabled = !state.steps.length;
        shadow.querySelector('.clear').disabled = !state.steps.length;
        shadow.querySelector('.hosts').value = state.settings.allowedHosts.join(', ');
        shadow.querySelector('.mask').checked = state.settings.maskSensitive;
        shadow.querySelector('.hover').checked = state.settings.recordHover;
        const allowed = isHostAllowed();
        shadow.querySelector('.status-text').textContent = !allowed ? 'Ngoài domain' : state.recording ? 'Đang ghi' : 'Đã dừng';
    }

    function renderSteps() {
        const container = panelHost?.shadowRoot.querySelector('.steps');
        if (!container) return;
        container.replaceChildren();
        if (!state.steps.length) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = 'Chưa có bước nào';
            container.appendChild(empty);
            return;
        }
        state.steps.forEach((step, index) => {
            const row = document.createElement('div');
            row.className = 'step';
            const number = document.createElement('span');
            number.textContent = `#${index + 1}`;
            const main = document.createElement('div');
            main.className = 'step-main';
            const action = document.createElement('div');
            action.className = 'step-action';
            action.textContent = step.action || 'unknown';
            const target = document.createElement('div');
            target.className = 'step-target';
            target.title = step.target?.css_selector || step.url || '';
            target.textContent = step.target?.text || step.target?.css_selector || String(step.value ?? step.url ?? '');
            main.append(action, target);
            const actions = document.createElement('div');
            actions.className = 'step-actions';
            const edit = document.createElement('button');
            edit.textContent = 'Sửa';
            edit.addEventListener('click', () => editStep(index));
            const remove = document.createElement('button');
            remove.textContent = 'Xóa';
            remove.addEventListener('click', () => deleteStep(index));
            actions.append(edit, remove);
            row.append(number, main, actions);
            container.appendChild(row);
        });
        container.scrollTop = container.scrollHeight;
    }

    function enableDragging(handle) {
        let offsetX = 0;
        let offsetY = 0;
        let dragging = false;
        handle.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            const rect = panelHost.getBoundingClientRect();
            dragging = true;
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;
            panelHost.style.right = 'auto';
            panelHost.style.bottom = 'auto';
            handle.setPointerCapture(event.pointerId);
        });
        handle.addEventListener('pointermove', (event) => {
            if (!dragging) return;
            const rect = panelHost.getBoundingClientRect();
            panelHost.style.left = `${Math.max(0, Math.min(innerWidth - rect.width, event.clientX - offsetX))}px`;
            panelHost.style.top = `${Math.max(0, Math.min(innerHeight - rect.height, event.clientY - offsetY))}px`;
        });
        for (const eventName of ['pointerup', 'pointercancel']) {
            handle.addEventListener(eventName, () => { dragging = false; });
        }
    }

    document.addEventListener('click', handleClick, true);
    document.addEventListener('input', handleInput, true);
    document.addEventListener('change', handleChange, true);
    document.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('mouseover', handleMouseOver, true);
    document.addEventListener('mouseout', handleMouseOut, true);
    document.addEventListener('dragstart', handleDragStart, true);
    document.addEventListener('drop', handleDrop, true);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('popstate', recordNavigation);
    window.addEventListener('hashchange', recordNavigation);
    window.addEventListener('beforeunload', flushPendingInputs);

    for (const method of ['pushState', 'replaceState']) {
        const original = history[method];
        history[method] = function (...args) {
            const result = original.apply(this, args);
            setTimeout(recordNavigation, 0);
            return result;
        };
    }

    setInterval(recordNavigation, 500);
    if (window === window.top && state.recording && state.lastUrl !== location.href) recordNavigation();

    try {
        GM_addValueChangeListener(STORAGE_KEY, (_name, _oldValue, newValue, remote) => {
            if (!remote) return;
            const incoming = normalize(newValue);
            if (!incoming || incoming.updatedAt <= state.updatedAt) return;
            applyingRemoteState = true;
            state = incoming;
            try {
                sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
            } catch (_) {
                // The synchronized GM state remains available.
            }
            updatePanel();
            renderSteps();
            applyingRemoteState = false;
        });
    } catch (_) {
        // Older userscript managers may not support cross-tab listeners.
    }

    if (window === window.top) {
        if (document.body) {
            createPanel();
        } else {
            document.addEventListener('DOMContentLoaded', createPanel, { once: true });
        }
    }
})();
