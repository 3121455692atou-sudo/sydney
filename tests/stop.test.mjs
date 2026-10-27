import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as protocol from '../static/portrait/protocol.mjs';

const source = async name => (await readFile(new URL(`../static/portrait/${name}`, import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const [appSource, portraitSource] = await Promise.all([source('app.mjs'), source('portrait.mjs')]);

class Element {
  constructor() {
    this.children = []; this.nodes = new Map(); this.listeners = new Map();
    this.style = {}; this.dataset = {}; this.value = ''; this.textContent = '';
    this.hidden = false; this.disabled = false; this.scrollHeight = 24;
    const classes = new Set();
    this.classList = { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) };
  }
  set innerHTML(value) { this.html = value; this.children = []; this.nodes.clear(); }
  get innerHTML() { return this.html || ''; }
  querySelector(selector) { if (!this.nodes.has(selector)) this.nodes.set(selector, new Element()); return this.nodes.get(selector); }
  appendChild(element) { this.children.push(element); }
  append(element) { this.appendChild(element); }
  replaceChildren() { this.children = []; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  remove() {}
  focus() {}
  setAttribute() {}
}

async function setup() {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const document = { hidden: false, getElementById: get, createElement: () => new Element(), addEventListener() {}, querySelectorAll: () => [] };
  const window = { addEventListener() {} };
  const timers = new Map(); let now = 0, timerId = 0, saved, stream, requestSignal, inFlight;
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const portrait = { sequence: 0, mouth: 0, particles: false, async setEmotion() {},
    setMouth(value) { this.mouth = value; }, startParticles() { this.particles = true; },
    updateParticles() {}, stopParticles() { this.particles = false; }, clearParticles() { this.particles = false; } };
  const context = vm.createContext({ ...protocol, document, window, console, AbortController, TextDecoder,
    crypto: { getRandomValues: array => array.fill(3) }, matchMedia: () => ({ matches: false }),
    performance: { now: () => now },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, at: now + delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    localStorage: { getItem: () => null, setItem: (_, value) => { saved = JSON.parse(value); } },
    decorateEmoji() {},
    fetch: async (url, options) => {
      if (url === '/api/settings') return { ok: true, json: async () => ({ thinking: true, loaded: true, model: 'test', adapters: [] }) };
      assert.equal(url, '/api/chat'); requestSignal = options.signal;
      const body = new ReadableStream({ start(controller) { stream = controller; } });
      requestSignal.addEventListener('abort', () => stream.error(requestSignal.reason), { once: true });
      requestSignal.throwIfAborted();
      return { ok: true, body };
    },
  });
  vm.runInContext(portraitSource, context);
  const Director = vm.runInContext('SpeechDirector', context);
  const director = new Director(portrait);
  context.createPortrait = async () => ({ portrait, director });
  // The browser loads these as separate modules, so keep their lexical scopes separate.
  vm.runInContext(`{\n${appSource}\n}`, context);
  await flush();
  const send = async text => {
    get('input').value = text;
    inFlight = get('composer').listeners.get('submit')({ preventDefault() {} });
    await flush();
  };
  const event = async value => { stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)); await flush(); };
  const end = async () => { await event({ done: true }); stream.close(); await flush(); };
  const tick = async () => {
    const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) return false;
    timers.delete(next[0]); now = next[1].at; next[1].callback(); await flush(); return true;
  };
  const drain = async () => { for (let i = 0; i < 2000 && timers.size; i++) await tick(); assert.equal(timers.size, 0); await flush(); };
  const bubbles = () => get('thread').children.filter(row => row.nodes.has('.bot-body')).map(row => row.nodes.get('.bot-body').innerHTML);
  const stop = async () => { get('stop').listeners.get('click')(); await flush(); };
  const answer = () => saved.chats.find(chat => chat.id === saved.active).messages.at(-1);
  return { get, portrait, director, send, event, end, tick, drain, bubbles, stop, answer, flush,
    get signal() { return requestSignal; }, get done() { return inFlight; } };
}

const reply = '<l2d>happy</l2d>雨后的公园空气清新，树叶上挂着水珠。💙<l2d>curious</l2d>小鸟在树枝之间轻轻跳动，远处还有散步的人。✨';

test('网络已经结束，文字还在显示时仍能停止；停止后只保存已经显示的内容', async () => {
  const ui = await setup(); await ui.send('测试'); await ui.event({ delta: reply }); await ui.end();
  assert.equal(ui.get('stop').hidden, false);
  assert.equal(ui.director.running, true);
  for (let i = 0; i < 4; i++) await ui.tick();
  const shown = ui.bubbles();
  assert.ok(shown.join('').length > 0 && shown.join('').length < protocol.visibleText(reply).length);
  await ui.stop(); await ui.done; await ui.drain();
  assert.deepEqual(ui.bubbles(), shown);
  assert.equal(ui.get('stop').hidden, true);
  assert.equal(ui.signal.aborted, true);
  assert.equal(ui.director.running, false);
  assert.equal(ui.portrait.mouth, 0);
  assert.equal(ui.portrait.particles, false);
  assert.equal(ui.answer().interrupted, true);
  assert.deepEqual(protocol.visibleBubbles(ui.answer().content), shown);
});

test('仍在接收正文时可以停止，未显示的后续句子不会补出来', async () => {
  const ui = await setup(); await ui.send('测试'); await ui.event({ delta: reply });
  const shown = ui.bubbles(); await ui.stop(); await ui.done; await ui.drain();
  assert.deepEqual(ui.bubbles(), shown);
  assert.equal(ui.answer().interrupted, true);
  assert.equal(ui.answer().error, undefined);
  assert.deepEqual(protocol.visibleBubbles(ui.answer().content), shown);
});

test('思考阶段仍能停止并保留已收到的思考', async () => {
  const ui = await setup(); await ui.send('测试'); await ui.event({ reasoning: '正在思考' });
  await ui.stop(); await ui.done;
  assert.equal(ui.get('stop').hidden, true);
  assert.equal(ui.answer().reasoning, '正在思考');
  assert.equal(ui.answer().content, '');
  assert.equal(ui.answer().interrupted, true);
});

test('正常输出等最后一个字显示完后恢复发送，停止后也能再发一条', async () => {
  const ui = await setup(); await ui.send('第一条'); await ui.event({ delta: reply }); await ui.end();
  await ui.stop(); await ui.done;
  await ui.send('第二条'); await ui.event({ delta: '<l2d>happy</l2d>你好。💙' }); await ui.end();
  assert.equal(ui.get('stop').hidden, false);
  await ui.drain(); await ui.done;
  assert.equal(ui.get('stop').hidden, true);
  assert.equal(ui.get('send').disabled, false);
  assert.equal(ui.answer().content, '<l2d>happy</l2d>你好。💙');
  assert.equal(ui.answer().interrupted, undefined);
  assert.equal(ui.bubbles().at(-1), '你好。💙');
});

test('后台显示完整文本的原有行为仍会结束等待', async () => {
  const ui = await setup(); await ui.send('测试'); await ui.event({ delta: reply }); await ui.end();
  ui.director.stop(); await ui.flush(); await ui.done;
  assert.deepEqual(ui.bubbles(), protocol.visibleBubbles(reply));
  assert.equal(ui.get('stop').hidden, true);
  assert.equal(ui.answer().interrupted, undefined);
});
