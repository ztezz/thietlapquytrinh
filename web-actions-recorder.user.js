// ==UserScript==
// @name         Web Actions Recorder
// @namespace    https://tampermonkey.net/
// @version      2.3.0
// @description  Ghi thao tac theo tab, tam dung/tiep tuc, kiem tra selector, xuat JSON va Playwright.
// @match        http://*/*
// @match        https://*/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_getTab
// @grant        GM_saveTab
// @grant        unsafeWindow
// ==/UserScript==

(async function () {
    'use strict';

    const LEGACY_KEY = '__web_actions_recorder_v1__';
    const ACTIONS = new Set(['navigate', 'wait', 'click', 'dblclick', 'input', 'check', 'select', 'upload', 'keypress', 'scroll', 'hover', 'drag_drop', 'submit']);
    const IS_TOP = window === window.top;
    const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    let tabId = '';
    if (IS_TOP) {
        try {
            const tab = await new Promise((resolve) => GM_getTab(resolve));
            tabId = tab.webRecorderTabId || uid();
            GM_saveTab({ ...tab, webRecorderTabId: tabId });
        } catch (_) {
            try {
                tabId = sessionStorage.getItem('__web_recorder_tab__') || uid();
                sessionStorage.setItem('__web_recorder_tab__', tabId);
            } catch (_) { tabId = uid(); }
        }
    }
    const STORAGE_KEY = `${LEGACY_KEY}:${tabId}`;
    const UI_KEY = '__web_recorder_ui_v2__';
    const CHANNEL = '__web_recorder_frames_v2__';
    const frames = new Map();
    const seenEvents = new Set();
    let frameSession = '';
    let storageTimer;
    let storageError = '';
    let pendingScroll = null;
    let renderedRevision = -1;
    let revision = 0;
    let ui = {};
    try { ui = GM_getValue(UI_KEY, {}) || {}; } catch (_) {}
    const INPUT_DELAY = 500;
    const SCROLL_DELAY = 400;
    const HOVER_DELAY = 800;
    const WAIT_THRESHOLD = 2000;
    const pendingInputs = new Map();
    const pendingWidgets = new Set();
    const selectValues = new WeakMap();
    let panelHost;
    let scrollTimer;
    let hoverTimer;
    let draggedTarget;
    let lastRecordedAt = 0;
    let applyingRemoteState = false;
    let state = IS_TOP ? loadState() : emptyState();

    function emptyState() {
        return {
            recording: false,
            sessionId: uid(),
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
            sessionId: typeof value.sessionId === 'string' ? value.sessionId : uid(),
            steps: Array.isArray(value.steps) ? value.steps.filter(validStep) : [],
            lastUrl: typeof value.lastUrl === 'string' ? value.lastUrl : '',
            updatedAt: Number(value.updatedAt) || 0,
            settings: {
                allowedHosts: Array.isArray(value.settings?.allowedHosts) ? value.settings.allowedHosts.filter((host) => typeof host === 'string') : [],
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
        if (local || shared) return local || shared;
        // Old recordings are migrated paused; another tab never joins them automatically.
        try {
            const legacy = normalize(GM_getValue(LEGACY_KEY, null));
            if (legacy) return { ...legacy, recording: false, sessionId: uid() };
        } catch (_) {}
        return emptyState();
    }

    function saveState() {
        state.updatedAt = Date.now();
        revision += 1;
        if (!IS_TOP) return;
        clearTimeout(storageTimer);
        storageTimer = setTimeout(persistState, 150);
        updatePanel();
        renderSteps();
        broadcastState();
    }

    function persistState() {
        if (!IS_TOP) return;
        clearTimeout(storageTimer);
        let saved = false;
        try {
            sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
            saved = true;
        } catch (_) {
            // Continue with Tampermonkey storage if sessionStorage is blocked.
        }
        try {
            if (!applyingRemoteState) GM_setValue(STORAGE_KEY, state);
            saved = true;
        } catch (_) {
            // The current-origin session remains usable without GM storage.
        }
        storageError = saved ? '' : 'Không lưu được dữ liệu — hãy tải JSON.';
        updatePanel();
    }

    function isHostAllowed(hostname = location.hostname) {
        const hosts = state.settings.allowedHosts;
        return !hosts.length || hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
    }

    function addStep(action, target, value = null, extra = {}) {
        if (!state.recording || !isHostAllowed()) return;
        const now = Date.now();
        const step = sanitizeStep({ id: uid(), action, target, value, url: location.href,
            timestamp: new Date(now).toISOString(), frame: frameContext(), ...extra });
        if (!IS_TOP) {
            window.top.postMessage({ channel: CHANNEL, type: 'step', sessionId: frameSession, step }, '*');
            return;
        }
        appendStep(step);
    }

    function appendStep(step) {
        const now = Date.parse(step.timestamp) || Date.now();
        if (seenEvents.has(step.id)) return;
        seenEvents.add(step.id);
        if (seenEvents.size > 10000) seenEvents.delete(seenEvents.values().next().value);
        if (lastRecordedAt && now - lastRecordedAt >= WAIT_THRESHOLD && step.action !== 'wait') {
            state.steps.push({
                id: uid(),
                step: state.steps.length + 1,
                action: 'wait',
                target: null,
                value: now - lastRecordedAt,
                url: step.url,
                timestamp: new Date(now).toISOString(),
                frame: step.frame
            });
        }
        state.steps.push({ ...step, step: state.steps.length + 1 });
        lastRecordedAt = Math.max(lastRecordedAt, now);
        if (step.action === 'navigate' && !step.frame) state.lastUrl = location.href;
        saveState();
    }

    function startRecording() {
        if (!isHostAllowed()) { alert('Trang hiện tại nằm ngoài domain cho phép. Hãy sửa cài đặt trước.'); return; }
        if (state.steps.length && !confirm('Bắt đầu phiên mới sẽ xóa các bước hiện tại. Tiếp tục?')) return;
        clearTransient();
        const settings = state.settings;
        state = emptyState();
        state.settings = settings;
        state.recording = true;
        state.lastUrl = location.href;
        lastRecordedAt = 0;
        addStep('navigate', null);
        persistState();
    }

    async function stopRecording() {
        await flushAllFrames();
        flushAllPending();
        state.recording = false;
        clearTransient();
        saveState();
        persistState();
    }

    function resumeRecording() {
        if (!isHostAllowed()) { alert('Trang hiện tại nằm ngoài domain cho phép.'); return; }
        clearTransient();
        lastRecordedAt = 0;
        state.recording = true;
        if (state.lastUrl !== location.href || !state.steps.length) addStep('navigate', null);
        else saveState();
        persistState();
    }

    function recordNavigation() {
        if (window !== window.top || !state.recording || state.lastUrl === location.href) return;
        flushAllPending();
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
        const widget = target.closest('.jstree-checkbox, .jstree-ocl, .jstree-anchor');
        if (widget) return widget;
        return target.closest('button, a, input, textarea, select, label, [role="button"], [role="link"], [onclick]') || target;
    }

    function widgetState(element, kind) {
        if (kind === 'table') {
            const row = element.closest('tr');
            return { selected: row.classList.contains('selected') || row.getAttribute('aria-selected') === 'true' };
        }
        const node = element.closest('.jstree-node');
        const anchor = node?.querySelector(':scope > .jstree-anchor');
        return {
            checked: node?.getAttribute('aria-checked') === 'true' || Boolean(anchor?.classList.contains('jstree-checked')),
            indeterminate: node?.getAttribute('aria-checked') === 'mixed' || Boolean(anchor?.querySelector('.jstree-undetermined')),
            selected: node?.getAttribute('aria-selected') === 'true' || Boolean(anchor?.classList.contains('jstree-clicked')),
            expanded: node?.getAttribute('aria-expanded') === 'true' || Boolean(node?.classList.contains('jstree-open'))
        };
    }

    function widgetContext(element) {
        const node = element.closest('.jstree-node');
        if (node) {
            const tree = node.closest('.jstree');
            const path = [];
            let parent = node;
            while (parent?.classList.contains('jstree-node')) {
                path.unshift(cleanText(parent.querySelector(':scope > .jstree-anchor')?.textContent));
                parent = parent.parentElement?.closest('.jstree-node');
            }
            return { kind: 'tree', node_id: node.id, tree_selector: tree ? shortestSelector(tree) : null,
                node_selector: shortestSelector(node), path,
                control: element.closest('.jstree-checkbox') ? 'checkbox' : element.closest('.jstree-ocl') ? 'expand' : 'select' };
        }
        const row = element.closest('tr');
        const cell = element.closest('td') || row?.cells?.[1] || row?.cells?.[0];
        const table = cell?.closest('table');
        if (table && !element.closest('button, a, input, select, textarea, [role="button"]') && (table.classList.contains('dataTable') || table.closest('.dataTables_wrapper') || /^tbl/.test(table.id))) {
            return { kind: 'table', table_selector: shortestSelector(table), row_selector: shortestSelector(cell.parentElement),
                row_id: cell.parentElement.id, cell_index: cell.cellIndex,
                cells: Array.from(cell.parentElement.cells, (item) => cleanText(item.textContent)) };
        }
        return null;
    }

    function flushWidgets() {
        for (const pending of Array.from(pendingWidgets)) pending.finish();
    }

    function recordWidgetClick(element, event) {
        const context = widgetContext(element);
        if (!context) return false;
        const before = widgetState(element, context.kind);
        const target = describeTarget(element);
        const sessionId = state.sessionId;
        const timestamp = new Date().toISOString();
        const pending = { finish: () => {
            clearTimeout(pending.timer);
            clearTimeout(pending.deadline);
            pending.observer.disconnect();
            pendingWidgets.delete(pending);
            if (sessionId !== state.sessionId || !state.recording) return;
            const after = element.isConnected ? widgetState(element, context.kind) : null;
            addStep('click', target, null, { timestamp, click_count: event.detail || 1,
                widget: context.kind === 'table' && after && before.selected === after.selected ? null : { ...context, before, after },
                modifiers: { ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey } });
        } };
        pending.observer = new MutationObserver(() => {
            clearTimeout(pending.timer);
            pending.timer = setTimeout(pending.finish, 80);
        });
        pending.observer.observe(element.closest(context.kind === 'tree' ? '.jstree-node' : 'tr'), { attributes: true, subtree: true, childList: true });
        pending.timer = setTimeout(pending.finish, 400);
        pending.deadline = setTimeout(pending.finish, 2000);
        pendingWidgets.add(pending);
        return true;
    }

    function handleClick(event) {
        if (!state.recording || isPanelEvent(event)) return;
        flushWidgets();
        flushPendingInputs();
        const element = actionableElement(eventElement(event));
        if (element && recordWidgetClick(element, event)) return;
        if (element) addStep('click', describeTarget(element), null, { click_count: event.detail || 1,
            modifiers: { ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey } });
    }

    function handleInput(event) {
        if (!state.recording || isPanelEvent(event)) return;
        flushWidgets();
        const element = eventElement(event);
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element?.isContentEditable)) return;
        if (element instanceof HTMLInputElement && ['file', 'checkbox', 'radio'].includes(element.type)) return;
        const key = element;
        if (pendingInputs.has(key)) clearTimeout(pendingInputs.get(key).timer);
        const timer = setTimeout(() => {
            recordInput(element, pendingInputs.get(key)?.snapshot);
            pendingInputs.delete(key);
        }, INPUT_DELAY);
        pendingInputs.set(key, { element, timer, snapshot: inputSnapshot(element) });
    }

    function handleChange(event) {
        if (!state.recording || isPanelEvent(event)) return;
        flushWidgets();
        const element = eventElement(event);
        if (element instanceof HTMLSelectElement) {
            const signature = JSON.stringify([state.sessionId, Array.from(element.selectedOptions, item => item.value)]);
            if (selectValues.get(element) === signature) return;
            selectValues.set(element, signature);
            const option = element.options[element.selectedIndex];
            flushPendingInputs();
            addStep('select', describeTarget(element), element.multiple ? Array.from(element.selectedOptions, (item) => item.value) : element.value, {
                field_name: fieldName(element),
                option: { text: cleanText(option?.textContent), value: option?.value ?? element.value }
            });
            return;
        }
        if (element instanceof HTMLInputElement && element.type === 'file') {
            flushPendingInputs();
            addStep('upload', describeTarget(element), Array.from(element.files || []).map((file) => ({ name: file.name, type: file.type, size: file.size })), { field_name: fieldName(element) });
        } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element?.isContentEditable) {
            cancelPendingInput(element);
            recordInput(element);
        }
    }

    function inputSnapshot(element) {
        let value;
        if (element instanceof HTMLInputElement && element.type === 'password') {
            value = '[REDACTED]';
        } else if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) {
            value = element.checked;
        } else if (element.isContentEditable) {
            value = element.innerText ?? element.textContent ?? '';
        } else {
            value = element.value;
        }
        value = maskValue(element, value);
        return { target: describeTarget(element), value, field_name: fieldName(element),
            action: element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type) ? 'check' : 'input' };
    }

    function recordInput(element, snapshot = inputSnapshot(element)) {
        if (!state.recording) return;
        addStep(snapshot.action, snapshot.target, snapshot.value, { field_name: snapshot.field_name });
    }

    function cancelPendingInput(element) {
        const pending = pendingInputs.get(element);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingInputs.delete(element);
    }

    function flushPendingInputs() {
        for (const { element, timer, snapshot } of pendingInputs.values()) {
            clearTimeout(timer);
            recordInput(element, snapshot);
        }
        pendingInputs.clear();
    }

    function clearPendingInputs() {
        for (const { timer } of pendingInputs.values()) clearTimeout(timer);
        pendingInputs.clear();
    }

    function flushAllPending() {
        flushWidgets();
        flushPendingInputs();
        clearTimeout(scrollTimer);
        if (pendingScroll) {
            const { target, value } = pendingScroll;
            pendingScroll = null;
            addStep('scroll', target, value);
        }
    }

    function clearTransient() {
        for (const pending of pendingWidgets) { clearTimeout(pending.timer); clearTimeout(pending.deadline); pending.observer.disconnect(); }
        pendingWidgets.clear();
        clearPendingInputs();
        clearTimeout(scrollTimer);
        clearTimeout(hoverTimer);
        pendingScroll = null;
        draggedTarget = null;
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
            shadow_path: shadowPath(element),
            modal: modalContext(element),
            table_context: tableTargetContext(element)
        };
    }

    function modalContext(element) {
        const modal = element.closest('.modal, [role="dialog"], .bootbox, .swal2-popup');
        return modal ? { css_selector: shortestSelector(modal), title: cleanText(modal.querySelector('.modal-title, .swal2-title, [role="heading"]')?.textContent) } : null;
    }

    function tableTargetContext(element) {
        const row = element.closest('tbody > tr');
        const table = row?.closest('table');
        if (!table) return null;
        const cell = element.closest('td');
        const link = element.closest('a, button');
        return { table_selector: shortestSelector(table), cells: Array.from(row.cells, item => cleanText(item.textContent)),
            cell_index: cell?.cellIndex ?? 0, control: link ? link.tagName.toLowerCase() : null,
            control_text: link ? cleanText(link.textContent) : null };
    }

    function stableSelector(selector) {
        return String(selector).replace(/#([\w-]*?)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
            (_, prefix) => `[id^="${prefix}-"]`);
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
            if (['data-testid', 'data-test', 'data-cy'].includes(attribute.name)) {
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

    function validStep(step) {
        if (!step || typeof step !== 'object' || Array.isArray(step) || !ACTIONS.has(step.action)) return false;
        if (step.target != null && (typeof step.target !== 'object' || Array.isArray(step.target))) return false;
        if (step.target?.css_selector != null && typeof step.target.css_selector !== 'string') return false;
        if (step.widget != null) {
            const widget = step.widget;
            if (!widget || !['tree', 'table'].includes(widget.kind)) return false;
            if (widget.kind === 'tree' && (!['checkbox', 'expand', 'select'].includes(widget.control) || !Array.isArray(widget.path) || !widget.path.every((s) => typeof s === 'string'))) return false;
            if (widget.kind === 'table' && (!Array.isArray(widget.cells) || !widget.cells.every((s) => typeof s === 'string') || !Number.isInteger(widget.cell_index) || widget.cell_index < 0)) return false;
            if (widget.after != null && (typeof widget.after !== 'object' || Object.values(widget.after).some((v) => typeof v !== 'boolean'))) return false;
        }
        if (step.target?.shadow_path != null && (!Array.isArray(step.target.shadow_path) || !step.target.shadow_path.every((part) => typeof part === 'string'))) return false;
        if (step.url != null && typeof step.url !== 'string') return false;
        if (step.action === 'wait' && (!Number.isFinite(step.value) || step.value < 0)) return false;
        if (step.action === 'input' && !['string', 'boolean'].includes(typeof step.value)) return false;
        if (step.action === 'check' && typeof step.value !== 'boolean') return false;
        if (step.action === 'select' && !(typeof step.value === 'string' || Array.isArray(step.value) && step.value.every((v) => typeof v === 'string'))) return false;
        if (step.action === 'scroll' && (!Number.isFinite(step.value?.x) || !Number.isFinite(step.value?.y))) return false;
        if (step.action === 'keypress' && typeof step.value !== 'string') return false;
        if (step.action === 'upload' && (!Array.isArray(step.value) || !step.value.every((v) => v && typeof v.name === 'string'))) return false;
        return true;
    }

    function redactText(value) {
        return String(value).replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[REDACTED_EMAIL]')
            .replace(/\b(?:\d[ ()-]?){9,19}\b/g, '[REDACTED_NUMBER]')
            .replace(/\b(Bearer\s+)[\w.\-]+/gi, '$1[REDACTED]')
            .replace(/((?:password|passcode|otp|token|secret|api[_-]?key|cvv|cvc)\s*[=:]\s*)[^\s&"'<>]+/gi, '$1[REDACTED]');
    }

    function safeUrl(value) {
        try {
            const url = new URL(value, location.href);
            url.username = '';
            url.password = '';
            for (const [key, item] of Array.from(url.searchParams)) {
                const clean = /password|passcode|otp|token|secret|key|auth|email|phone|mobile|card|cvv|cvc/i.test(key) ? '[REDACTED]' : redactText(item);
                if (clean !== item) url.searchParams.set(key, clean);
            }
            url.hash = redactText(decodeURIComponent(url.hash));
            return redactText(url.href);
        } catch (_) { return redactText(value); }
    }

    function sanitizeStep(step) {
        if (!state.settings.maskSensitive) return step;
        const walk = (value, key = '') => {
            if (typeof value === 'string') return ['url', 'href', 'src'].includes(key) ? safeUrl(value) : redactText(value);
            if (Array.isArray(value)) return value.map((item) => walk(item));
            if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name,
                /^(password|passcode|otp|token|secret|api[_-]?key|cvv|cvc)$/i.test(name) ? '[REDACTED]' : walk(item, name)]));
            return value;
        };
        const clean = walk(step);
        if (clean.target?.attributes) {
            for (const name of Object.keys(clean.target.attributes)) {
                if (name.startsWith('data-') && !['data-testid', 'data-test', 'data-cy'].includes(name)) delete clean.target.attributes[name];
            }
        }
        const hint = JSON.stringify({ field: step.field_name, attributes: step.target?.attributes, label: step.target?.label });
        if (/password|passcode|otp|token|secret|api.?key|credit|card|cvv|cvc|email|phone|mobile/i.test(hint)) {
            if (['input', 'select'].includes(step.action)) clean.value = Array.isArray(step.value) ? step.value.map(() => '[REDACTED]') : '[REDACTED]';
            if (clean.target) clean.target.text = '[REDACTED]';
            if (clean.option) clean.option = { text: '[REDACTED]', value: '[REDACTED]' };
        }
        return clean;
    }

    function frameState() {
        return { recording: state.recording, sessionId: state.sessionId, settings: state.settings };
    }

    function broadcastState() {
        for (const [source, info] of frames) {
            try { source.postMessage({ channel: CHANNEL, type: 'state', state: frameState() }, info.origin === 'null' ? '*' : info.origin); }
            catch (_) { frames.delete(source); }
        }
    }

    const flushRequests = new Map();
    function flushAllFrames() {
        if (!IS_TOP || !frames.size) return Promise.resolve();
        const requestId = uid();
        return new Promise((resolve) => {
            const pending = new Set(frames.keys());
            const finish = () => { clearTimeout(timer); flushRequests.delete(requestId); resolve(); };
            const timer = setTimeout(finish, 500);
            flushRequests.set(requestId, { pending, finish });
            for (const source of pending) source.postMessage({ channel: CHANNEL, type: 'flush', requestId }, '*');
        });
    }

    window.addEventListener('message', (event) => {
        const data = event.data;
        if (!data || data.channel !== CHANNEL) return;
        if (!IS_TOP) {
            if (event.source !== window.top) return;
            if (data.type === 'state' && data.state) {
                if (frameSession !== data.state.sessionId || !data.state.recording) clearTransient();
                frameSession = data.state.sessionId;
                state = { ...emptyState(), ...data.state, steps: [] };
            } else if (data.type === 'flush') {
                flushAllPending();
                window.top.postMessage({ channel: CHANNEL, type: 'flushed', requestId: data.requestId }, '*');
            } else if (data.type === 'inspect') {
                try {
                    const element = resolveTarget(data.target);
                    const previous = element.style.outline;
                    element.style.outline = '3px solid #22c55e';
                    setTimeout(() => { element.style.outline = previous; }, 2000);
                    window.top.postMessage({ channel: CHANNEL, type: 'inspected', message: 'Selector trong iframe khớp đúng 1 phần tử.' }, '*');
                } catch (error) { window.top.postMessage({ channel: CHANNEL, type: 'inspected', message: error.message }, '*'); }
            }
            return;
        }
        // Only windows actually descending from this tab may register.
        const descendant = (root, source, depth = 0) => {
            if (depth > 20) return false;
            try { for (let i = 0; i < root.frames.length; i++) if (root.frames[i] === source || descendant(root.frames[i], source, depth + 1)) return true; } catch (_) {}
            return false;
        };
        if (data.type === 'hello' && event.source && descendant(window, event.source)) {
            const frame = Array.from(document.querySelectorAll('iframe, frame')).find((item) => item.contentWindow === event.source);
            frames.set(event.source, { origin: event.origin, context: frame ? { css_selector: shortestSelector(frame), name: frame.name || '', src: frame.src || '' } : null });
            broadcastState();
        } else if (frames.has(event.source) && data.type === 'inspected') {
            alert(`Kiểm tra selector: ${String(data.message).slice(0, 500)}`);
        } else if (frames.has(event.source) && data.type === 'flushed') {
            const request = flushRequests.get(data.requestId);
            request?.pending.delete(event.source);
            if (request && !request.pending.size) request.finish();
        } else if (frames.has(event.source) && data.type === 'step' && state.recording && data.sessionId === state.sessionId && validStep(data.step)) {
            try {
                const url = new URL(data.step.url);
                if (url.origin !== event.origin || !isHostAllowed(url.hostname)) return;
                const info = frames.get(event.source);
                appendStep(sanitizeStep({ ...data.step, id: typeof data.step.id === 'string' ? data.step.id : uid(),
                    frame: info.context || { url: data.step.url, unresolved: true } }));
            } catch (_) {}
        }
    });
    if (!IS_TOP) {
        window.top.postMessage({ channel: CHANNEL, type: 'hello' }, '*');
        setInterval(() => window.top.postMessage({ channel: CHANNEL, type: 'hello' }, '*'), 2000);
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

    function isUniqueSelector(selector, root = document, element = null) {
        try {
            const matches = root.querySelectorAll(selector);
            return matches.length === 1 && (!element || matches[0] === element);
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
        const unique = [...new Set(candidates)].find(uniqueInRoot);
        return unique || cssPath(element);
    }

    function cssPath(element) {
        const parts = [];
        const root = element.getRootNode();
        let current = element;
        while (current && current !== document.documentElement) {
            if (current.id) {
                const selector = `#${cssEscape(current.id)}`;
                if (isUniqueSelector(selector, root, current)) {
                    parts.unshift(selector);
                    return parts.join(' > ');
                }
            }
            let part = current.tagName.toLowerCase();
            const parent = current.parentElement;
            const siblings = parent || (current.parentNode instanceof ShadowRoot ? current.parentNode : null);
            if (siblings) {
                let sameTagCount = 0;
                let sameTagIndex = 0;
                for (const child of siblings.children) {
                    if (child.tagName !== current.tagName) continue;
                    sameTagCount += 1;
                    if (child === current) sameTagIndex = sameTagCount;
                }
                if (sameTagCount > 1) part += `:nth-of-type(${sameTagIndex})`;
            }
            parts.unshift(part);
            if (isUniqueSelector(parts.join(' > '), root, element)) return parts.join(' > ');
            current = parent;
        }
        return root instanceof ShadowRoot ? parts.join(' > ') : ['html', ...parts].join(' > ');
    }

    function xpathLiteral(value) {
        if (!value.includes("'")) return `'${value}'`;
        if (!value.includes('"')) return `"${value}"`;
        return `concat(${value.split("'").map((part) => `'${part}'`).join(', "\'", ')})`;
    }

    function uniqueXPath(element) {
        if (element.getRootNode() instanceof ShadowRoot) return null;
        if (element.id && isUniqueSelector(`#${cssEscape(element.id)}`, element.getRootNode(), element)) return `//${element.tagName.toLowerCase()}[@id=${xpathLiteral(element.id)}]`;
        const parts = [];
        let current = element;
        while (current?.nodeType === Node.ELEMENT_NODE) {
            const tag = current.tagName.toLowerCase();
            let sameTagCount = 1;
            let sameTagIndex = 1;
            if (current.parentElement) {
                sameTagCount = 0;
                sameTagIndex = 0;
                for (const child of current.parentElement.children) {
                    if (child.tagName !== current.tagName) continue;
                    sameTagCount += 1;
                    if (child === current) sameTagIndex = sameTagCount;
                }
            }
            parts.unshift(sameTagCount > 1 ? `${tag}[${sameTagIndex}]` : tag);
            current = current.parentElement;
        }
        return `/${parts.join('/')}`;
    }

    function handleKeydown(event) {
        if (!state.recording || isPanelEvent(event)) return;
        if (event.isComposing) return;
        flushWidgets();
        const keys = ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Backspace'];
        if (!keys.includes(event.key) && !(event.ctrlKey || event.metaKey || event.altKey)) return;
        flushPendingInputs();
        addStep('keypress', describeTarget(actionableElement(eventElement(event))), event.key, {
            modifiers: { ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey },
            repeat: event.repeat
        });
    }

    function handleScroll(event) {
        if (!state.recording || !isHostAllowed() || isPanelEvent(event)) return;
        clearTimeout(scrollTimer);
        const element = eventElement(event);
        const page = !(element instanceof Element) || element === document.scrollingElement;
        const next = { target: page ? null : describeTarget(element), value: {
            x: Math.round(page ? scrollX : element.scrollLeft), y: Math.round(page ? scrollY : element.scrollTop) } };
        if (pendingScroll && JSON.stringify(pendingScroll.target) !== JSON.stringify(next.target)) flushAllPending();
        pendingScroll = next;
        scrollTimer = setTimeout(flushAllPending, SCROLL_DELAY);
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
        flushPendingInputs();
        addStep('drag_drop', describeTarget(actionableElement(eventElement(event))), null, { source: draggedTarget });
        draggedTarget = null;
    }

    function renumberSteps() {
        state.steps.forEach((step, index) => { step.step = index + 1; });
    }

    function undoStep() {
        flushAllPending();
        state.steps.pop();
        if (state.steps.at(-1)?.action === 'wait') state.steps.pop();
        lastRecordedAt = 0;
        renumberSteps();
        saveState();
        renderSteps();
    }

    function clearRecording() {
        if (!state.steps.length || !confirm('Xóa toàn bộ kịch bản đã ghi?')) return;
        clearTransient();
        state.sessionId = uid();
        state.steps = [];
        state.lastUrl = location.href;
        lastRecordedAt = 0;
        saveState();
        renderSteps();
    }

    function deleteStep(index) {
        state.steps.splice(index, 1);
        renumberSteps();
        lastRecordedAt = 0;
        saveState();
        renderSteps();
    }

    function editStep(index) {
        const current = JSON.stringify(state.steps[index], null, 2);
        const edited = prompt('Sửa object JSON của bước:', current);
        if (edited === null) return;
        try {
            const parsed = JSON.parse(edited);
            if (!validStep(parsed)) throw new Error('Bước không đúng schema hoặc action/value không hợp lệ.');
            state.steps[index] = sanitizeStep({ ...parsed, id: state.steps[index].id || uid() });
            renumberSteps();
            saveState();
            renderSteps();
        } catch (error) {
            alert(`JSON không hợp lệ: ${error.message}`);
        }
    }

    function importJson(file) {
        if (!file) return;
        if (file.size > 20 * 1024 * 1024) { alert('File JSON vượt giới hạn 20 MB.'); return; }
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const parsed = JSON.parse(reader.result);
                if (!parsed || typeof parsed !== 'object') throw new Error('Nội dung phải là object hoặc mảng.');
                if (!Array.isArray(parsed) && parsed.schema_version != null && ![1, 2, 3].includes(parsed.schema_version)) throw new Error('Phiên bản schema chưa được hỗ trợ.');
                const steps = Array.isArray(parsed) ? parsed : parsed.steps;
                if (!Array.isArray(steps)) throw new Error('Không tìm thấy mảng steps.');
                const invalid = steps.findIndex((step) => !validStep(step));
                if (invalid !== -1) throw new Error(`Bước ${invalid + 1} có action, target hoặc value không hợp lệ.`);
                if (steps.length > 50000) throw new Error('Kịch bản vượt giới hạn 50.000 bước.');
                if (state.steps.length && !confirm('Thay thế các bước hiện tại bằng file đã nhập?')) return;
                clearTransient();
                state.sessionId = uid();
                state.steps = steps.map((step) => sanitizeStep({ ...step, id: uid() }));
                state.recording = isHostAllowed();
                state.lastUrl = location.href;
                lastRecordedAt = Date.now();
                renumberSteps();
                saveState();
                persistState();
                renderSteps();
                alert(state.recording ? 'Đã nhập kịch bản và tiếp tục ghi từ bước kế tiếp.' : 'Đã nhập kịch bản. Đang tạm dừng vì ngoài domain cho phép.');
            } catch (error) {
                alert(`Không thể nhập file: ${error.message}`);
            }
        };
        reader.onerror = () => alert('Không đọc được file JSON.');
        reader.readAsText(file);
    }

    function updateSettings() {
        const shadow = panelHost.shadowRoot;
        try {
            state.settings.allowedHosts = [...new Set(shadow.querySelector('.hosts').value.split(',').map((host) => {
                host = host.trim().toLowerCase().replace(/^\*\./, '');
                if (!host) return '';
                const url = new URL(host.includes('://') ? host : `https://${host}`);
                if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Domain không hợp lệ.');
                return url.hostname;
            }).filter(Boolean))];
        } catch (_) { alert('Domain không hợp lệ. Ví dụ: example.com, https://example.org'); return; }
        state.settings.maskSensitive = shadow.querySelector('.mask').checked;
        state.settings.recordHover = shadow.querySelector('.hover').checked;
        if (!state.settings.recordHover) clearTimeout(hoverTimer);
        if (state.settings.maskSensitive) state.steps = state.steps.map(sanitizeStep);
        saveState();
        persistState();
    }

    async function downloadJson() {
        await flushAllFrames();
        flushAllPending();
        const output = {
            name: 'Web Actions Record',
            schema_version: 3,
            session_id: state.sessionId,
            exported_at: new Date().toISOString(),
            settings: state.settings,
            total_steps: state.steps.length,
            steps: state.steps.map(sanitizeStep)
        };
        downloadFile('web_actions_record.json', JSON.stringify(output, null, 2), 'application/json;charset=utf-8');
        persistState();
    }

    function downloadFile(name, content, type) {
        const blobUrl = URL.createObjectURL(new Blob([content], { type }));
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    }

    function resolveTarget(target) {
        if (!target?.css_selector) throw new Error('Bước không có CSS selector.');
        let root = document;
        for (const selector of target.shadow_path || []) {
            const hosts = root.querySelectorAll(selector);
            if (hosts.length !== 1 || !hosts[0].shadowRoot) throw new Error('Không tìm thấy duy nhất shadow host đang mở.');
            root = hosts[0].shadowRoot;
        }
        const matches = root.querySelectorAll(target.css_selector);
        if (matches.length !== 1) throw new Error(`Selector khớp ${matches.length} phần tử, cần đúng 1.`);
        return matches[0];
    }

    // This function is also embedded verbatim into exported Playwright tests.
    async function replayVbdlisWidget(scope, step) {
        const widget = step.widget;
        if (!widget.after) throw new Error('Không quan sát được trạng thái sau click; ghi lại bước này.');
        const unique = async (locator, name) => {
            await expect(locator, `${name}: cần đúng một phần tử`).toHaveCount(1, { timeout: 15000 });
            return locator;
        };
        let container = scope;
        if (step.target?.modal) container = await unique(scope.locator(stableSelector(step.target.modal.css_selector)).filter({ visible: true }), 'Modal');
        if (widget.kind === 'tree') {
            const treeSelector = /^\.jstree-\d+$/.test(widget.tree_selector || '') ? '.jstree' : stableSelector(widget.tree_selector);
            let trees = container.locator(treeSelector);
            const textPattern = text => new RegExp('^\\s*' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '\\s*$');
            if (await trees.count() !== 1) trees = trees.filter({ has: scope.locator('.jstree-anchor').filter({ hasText: textPattern(widget.path[0]) }) });
            const tree = await unique(trees, 'Cây');
            let parent = tree;
            let node;
            for (let i = 0; i < widget.path.length; i++) {
                const candidates = parent.locator(':scope > ul > li.jstree-node');
                const text = widget.path[i];
                node = candidates.filter({ has: scope.locator(':scope > a.jstree-anchor').filter({ hasText: new RegExp('^\\s*' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '\\s*$') }) });
                await unique(node, `Node ${text}`);
                if (i < widget.path.length - 1) {
                    if (!(await node.evaluate(el => el.classList.contains('jstree-open')))) await node.locator(':scope > .jstree-ocl').click();
                    await expect(node).toHaveClass(/jstree-open/, { timeout: 15000 });
                }
                parent = node;
            }
            if (!node) throw new Error('Thiếu đường dẫn node');
            const changed = ['checked', 'selected', 'expanded'].filter(key => typeof widget.after[key] === 'boolean' && widget.before?.[key] !== widget.after[key]);
            const properties = changed.length ? changed : [{ checkbox: 'checked', expand: 'expanded', select: 'selected' }[widget.control]];
            if (widget.control === 'checkbox' && widget.after.indeterminate) throw new Error('Node có trạng thái trung gian; cần ghi thao tác trên node con.');
            const read = property => node.evaluate((el, prop) => {
                const anchor = el.querySelector(':scope > .jstree-anchor');
                if (prop === 'expanded') return el.classList.contains('jstree-open') || el.getAttribute('aria-expanded') === 'true';
                if (prop === 'checked') return Boolean(anchor?.classList.contains('jstree-checked')) || el.getAttribute('aria-checked') === 'true';
                return Boolean(anchor?.classList.contains('jstree-clicked')) || el.getAttribute('aria-selected') === 'true';
            }, property);
            let needsClick = false;
            for (const property of properties) if (await read(property) !== widget.after[property]) needsClick = true;
            if (needsClick) {
                const control = { checkbox: ':scope > .jstree-anchor > .jstree-checkbox', expand: ':scope > .jstree-ocl', select: ':scope > .jstree-anchor' }[widget.control];
                await node.locator(control).click();
            }
            for (const property of properties) await expect.poll(() => read(property), { timeout: 15000 }).toBe(widget.after[property]);
        } else {
            const table = await unique(container.locator(stableSelector(widget.table_selector)), 'Bảng');
            const rows = table.locator('tbody > tr');
            await expect(rows.first()).toBeVisible({ timeout: 15000 });
            const matches = [];
            for (let i = 0; i < await rows.count(); i++) {
                const cells = await rows.nth(i).locator(':scope > td').allTextContents();
                if (JSON.stringify(cells.map(s => s.replace(/\s+/g, ' ').trim().slice(0, 500))) === JSON.stringify(widget.cells)) matches.push(i);
            }
            if (matches.length !== 1) throw new Error(`Hàng dữ liệu khớp ${matches.length} kết quả; kiểm tra bộ lọc và dữ liệu hồ sơ.`);
            const row = rows.nth(matches[0]);
            const selected = () => row.evaluate(el => el.classList.contains('selected') || el.getAttribute('aria-selected') === 'true');
            if (await selected() !== widget.after.selected) await row.locator(':scope > td').nth(widget.cell_index).click();
            await expect.poll(selected, { timeout: 15000 }).toBe(widget.after.selected);
        }
    }

    async function waitVbdlisReady(page) {
        // jQuery AJAX is inspected in page context, including same/cross-origin frames.
        for (const frame of page.frames()) {
            if (frame.isDetached()) continue;
            await frame.waitForFunction(() => {
                const visible = el => Boolean(el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
                const busy = Array.from(document.querySelectorAll('.dataTables_processing, .dt-processing, [aria-busy="true"], .blockUI.blockOverlay')).some(visible);
                return !busy && (!window.jQuery || !window.jQuery.active);
            }, null, { timeout: 20000 });
        }
    }

    async function vbdlisTableTarget(scope, context) {
        if (!Array.isArray(context.cells) || !context.cells.every(v => typeof v === 'string')) throw new Error('Nội dung hàng phải là mảng chuỗi JSON');
        const table = scope.locator(stableSelector(context.table_selector));
        await expect(table).toHaveCount(1, { timeout: 15000 });
        const rows = table.locator('tbody > tr');
        let index = -1;
        await expect.poll(async () => {
            const found = [];
            for (let i = 0; i < await rows.count(); i++) {
                const texts = await rows.nth(i).locator(':scope > td').allTextContents();
                if (JSON.stringify(texts.map(s => s.replace(/\s+/g, ' ').trim().slice(0, 500))) === JSON.stringify(context.cells)) found.push(i);
            }
            index = found.length === 1 ? found[0] : -1;
            return found.length;
        }, { timeout: 15000, message: 'Cần đúng một hàng khớp nội dung đã ghi' }).toBe(1);
        const cell = rows.nth(index).locator(':scope > td').nth(context.cell_index);
        if (!context.control) return cell;
        const control = cell.locator(context.control).filter({ hasText: new RegExp('^\\s*' + context.control_text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '\\s*$') });
        await expect(control).toHaveCount(1);
        return control;
    }

    function inspectStep(index) {
        try {
            const step = state.steps[index];
            if (step.frame) {
                const matches = Array.from(frames).filter(([, info]) => step.frame.css_selector && info.context?.css_selector === step.frame.css_selector);
                if (matches.length !== 1) throw new Error('Không tìm thấy duy nhất iframe đang hoạt động; mở lại trang/frame đã ghi.');
                matches[0][0].postMessage({ channel: CHANNEL, type: 'inspect', target: step.target }, '*');
                return;
            }
            const element = resolveTarget(step.target);
            const box = element.getBoundingClientRect();
            const highlight = document.createElement('div');
            highlight.style.cssText = `position:fixed;pointer-events:none;z-index:2147483647;border:3px solid #22c55e;background:#22c55e22;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px`;
            panelHost.shadowRoot.appendChild(highlight);
            setTimeout(() => highlight.remove(), 2000);
            panelHost.shadowRoot.querySelector('.notice').textContent = `Bước ${index + 1}: selector khớp đúng 1 phần tử.`;
        } catch (error) { alert(`Kiểm tra selector: ${error.message}`); }
    }

    function playwrightSource(steps) {
        const q = JSON.stringify;
        const lines = ["import { test, expect } from '@playwright/test';", '',
            '// Các giá trị đã che được lấy từ biến môi trường RECORDER_VALUE_<số bước>.',
            'function required(name) {', '  const value = process.env[name];',
            '  if (!value) throw new Error(`Thiếu biến môi trường ${name}`);', '  return value;', '}', '',
            stableSelector.toString(), '', replayVbdlisWidget.toString(), '', waitVbdlisReady.toString(), '', vbdlisTableTarget.toString(), '',
            "test('Web Actions Record - VBDLIS', async ({ page }) => {", '  test.setTimeout(180000);'];
        const literal = (value, number) => /REDACTED/.test(q(value) || '') ? `required('RECORDER_VALUE_${number}')` : q(value);
        const locator = (target, step) => {
            if (!target?.css_selector) throw new Error('Thiếu selector');
            if (/REDACTED/.test(q([target.css_selector, target.shadow_path, target.modal?.css_selector]))) throw new Error('Selector đã che dữ liệu; cần thay locator');
            if (step.frame && (!step.frame.css_selector || step.frame.unresolved)) throw new Error('Cần bổ sung đường dẫn iframe');
            let result = step.frame ? `page.frameLocator(${q(step.frame.css_selector)})` : 'page';
            if (target.modal?.css_selector && !(target.shadow_path || []).length) {
                result += `.locator(${q(stableSelector(target.modal.css_selector))}).filter({ visible: true })`;
                if (target.css_selector === target.modal.css_selector) return result;
            }
            for (const host of target.shadow_path || []) result += `.locator(${q(host)})`;
            if (target.table_context) {
                const context = target.table_context;
                const cells = /REDACTED/.test(q(context.cells)) ? `JSON.parse(required('RECORDER_ROW_CELLS_${step.step}'))` : q(context.cells);
                return `(await vbdlisTableTarget(${result}, { ...${q(context)}, cells: ${cells} }))`;
            }
            return `${result}.locator(${q(stableSelector(target.css_selector))})`;
        };
        steps.forEach((raw, index) => {
            const step = { ...sanitizeStep(raw), step: index + 1 };
            const n = index + 1;
            lines.push(`  // Bước ${n}: ${step.action}`);
            try {
                const loc = () => locator(step.target, step);
                const value = literal(step.value, n);
                const previous = steps[index - 1];
                if (step.widget) {
                    if (step.frame && (!step.frame.css_selector || step.frame.unresolved)) throw new Error('Cần bổ sung đường dẫn iframe');
                    const scope = step.frame ? `page.frameLocator(${q(step.frame.css_selector)})` : 'page';
                    const payload = `widgetStep${n}`;
                    lines.push(`  const ${payload} = ${q(step)};`);
                    if (step.widget.kind === 'tree' && /REDACTED/.test(q(step.widget.path))) {
                        lines.push(`  // Mảng JSON các nhãn node thực, theo thứ tự cha → con.`,
                            `  ${payload}.widget.path = JSON.parse(required('RECORDER_TREE_PATH_${n}'));`,
                            `  if (!Array.isArray(${payload}.widget.path) || !${payload}.widget.path.length || !${payload}.widget.path.every(v => typeof v === 'string')) throw new Error('RECORDER_TREE_PATH_${n} phải là mảng chuỗi');`);
                    }
                    if (step.widget.kind === 'table' && /REDACTED/.test(q(step.widget.cells))) {
                        lines.push(`  // Mảng JSON nội dung các ô thực của hàng cần chọn.`,
                            `  ${payload}.widget.cells = JSON.parse(required('RECORDER_ROW_CELLS_${n}'));`,
                            `  if (!Array.isArray(${payload}.widget.cells) || !${payload}.widget.cells.every(v => typeof v === 'string')) throw new Error('RECORDER_ROW_CELLS_${n} phải là mảng chuỗi');`);
                    }
                    lines.push(`  await replayVbdlisWidget(${scope}, ${payload});`, '  await page.waitForTimeout(600);', '  await waitVbdlisReady(page);');
                    return;
                }
                switch (step.action) {
                    case 'navigate':
                        if (index === 0) lines.push(`  await page.goto(${literal(step.url, n)});`);
                        else lines.push(`  await expect(page).toHaveURL(${literal(step.url, n)});`);
                        break;
                    case 'wait': lines.push(`  await page.waitForTimeout(${Math.min(step.value, 300000)});`); break;
                    case 'click': {
                        // A checkbox/radio is replayed by its following state assertion/action.
                        const next = steps[index + 1];
                        if (next?.action === 'check' && next.target?.css_selector === step.target?.css_selector) break;
                        if (step.click_count === 1 && next?.action === 'click' && next.click_count === 2 && next.target?.css_selector === step.target?.css_selector && JSON.stringify(next.frame) === JSON.stringify(step.frame)) break;
                        const mods = Object.entries(step.modifiers || {}).filter(([, on]) => on).map(([key]) => ({ ctrl: 'Control', alt: 'Alt', shift: 'Shift', meta: 'Meta' })[key]).filter(Boolean);
                        lines.push(`  await ${loc()}.click({ clickCount: ${Number.isInteger(step.click_count) ? Math.max(1, Math.min(step.click_count, 3)) : 1}, modifiers: ${q(mods)} });`);
                        break;
                    }
                    case 'dblclick':
                        if (previous?.action !== 'click' || previous.click_count !== 2) lines.push(`  await ${loc()}.dblclick();`);
                        break;
                    case 'input':
                        lines.push(`  await ${loc()}.${typeof step.value === 'boolean' ? `setChecked(${value})` : `fill(${value})`};`);
                        if (typeof step.value !== 'boolean') lines.push(`  await ${loc()}.dispatchEvent('change');`);
                        break;
                    case 'check': lines.push(`  await ${loc()}.setChecked(${value});`); break;
                    case 'select': lines.push(`  await ${loc()}.selectOption(${value}, { force: true });`); break;
                    case 'upload': lines.push(`  await ${loc()}.setInputFiles(required('RECORDER_FILE_${n}').split('|'));`); break;
                    case 'keypress': {
                        const mods = Object.entries(step.modifiers || {}).filter(([, on]) => on).map(([key]) => ({ ctrl: 'Control', alt: 'Alt', shift: 'Shift', meta: 'Meta' })[key]).filter(Boolean);
                        lines.push(`  await ${loc()}.press(${q([...mods, step.value].join('+'))});`); break;
                    }
                    case 'scroll':
                        if (step.target) lines.push(`  await ${loc()}.evaluate((el, pos) => el.scrollTo(pos.x, pos.y), ${q(step.value)});`);
                        else if (step.frame?.css_selector) lines.push(`  await page.frameLocator(${q(step.frame.css_selector)}).locator('html').evaluate((el, pos) => el.ownerDocument.defaultView.scrollTo(pos.x, pos.y), ${q(step.value)});`);
                        else if (step.frame) throw new Error('Cần bổ sung đường dẫn iframe');
                        else lines.push(`  await page.evaluate(pos => window.scrollTo(pos.x, pos.y), ${q(step.value)});`);
                        break;
                    case 'hover': lines.push(`  await ${loc()}.hover();`); break;
                    case 'drag_drop': lines.push(`  await ${locator(step.source, step)}.dragTo(${loc()});`); break;
                    case 'submit':
                        if (!(previous?.action === 'click' || previous?.action === 'keypress' && previous.value === 'Enter')) lines.push(`  await ${loc()}.evaluate(form => form.requestSubmit());`);
                        break;
                    default: throw new Error('Action chưa được hỗ trợ');
                }
                if (['click', 'input', 'check', 'select', 'submit', 'keypress'].includes(step.action)) {
                    const slow = /tra cứu|tìm kiếm|lưu|tiếp tục|chọn|xử lý/i.test(step.target?.text || '');
                    lines.push(`  await page.waitForTimeout(${slow ? 2500 : 700});`, '  await waitVbdlisReady(page);');
                }
            } catch (error) {
                lines.push(`  throw new Error(${q(`Bước ${n}: ${error.message}`)});`);
            }
        });
        lines.push('});', '');
        return lines.join('\n');
    }

    async function downloadPlaywright() {
        await flushAllFrames();
        flushAllPending();
        downloadFile('web-actions.spec.js', playwrightSource(state.steps), 'text/javascript;charset=utf-8');
        persistState();
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
                .panel{max-width:calc(100vw - 24px)}.panel.collapsed .body{display:none}.header{gap:8px}.collapse{padding:3px 7px}.notice{font-size:11px;color:#fbbf24;margin-top:8px;overflow-wrap:anywhere}.more{width:100%}
            </style>
            <div class="panel">
                <div class="header"><span>VBDLIS 2.3</span><span class="status"><i class="dot"></i><span class="status-text"></span></span><button class="collapse" title="Thu gọn / mở rộng">−</button></div>
                <div class="body">
                    <div class="count"><span>Số bước đã ghi</span><strong>0</strong></div>
                    <div class="buttons">
                        <button class="start">Phiên mới</button><button class="stop">Tạm dừng</button>
                        <button class="resume wide">Tiếp tục ghi</button>
                        <button class="undo">Hoàn tác bước cuối</button><button class="clear">Xóa dữ liệu</button>
                        <button class="download wide">Tải JSON kịch bản</button>
                        <button class="playwright wide">Xuất Playwright</button>
                        <button class="import wide">Nhập JSON và tiếp tục</button><input class="file hidden" type="file" accept="application/json,.json">
                    </div>
                    <div class="notice" role="status"></div>
                    <details class="manager"><summary>Quản lý các bước</summary><div class="steps"></div><button class="more">Xem các bước trước</button></details>
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
        shadow.querySelector('.resume').addEventListener('click', resumeRecording);
        shadow.querySelector('.playwright').addEventListener('click', downloadPlaywright);
        shadow.querySelector('.manager').addEventListener('toggle', renderSteps);
        shadow.querySelector('.more').addEventListener('click', () => { visibleSteps += 100; renderedRevision = -1; renderSteps(); });
        shadow.querySelector('.collapse').addEventListener('click', () => {
            ui.collapsed = !ui.collapsed;
            applyPanelLayout();
            saveUI();
        });
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
        applyPanelLayout();
        window.addEventListener('resize', applyPanelLayout);
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
        shadow.querySelector('.resume').disabled = state.recording;
        shadow.querySelector('.undo').disabled = !state.steps.length;
        shadow.querySelector('.clear').disabled = !state.steps.length;
        if (shadow.activeElement !== shadow.querySelector('.hosts')) shadow.querySelector('.hosts').value = state.settings.allowedHosts.join(', ');
        shadow.querySelector('.mask').checked = state.settings.maskSensitive;
        shadow.querySelector('.hover').checked = state.settings.recordHover;
        const allowed = isHostAllowed();
        shadow.querySelector('.status-text').textContent = !allowed ? 'Ngoài domain' : state.recording ? 'Đang ghi' : 'Đã dừng';
        shadow.querySelector('.notice').textContent = storageError;
    }

    let visibleSteps = 100;
    function renderSteps() {
        const container = panelHost?.shadowRoot.querySelector('.steps');
        if (!container || !panelHost.shadowRoot.querySelector('.manager').open || renderedRevision === revision) return;
        renderedRevision = revision;
        const oldScroll = container.scrollTop;
        const atBottom = container.scrollHeight - container.clientHeight - oldScroll < 30;
        container.replaceChildren();
        panelHost.shadowRoot.querySelector('.more').disabled = state.steps.length <= visibleSteps;
        if (!state.steps.length) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = 'Chưa có bước nào';
            container.appendChild(empty);
            return;
        }
        const start = Math.max(0, state.steps.length - visibleSteps);
        state.steps.slice(start).forEach((step, localIndex) => {
            const index = start + localIndex;
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
            const inspect = document.createElement('button');
            inspect.textContent = 'Tìm';
            inspect.title = 'Kiểm tra selector và highlight phần tử';
            inspect.disabled = !step.target;
            inspect.addEventListener('click', () => inspectStep(index));
            actions.append(inspect, edit, remove);
            row.append(number, main, actions);
            container.appendChild(row);
        });
        container.scrollTop = atBottom ? container.scrollHeight : oldScroll;
    }

    function saveUI() {
        try { GM_setValue(UI_KEY, ui); } catch (_) {}
    }

    function applyPanelLayout() {
        if (!panelHost) return;
        const shadow = panelHost.shadowRoot;
        shadow.querySelector('.panel').classList.toggle('collapsed', Boolean(ui.collapsed));
        shadow.querySelector('.collapse').textContent = ui.collapsed ? '+' : '−';
        shadow.querySelector('.collapse').setAttribute('aria-expanded', String(!ui.collapsed));
        if (Number.isFinite(ui.left) && Number.isFinite(ui.top)) {
            const rect = panelHost.getBoundingClientRect();
            panelHost.style.right = 'auto';
            panelHost.style.bottom = 'auto';
            panelHost.style.left = `${Math.max(0, Math.min(innerWidth - rect.width, ui.left))}px`;
            panelHost.style.top = `${Math.max(0, Math.min(innerHeight - rect.height, ui.top))}px`;
        }
    }

    function enableDragging(handle) {
        let offsetX = 0;
        let offsetY = 0;
        let dragging = false;
        handle.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 || event.target.closest('button')) return;
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
        const stopDragging = () => {
            if (!dragging) return;
            dragging = false;
            const rect = panelHost.getBoundingClientRect();
            ui.left = rect.left;
            ui.top = rect.top;
            saveUI();
        };
        handle.addEventListener('pointerup', stopDragging);
        handle.addEventListener('pointercancel', stopDragging);
        handle.addEventListener('lostpointercapture', stopDragging);
    }

    function hookHistoryMethod(method) {
        const original = history[method];
        history[method] = function (...args) {
            const result = original.apply(this, args);
            setTimeout(recordNavigation, 0);
            return result;
        };
    }

    document.addEventListener('click', handleClick, true);
    document.addEventListener('dblclick', (event) => {
        if (state.recording && !isPanelEvent(event)) {
            flushPendingInputs();
            addStep('dblclick', describeTarget(actionableElement(eventElement(event))));
        }
    }, true);
    document.addEventListener('submit', (event) => {
        if (state.recording && !isPanelEvent(event)) {
            flushPendingInputs();
            addStep('submit', describeTarget(eventElement(event)));
            persistState();
        }
    }, true);
    document.addEventListener('input', handleInput, true);
    document.addEventListener('change', handleChange, true);
    // jQuery-only Select2 events do not necessarily reach native listeners.
    let boundJQuery;
    setInterval(() => {
        try {
            const jq = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).jQuery;
            if (!jq?.fn || jq === boundJQuery) return;
            if (boundJQuery) boundJQuery(document).off('.webRecorderVbdlis');
            boundJQuery = jq;
            jq(document).on('change.webRecorderVbdlis select2:select.webRecorderVbdlis select2:unselect.webRecorderVbdlis select2:clear.webRecorderVbdlis', 'select', function (event) {
                if (event.originalEvent || !state.recording) return;
                handleChange({ target: this, composedPath: () => [this] });
            });
        } catch (_) { /* Native DOM recording remains available. */ }
    }, 1000);
    document.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('mouseover', handleMouseOver, true);
    document.addEventListener('mouseout', handleMouseOut, true);
    document.addEventListener('dragstart', handleDragStart, true);
    document.addEventListener('drop', handleDrop, true);
    document.addEventListener('dragend', () => { draggedTarget = null; }, true);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('popstate', recordNavigation);
    window.addEventListener('hashchange', recordNavigation);
    const checkpoint = () => { flushAllPending(); persistState(); };
    window.addEventListener('beforeunload', checkpoint);
    window.addEventListener('pagehide', checkpoint);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') checkpoint(); });

    hookHistoryMethod('pushState');
    hookHistoryMethod('replaceState');

    setInterval(recordNavigation, 500);
    if (window === window.top && state.recording && state.lastUrl !== location.href) recordNavigation();

    try {
        GM_addValueChangeListener(STORAGE_KEY, (_name, _oldValue, newValue, remote) => {
            if (!IS_TOP || !remote) return;
            const incoming = normalize(newValue);
            if (!incoming || incoming.updatedAt <= state.updatedAt) return;
            applyingRemoteState = true;
            state = incoming;
            clearTransient();
            revision += 1;
            try {
                sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
            } catch (_) {
                // The synchronized GM state remains available.
            }
            updatePanel();
            renderSteps();
            broadcastState();
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
