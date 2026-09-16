const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/web-actions-recorder.user.js`, 'utf8');
function extract(name) {
    const start = source.indexOf(`    function ${name}(`);
    const asyncStart = source.indexOf(`    async function ${name}(`);
    const offset = start < 0 ? asyncStart : start;
    assert.ok(offset >= 0, name);
    const end = source.indexOf('\n    }', offset);
    return source.slice(offset, end + 6);
}
const context = vm.createContext({ sanitizeStep: value => value });
for (const name of ['stableSelector', 'replayVbdlisWidget', 'waitVbdlisReady', 'vbdlisTableTarget', 'replaySelect2', 'playwrightSource']) {
    vm.runInContext(extract(name), context);
}
const target = { css_selector: '#field', attributes: {}, table_context: {
    table_selector: '#records', cells: ['HS-1', ''], cell_index: 1,
    control: 'input', control_selector: 'input[name="area"]'
} };
const steps = [
    { action: 'navigate', url: 'https://example.test/' },
    { action: 'input', target, value: '100' },
    { action: 'select', target: { css_selector: '#select' }, value: 'one', select2: true, options: [{ value: 'one', text: 'Một' }] },
    { action: 'click', target: { css_selector: '#file', attributes: { type: 'file' } } },
    { action: 'click', target: { css_selector: '#nested' }, frame: { css_selector: '#outer', path: ['#outer', '#inner'] } },
    { action: 'wait', value: 5000 }
];
const output = context.playwrightSource(steps);
new vm.Script(output.replace("import { test, expect } from '@playwright/test';", ''));
assert.match(output, /control_selector/);
assert.match(output, /\.blur\(\)/);
assert.doesNotMatch(output, /dispatchEvent\('change'\)/);
assert.match(output, /await replaySelect2\(page/);
assert.doesNotMatch(output, /locator\("#file"\)\.click/);
assert.match(output, /frameLocator\("#outer"\)\.frameLocator\("#inner"\)/);
assert.match(output, /RECORDER_KEEP_DELAYS/);
async function testTableControl() {
    const control = {};
    const cell = { locator(selector) { assert.equal(selector, 'input[name="area"]'); return control; } };
    const row = { locator() { return { allTextContents: async () => ['HS-1', ''], nth: () => cell }; } };
    const rows = { count: async () => 1, nth: () => row };
    const table = { locator: () => rows };
    const expect = () => ({ toHaveCount: async () => {} });
    expect.poll = callback => ({ toBe: async value => assert.equal(await callback(), value) });
    context.expect = expect;
    const actual = await context.vbdlisTableTarget({ locator: () => table }, target.table_context);
    assert.equal(actual, control, 'Replay must target the input, not its table cell');
}
testTableControl().then(() => console.log('Recorder regression checks passed')).catch(error => { console.error(error); process.exitCode = 1; });
