// ==UserScript==
// @name         Web Actions Recorder
// @namespace    https://tampermonkey.net/
// @version      1.0.0
// @description  Ghi thao tac web va xuat kich ban JSON.
// @match        http://*/*
// @match        https://*/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_KEY = '__web_actions_recorder_v1__';
    const INPUT_DELAY = 500;
    const pendingInputs = new Map();
    let inputId = 0;
    let panelHost;
    let state = loadState();

    function emptyState() {
        return { recording: false, steps: [], lastUrl: '', updatedAt: Date.now() };
    }

    function normalize(value) {
        if (!value || typeof value !== 'object') return null;
        return {
            recording: Boolean(value.recording),
            steps: Array.isArray(value.steps) ? value.steps : [],
            lastUrl: typeof value.lastUrl === 'string' ? value.lastUrl : '',
            updatedAt: Number(value.updatedAt) || 0
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
            GM_setValue(STORAGE_KEY, state);
        } catch (_) {
            // The current-origin session remains usable without GM storage.
        }
        updatePanel();
    }

    function addStep(action, target, value = null, extra = {}) {
        if (!state.recording) return;
        state.steps.push({
            step: state.steps.length + 1,
            action,
            target,
            value,
            url: location.href,
            ...extra
        });
        state.lastUrl = location.href;
        saveState();
    }

    function startRecording() {
        clearPendingInputs();
        state = emptyState();
        state.recording = true;
        state.lastUrl = location.href;
        addStep('navigate', null);
    }

    function stopRecording() {
        flushPendingInputs();
        state.recording = false;
        saveState();
    }

    function recordNavigation() {
        if (!state.recording || state.lastUrl === location.href) return;
        flushPendingInputs();
        addStep('navigate', null);
    }

    function isPanelEvent(event) {
        return panelHost && event.composedPath().includes(panelHost);
    }

    function actionableElement(target) {
        if (!(target instanceof Element)) return null;
        return target.closest('button, a, input, textarea, select, label, [role="button"], [role="link"], [onclick]') || target;
    }

    function handleClick(event) {
        if (!state.recording || isPanelEvent(event)) return;
        const element = actionableElement(event.target);
        if (element) addStep('click', describeTarget(element));
    }

    function handleInput(event) {
        if (!state.recording || isPanelEvent(event)) return;
        const element = event.target;
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return;

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
        const element = event.target;
        if (element instanceof HTMLSelectElement) {
            const option = element.options[element.selectedIndex];
            addStep('select', describeTarget(element), element.value, {
                field_name: fieldName(element),
                option: { text: cleanText(option?.textContent), value: option?.value ?? element.value }
            });
            return;
        }
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
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
        } else {
            value = element.value;
        }
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
        return {
            tag: element.tagName,
            text: elementText(element),
            css_selector: shortestSelector(element),
            xpath: uniqueXPath(element),
            attributes: attributesOf(element)
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

    function fieldName(element) {
        const labels = element.labels ? Array.from(element.labels).map((label) => cleanText(label.textContent)).filter(Boolean) : [];
        if (labels.length) return labels.join(' / ');
        const parentLabel = element.closest('label');
        return cleanText(parentLabel?.textContent) || element.getAttribute('aria-label') || element.placeholder || element.name || element.id || '';
    }

    function cssEscape(value) {
        return CSS.escape(String(value));
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
        const unique = [...new Set(candidates)].filter(isUniqueSelector).sort((a, b) => a.length - b.length)[0];
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

    function downloadJson() {
        flushPendingInputs();
        const output = {
            name: 'Web Actions Record',
            exported_at: new Date().toISOString(),
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
                *{box-sizing:border-box}.panel{width:245px;color:#f8fafc;background:#111827;border:1px solid #334155;border-radius:12px;overflow:hidden;box-shadow:0 14px 35px #0006;font:13px Arial,sans-serif;user-select:none}
                .header{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#1e293b;cursor:move;touch-action:none;font-weight:700}.status{font-size:11px;color:#cbd5e1;font-weight:400}.dot{display:inline-block;width:8px;height:8px;margin-right:5px;border-radius:50%;background:#64748b}.dot.on{background:#ef4444;box-shadow:0 0 0 4px #ef444433}
                .body{padding:12px}.count{margin-bottom:10px;color:#cbd5e1}.count strong{color:white;font-size:18px}.buttons{display:grid;gap:7px}button{padding:9px;border:0;border-radius:7px;color:white;font-weight:700;cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}.start{background:#16a34a}.stop{background:#dc2626}.download{background:#2563eb}
            </style>
            <div class="panel">
                <div class="header"><span>Web Actions Recorder</span><span class="status"><i class="dot"></i><span class="status-text"></span></span></div>
                <div class="body"><div class="count">Số bước đã ghi: <strong>0</strong></div><div class="buttons"><button class="start">Bắt đầu ghi</button><button class="stop">Dừng ghi</button><button class="download">Tải JSON kịch bản</button></div></div>
            </div>`;
        document.body.appendChild(panelHost);
        shadow.querySelector('.start').addEventListener('click', startRecording);
        shadow.querySelector('.stop').addEventListener('click', stopRecording);
        shadow.querySelector('.download').addEventListener('click', downloadJson);
        enableDragging(shadow.querySelector('.header'));
        updatePanel();
    }

    function updatePanel() {
        const shadow = panelHost?.shadowRoot;
        if (!shadow) return;
        shadow.querySelector('.count strong').textContent = state.steps.length;
        shadow.querySelector('.status-text').textContent = state.recording ? 'Đang ghi' : 'Đã dừng';
        shadow.querySelector('.dot').classList.toggle('on', state.recording);
        shadow.querySelector('.start').disabled = state.recording;
        shadow.querySelector('.stop').disabled = !state.recording;
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
    if (state.recording && state.lastUrl !== location.href) recordNavigation();

    if (document.body) {
        createPanel();
    } else {
        document.addEventListener('DOMContentLoaded', createPanel, { once: true });
    }
})();
