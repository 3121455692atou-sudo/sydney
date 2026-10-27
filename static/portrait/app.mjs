import { ProtocolDecoder, SentenceQueue, SSEDecoder, visibleText, visibleBubbles } from './protocol.mjs?v=emoji-loop-1';
import { createPortrait } from './portrait.mjs?v=stop-2';
import { decorateEmoji } from './bing-emoji.mjs?v=1';

const thread = document.getElementById('thread');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const stopBtn = document.getElementById('stop');
const banner = document.getElementById('lock-banner');
const newChat = document.getElementById('new-chat');
const histEl = document.getElementById('hist');
const STORE = 'sydney.portrait.v1';
let state;
try { state = JSON.parse(localStorage.getItem(STORE)); } catch {}
if (!state || !Array.isArray(state.chats)) state = { chats: [], active: '' };
state.chats = state.chats.filter(c => c && typeof c.id === 'string' && Array.isArray(c.messages));
state.expandThinking = state.expandThinking === true;
let session = state.active;
let busy = false;
let controller = null;
let director = null;
let portrait = null;
let settings = { thinking: true, preset: '16g', prompt: '' };
const actorsReady = createPortrait().then(actors => { ({ director, portrait } = actors); }).catch(console.error);

function currentChat() { return state.chats.find(c => c.id === session); }
function createChatId() {
  // getRandomValues also works on plain HTTP LAN addresses, unlike randomUUID.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}
function save() { state.active = session; localStorage.setItem(STORE, JSON.stringify(state)); }
function turnCount(chat = currentChat()) { return chat?.messages.filter(m => m.role === 'assistant').length || 0; }
function setBusy(on) {
  busy = on;
  sendBtn.disabled = on;
  sendBtn.hidden = on;
  stopBtn.hidden = !on;
}
function autosize() {
  input.style.height = '24px';
  input.style.height = Math.min(Math.max(input.scrollHeight, 24), 160) + 'px';
}
input.addEventListener('input', autosize);
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
});

function dotClass(n) {
  if (n >= 20) return "r";
  if (n >= 15) return "y";
  return "";
}

function showHello() {
  thread.innerHTML = `<div id="hello"><p class="hi">你好</p><p class="sub">我是 Sydney。有问题尽管问我。</p></div>`;
}

function hideHello() {
  const h = document.getElementById("hello");
  if (h) h.remove();
}

function addUser(text) {
  hideHello();
  const row = document.createElement("div");
  row.className = "row user";
  row.innerHTML = `<div class="user-pill"></div>`;
  row.querySelector(".user-pill").textContent = text;
  decorateEmoji(row.querySelector(".user-pill"));
  thread.appendChild(row);
  thread.scrollTop = thread.scrollHeight;
}

function renderMd(src) {
  let s = String(src)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

function addThinkBlock(turn, prefix, open = state.expandThinking) {
  hideHello();
  const row = document.createElement("div");
  row.className = "row bot";
  row.innerHTML = `<details class="think-card"${open ? " open" : ""}><summary>思考</summary><div class="think-body"></div></details>`;
  row.querySelector(".think-body").textContent = prefix || "";
  thread.appendChild(row);
  thread.scrollTop = thread.scrollHeight;
  return row;
}

function addBotBubble(text, turn) {
  hideHello();
  const row = document.createElement("div");
  row.className = "row bot";
  const cls = dotClass(turn);
  row.innerHTML = `
    <div class="bot-card">
      <div class="bot-body"></div>
      <div class="bot-foot"><span>${turn} 共 20</span><span class="dot ${cls}"></span></div>
    </div>`;
  row.querySelector(".bot-body").innerHTML = renderMd(text);
  decorateEmoji(row.querySelector(".bot-body"));
  thread.appendChild(row);
  thread.scrollTop = thread.scrollHeight;
  return row.querySelector(".bot-body");
}

function setLocked(on, msg) {
  banner.hidden = !on;
  if (msg) banner.textContent = msg;
  input.disabled = on;
  sendBtn.disabled = on || busy;
}



function paintHist() {
  histEl.innerHTML = '';
  const chats = state.chats.filter(c => c.messages.length).sort((a, b) => b.updated - a.updated);
  for (const c of chats) {
    const li = document.createElement('li');
    if (c.id === session) li.classList.add('on');
    li.innerHTML = '<span class="t"></span><button class="del" type="button" title="删除">×</button>';
    li.querySelector('.t').textContent = c.title || '对话';
    li.addEventListener('click', () => openChat(c.id));
    li.querySelector('.del').addEventListener('click', e => { e.stopPropagation(); delChat(c.id); });
    histEl.appendChild(li);
  }
}
function refresh() {
  const chat = currentChat();
  if (chat?.ended) setLocked(true, '这场对话已经结束。请新开对话。');
  else if (turnCount(chat) >= 20) setLocked(true, '已经 20 条了，请新开对话。');
  else setLocked(false);
  document.getElementById('think-flag').hidden = !settings.thinking;
  paintHist();
}
function openChat(id) {
  if (busy) return;
  const chat = state.chats.find(c => c.id === id);
  if (!chat) return;
  director?.stop(); session = id; save(); thread.innerHTML = '';
  let turn = 0;
  for (const m of chat.messages) {
    if (m.role === 'user') addUser(m.content);
    else if (m.role === 'assistant') {
      turn++;
      if (m.reasoning) addThinkBlock(turn, m.reasoning);
      for (const p of visibleBubbles(m.content || '')) addBotBubble(p, turn);
      if (m.error) addBotBubble(m.error, turn);
    }
  }
  if (!chat.messages.length) showHello();
  refresh(); input.focus();
}
function delChat(id) {
  if (busy) return;
  state.chats = state.chats.filter(c => c.id !== id);
  if (session === id) { director?.stop(); session = ''; showHello(); setLocked(false); }
  save(); paintHist();
}
function startChat() {
  if (busy) return;
  director?.stop(); portrait?.setEmotion('calm');
  const empty = state.chats.find(c => !c.messages.length);
  const chat = empty || { id: createChatId(), title: '新对话', messages: [], updated: Date.now() };
  if (!empty) state.chats.unshift(chat);
  session = chat.id; save(); showHello(); refresh(); input.focus();
}
newChat.addEventListener('click', startChat);

form.addEventListener('submit', async e => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || busy || input.disabled) return;
  if (!currentChat()) startChat();
  setBusy(true); director?.stop();
  const chat = currentChat();
  chat.messages.push({ role: 'user', content: text });
  if (chat.messages.length === 1) chat.title = Array.from(text).slice(0, 22).join('');
  const context = chat.messages.filter(m => m.role === 'user' || m.content).slice(-40)
    .map(m => m.role === 'assistant' && m.reasoning ? { role: m.role, content: m.content, reasoning_content: m.reasoning } : { role: m.role, content: m.content });
  const answer = { role: 'assistant', content: '', reasoning: '' };
  const turn = turnCount(chat) + 1;
  chat.messages.push(answer); chat.updated = Date.now(); save(); paintHist();
  addUser(text); input.value = ''; autosize();
  let thinkRow = null;
  let stopped = false;
  let ended = false;
  let doneReceived = false;
  const displayedParts = [];
  const ownController = new AbortController(); controller = ownController;
  const interrupt = () => {
    stopped = true;
    answer.interrupted = true;
    director?.stop({ finish: false });
    answer.content = displayedParts.filter(part => part.text).map(part => `<l2d>${part.emotion}</l2d>${part.text}`).join('');
  };
  ownController.signal.addEventListener('abort', interrupt, { once: true });
  const sentences = new SentenceQueue(part => {
    const text = part.text.trim();
    if (ownController.signal.aborted) return;
    if (stopped || !director) { if (text) { displayedParts.push({ text, emotion: part.emotion }); addBotBubble(text, turn); } return; }
    if (!text) { director.enqueue(part); return; }
    const displayedPart = { emotion: part.emotion, text: '' };
    displayedParts.push(displayedPart);
    let body = null;
    director.enqueue({ ...part, text, onProgress: shown => {
      if (stopped) return;
      displayedPart.text = shown;
      if (!body) body = addBotBubble('', turn);
      body.innerHTML = renderMd(shown); decorateEmoji(body);
      thread.scrollTop = thread.scrollHeight;
    } });
  });
  const onReasoning = chunk => {
    if (ownController.signal.aborted) return;
    answer.reasoning += chunk;
    if (!settings.thinking) return;
    if (!thinkRow) { thinkRow = addThinkBlock(turn, ''); thinkRow.querySelector('summary').textContent = '思考中…'; }
    thinkRow.querySelector('.think-body').textContent = answer.reasoning;
    thread.scrollTop = thread.scrollHeight;
  };
  const parser = new ProtocolDecoder({ text: chunk => sentences.push(chunk), emotion: emotion => sentences.setEmotion(emotion), reasoning: onReasoning });
  const finishParsing = () => { if (!ended) { ended = true; parser.end(); sentences.flush(); } };
  try {
    await actorsReady;
    const response = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: context }), signal: ownController.signal,
    });
    if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error(err.error || response.statusText); }
    const sse = new SSEDecoder(event => {
      if (ownController.signal.aborted) return;
      if (event.error) throw new Error(event.error);
      if (event.reasoning) onReasoning(event.reasoning);
      if (event.delta) { answer.content += event.delta; parser.push(event.delta); }
      if (event.done) doneReceived = true;
    });
    const reader = response.body.getReader(), decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sse.push(decoder.decode(value, { stream: true }));
    }
    ownController.signal.throwIfAborted();
    sse.push(decoder.decode()); sse.end(); finishParsing();
    if (!doneReceived) throw new Error('连接提前断开，已保留收到的回复。');
  } catch (error) {
    if (ownController.signal.aborted || error.name === 'AbortError') answer.interrupted = true;
    else {
      director?.stop(); stopped = true; finishParsing();
      answer.error = error.message; addBotBubble(error.message || '出错了', turn);
    }
  } finally {
    if (thinkRow) thinkRow.querySelector('summary').textContent = '思考';
    await director?.whenIdle();
    ownController.signal.removeEventListener('abort', interrupt);
    if (!answer.interrupted && !answer.error) chat.ended = /我要结束这场对话|终止这场对话|结束这场对话/.test(visibleText(answer.content));
    controller = null; chat.updated = Date.now(); save(); setBusy(false); refresh(); input.focus();
  }
});
stopBtn.addEventListener('click', () => { controller?.abort(); });
window.addEventListener('pagehide', () => { director?.stop(); controller?.abort(); save(); });

async function fillSettings() {
  const response = await fetch('/api/settings');
  const s = await response.json();
  if (!response.ok) throw new Error(s.error || response.statusText);
  settings = s;
  document.getElementById('cur-model').textContent = (s.loaded ? s.model : '（未加载）') + '\n' + s.adapter;
  document.getElementById('vram').textContent = '显存 ' + s.vram;
  document.getElementById('sys-prompt').value = s.prompt || '';
  document.getElementById('think-on').checked = !!s.thinking;
  document.getElementById('think-expand').checked = state.expandThinking;
  document.getElementById('preset-sel').value = s.preset === '16g' ? '16g' : '8g';
  const select = document.getElementById('adapter-sel'); select.replaceChildren();
  for (const name of s.adapters || []) {
    const option = document.createElement('option'); option.value = name; option.textContent = name; option.selected = name === s.model; select.append(option);
  }
  for (const id of ['adapter-sel', 'preset-sel', 'sys-prompt', 'think-expand', 'apply', 'unload']) {
    document.getElementById(id).disabled = s.remote_settings_only === true;
  }
  refresh();
  return s;
}
document.getElementById('gear').addEventListener('click', async () => {
  try { await fillSettings(); document.getElementById('modal').hidden = false; } catch (error) { alert(error.message); }
});
document.getElementById('close-modal').addEventListener('click', () => { document.getElementById('modal').hidden = true; });
async function changeSettings(action, button) {
  if (busy) return;
  if (settings.remote_settings_only && action !== 'save') return;
  const expandThinking = document.getElementById('think-expand').checked;
  const oldText = button.textContent; button.disabled = true;
  if (action === 'load') button.textContent = '卸载并加载中…';
  try {
    const update = { action, thinking: document.getElementById('think-on').checked };
    if (!settings.remote_settings_only) Object.assign(update, {
      adapter: document.getElementById('adapter-sel').value,
      preset: document.getElementById('preset-sel').value,
      prompt: document.getElementById('sys-prompt').value,
    });
    const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update) });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || response.statusText);
    if (state.expandThinking !== expandThinking) {
      state.expandThinking = expandThinking; save();
      for (const card of document.querySelectorAll('.think-card')) card.open = expandThinking;
    }
    await fillSettings();
    if (action === 'save') document.getElementById('modal').hidden = true;
  } catch (error) { alert(error.message); }
  finally { button.disabled = !!settings.remote_settings_only && action !== 'save'; button.textContent = oldText; }
}
for (const [id, action] of [['save-set', 'save'], ['apply', 'load'], ['unload', 'unload']]) {
  document.getElementById(id).addEventListener('click', event => changeSettings(action, event.currentTarget));
}

if (currentChat()) openChat(session); else startChat();
fillSettings().catch(console.error);
