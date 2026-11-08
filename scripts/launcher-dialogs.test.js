import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture() {
 const elements = new Map();
 const element = id => {
  if (!elements.has(id)) elements.set(id, {
   dataset: {}, textContent: '', open: false, returnValue: '',
   focus() { this.focused = true; },
   showModal() { this.open = true; },
   addEventListener(type, listener) { this.closeListener = listener; },
   close(value) { this.open = false; if (value !== undefined) this.returnValue = value; this.closeListener(); },
  });
  return elements.get(id);
 };
 const source = fs.readFileSync(new URL('./node-manager-ui.js', import.meta.url), 'utf8');
 const context = vm.createContext({ document: { getElementById: element } });
 vm.runInContext(source.slice(0, source.indexOf('const brief =')), context);
 return { element, run: code => vm.runInContext(code, context) };
}

test('confirmation requires explicit acceptance, renders names as text and focuses cancel', async () => {
 const { element, run } = fixture();
 const result = run(`confirmLauncherAction('<img src=x onerror=alert(1)>', { title: 'Delete node?', accept: 'Delete from launcher', danger: true })`);
 assert.equal(element('confirm-dialog').open, true);
 assert.equal(element('confirm-title').textContent, 'Delete node?');
 assert.equal(element('confirm-message').textContent, '<img src=x onerror=alert(1)>');
 assert.equal(element('confirm-accept').dataset.danger, 'true');
 assert.equal(element('confirm-cancel').focused, true);
 assert.equal(await run(`confirmLauncherAction('A second action')`), false);
 element('confirm-accept').onclick();
 assert.equal(await result, true);
});

test('cancel, close and Escape dismissal never reuse a previous approval', async () => {
 const { element, run } = fixture();
 let result = run(`confirmLauncherAction('First')`);
 element('confirm-accept').onclick();
 assert.equal(await result, true);
 for (const action of ['confirm-cancel', 'confirm-close', 'escape']) {
  result = run(`confirmLauncherAction('Next')`);
  assert.equal(element('confirm-accept').dataset.danger, 'false');
  if (action === 'escape') element('confirm-dialog').close();
  else element(action).onclick();
  assert.equal(await result, false);
 }
});
