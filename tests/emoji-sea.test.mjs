import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmojiSea } from '../static/portrait/emoji-sea.mjs';

test('emoji 海持续补充，停止补充允许自然散去，取消则清空并释放定时器', () => {
  const originals = { document: globalThis.document, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  const timers = new Map(); let nextId = 0, cancelled = 0;
  const sea = {
    children: [], dataset: {},
    append(element) { this.children.push(element); },
    replaceChildren() { this.children = []; },
  };
  globalThis.setInterval = (callback, delay) => { assert.ok(delay > 0); timers.set(++nextId, callback); return nextId; };
  globalThis.clearInterval = id => timers.delete(id);
  globalThis.document = { createElement() {
    const animation = { cancel() { cancelled++; } };
    return { style: {}, animate() { return animation; }, getAnimations() { return [animation]; },
      remove() { sea.children = sea.children.filter(item => item !== this); } };
  } };
  try {
    const effect = createEmojiSea({ clientHeight: 720 }, sea);
    effect.start(['💙']);
    assert.equal(timers.size, 1); assert.equal(sea.dataset.looping, 'true'); assert.ok(sea.children.length > 0);
    // 模拟最早一批全部散去，下一次补充仍能重新生成。
    for (const node of [...sea.children]) node.getAnimations()[0].onfinish();
    assert.equal(sea.children.length, 0);
    [...timers.values()][0](); assert.ok(sea.children.length > 0);
    effect.update(['✨']);
    [...timers.values()][0](); assert.equal(sea.children.at(-1).textContent, '✨');
    const remaining = sea.children.length;
    effect.update([]);
    assert.equal(timers.size, 0); assert.equal(sea.dataset.looping, 'false');
    assert.equal(sea.children.length, remaining); assert.equal(cancelled, 0);
    for (const node of [...sea.children]) node.getAnimations()[0].onfinish();
    assert.equal(sea.children.length, 0);
    effect.start(['😠']); effect.start(['💙']); assert.equal(timers.size, 1);
    effect.clear();
    assert.equal(timers.size, 0); assert.equal(sea.children.length, 0); assert.ok(cancelled > 0);
  } finally { Object.assign(globalThis, originals); }
});
