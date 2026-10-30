import { ProtocolDecoder, SentenceQueue, SSEDecoder, visibleText, visibleBubbles, endsChat } from './protocol.mjs?v=end-2';
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
const attachBtn = document.getElementById('attach');
const fileInput = document.getElementById('file');
const attachEl = document.getElementById('attachments');
const STORE = 'sydney.portrait.v1';
const MAX_IMAGES = 3;
let pending = []; // compressed data URLs waiting to be sent with the next message
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
function save() {
  state.active = session;
  // Images make the record big; when the browser's storage is full, clear the oldest images first.
  for (;;) {
    try { localStorage.setItem(STORE, JSON.stringify(state)); return; }
    catch (error) { if (!dropOldestImages()) { console.warn(error); return; } }
  }
}
function dropOldestImages() {
  for (const c of [...state.chats].sort((a, b) => a.updated - b.updated)) {
    const m = c.messages.find(m => m.images?.length);
    if (m) { m.imagesDropped = m.images.length; m.images = []; return true; }
  }
  return false;
}
// A reply that failed before any text arrived (busy, model down) is not a turn: it can be retried and is never sent back as context.
function isFailed(m) { return m?.role === 'assistant' && !!m.error && !m.content; }
function turnCount(chat = currentChat()) { return chat?.messages.filter(m => m.role === 'assistant' && !isFailed(m)).length || 0; }
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

async function shrink(file) {
  // Longest side 1024 px JPEG: enough for the vision tower, small enough to keep in the local record.
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); // transparent PNGs on white
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.85);
}
async function addFiles(files) {
  for (const file of [...files].filter(f => f.type.startsWith('image/'))) {
    if (pending.length >= MAX_IMAGES) { alert(`一次最多发 ${MAX_IMAGES} 张图片。`); break; }
    try { pending.push(await shrink(file)); } catch { alert('这张图片读不出来，换一张试试。'); }
  }
  paintPending();
}
function paintPending() {
  attachEl.hidden = !pending.length;
  attachEl.innerHTML = '';
  pending.forEach((url, i) => {
    const item = document.createElement('div');
    item.className = 'att';
    item.innerHTML = '<img alt="待发送的图片" /><button type="button" aria-label="移除这张图片">×</button>';
    item.querySelector('img').src = url;
    item.querySelector('button').addEventListener('click', () => { pending.splice(i, 1); paintPending(); });
    attachEl.appendChild(item);
  });
}
attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
input.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.some(f => f.type.startsWith('image/'))) return;
  if (!e.clipboardData.getData('text/plain')) e.preventDefault();
  addFiles(files);
});
for (const el of [thread, form]) {
  el.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  el.addEventListener('drop', e => { if (e.dataTransfer?.files.length) { e.preventDefault(); if (!input.disabled) addFiles(e.dataTransfer.files); } });
}
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

function addUser(text, images = [], dropped = 0) {
  hideHello();
  const row = document.createElement("div");
  row.className = "row user";
  row.innerHTML = `<div class="user-pill"></div>`;
  const pill = row.querySelector(".user-pill");
  if (images.length || dropped) {
    const box = document.createElement("div");
    box.className = "user-images";
    for (const url of images) { const img = document.createElement("img"); img.src = url; img.alt = "发送的图片"; box.appendChild(img); }
    if (dropped) { const note = document.createElement("span"); note.className = "img-dropped"; note.textContent = `${dropped} 张图片（本地存储满了，已清理）`; box.appendChild(note); }
    pill.appendChild(box);
  }
  if (text) { const body = document.createElement("div"); body.textContent = text; pill.appendChild(body); decorateEmoji(body); }
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

function addBotBubble(text, turn, { failed = false, retry = null } = {}) {
  hideHello();
  const row = document.createElement("div");
  row.className = "row bot";
  const cls = dotClass(turn);
  const foot = failed ? (retry ? '<button class="retry" type="button">重试</button>' : '<span>未计入轮数</span>')
    : `<span>${turn} 共 20</span><span class="dot ${cls}"></span>`;
  row.innerHTML = `
    <div class="bot-card">
      <div class="bot-body"></div>
      <div class="bot-foot">${foot}</div>
    </div>`;
  if (retry) row.querySelector(".retry").addEventListener("click", retry);
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
  attachBtn.disabled = on;
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
    if (m.role === 'user') addUser(m.content, m.images, m.imagesDropped);
    else if (isFailed(m)) {
      addBotBubble(m.error, turn + 1, { failed: true, retry: m === chat.messages.at(-1) ? () => retry(chat, m) : null });
    } else if (m.role === 'assistant') {
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

form.addEventListener('submit', e => {
  e.preventDefault();
  const text = input.value.trim();
  if ((!text && !pending.length) || busy || input.disabled) return;
  const images = pending;
  pending = []; paintPending();
  input.value = ''; autosize();
  send(text, images);
});

// Only the newest two messages with pictures send them again; older ones become a note, so a long chat fits the context.
const IMAGE_TURNS = 2;
function upstreamMessage(m, withImages) {
  if (m.role === 'assistant') return m.reasoning ? { role: m.role, content: m.content, reasoning_content: m.reasoning } : { role: m.role, content: m.content };
  const count = m.images?.length || m.imagesDropped || 0;
  if (!count) return { role: m.role, content: m.content };
  if (!withImages || !m.images?.length) return { role: m.role, content: `（发了 ${count} 张图片）` + (m.content ? '\n' + m.content : '') };
  return { role: m.role, content: [...m.images.map(url => ({ type: 'image_url', image_url: { url } })), ...(m.content ? [{ type: 'text', text: m.content }] : [])] };
}

// Drop the failed reply and the message it answered, then send that message again.
function retry(chat, answer) {
  const i = chat.messages.indexOf(answer);
  if (busy || currentChat() !== chat || i < 1 || chat.messages[i - 1].role !== 'user') return;
  const [user] = chat.messages.splice(i - 1, 2);
  save(); openChat(chat.id); send(user.content, user.images || []);
}

async function send(text, images = []) {
  if (!currentChat()) startChat();
  setBusy(true); director?.stop();
  const chat = currentChat();
  chat.messages.push(images.length ? { role: 'user', content: text, images } : { role: 'user', content: text });
  if (chat.messages.length === 1) chat.title = Array.from(text || '图片').slice(0, 22).join('');
  let imageTurns = IMAGE_TURNS;
  const context = chat.messages.filter((m, i) => (m.role === 'user' || m.content) && !isFailed(m) && !isFailed(chat.messages[i + 1])).slice(-40)
    .reverse().map(m => upstreamMessage(m, m.images?.length > 0 && imageTurns-- > 0)).reverse();
  const answer = { role: 'assistant', content: '', reasoning: '' };
  const turn = turnCount(chat) + 1;
  chat.messages.push(answer); chat.updated = Date.now(); save(); paintHist();
  addUser(text, images);
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
  let queueRow = null;
  const onQueue = ahead => {
    if (!ahead) { queueRow?.remove(); queueRow = null; return; }
    if (!queueRow) { queueRow = document.createElement('div'); queueRow.className = 'queue-note'; thread.appendChild(queueRow); }
    queueRow.textContent = `Sydney 正在回复别人，排队中，前面还有 ${ahead} 条…`;
    thread.scrollTop = thread.scrollHeight;
  };
  const parser = new ProtocolDecoder({ text: chunk => sentences.push(chunk), emotion: emotion => sentences.setEmotion(emotion), reasoning: onReasoning });
  const finishParsing = () => { if (!ended) { ended = true; parser.end(); sentences.flush(); } };
  try {
    await actorsReady;
    const response = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: context, ...(settings.remote_settings_only ? { thinking: settings.thinking } : {}) }), signal: ownController.signal,
    });
    if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error(err.error || response.statusText); }
    const sse = new SSEDecoder(event => {
      if (ownController.signal.aborted) return;
      if (event.error) throw new Error(event.error);
      if (event.queue !== undefined) onQueue(event.queue);
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
      answer.error = error.message || '出错了';
      addBotBubble(answer.error, turn, isFailed(answer) ? { failed: true, retry: () => retry(chat, answer) } : {});
    }
  } finally {
    onQueue(0);
    if (thinkRow) thinkRow.querySelector('summary').textContent = '思考';
    await director?.whenIdle();
    ownController.signal.removeEventListener('abort', interrupt);
    // 只认 <end/> 协议；以前按“结束这场对话”字样判断，连“我不想结束这场对话”也会锁住对话。
    if (!answer.interrupted && !answer.error) chat.ended = endsChat(answer.content);
    controller = null; chat.updated = Date.now(); save(); setBusy(false); refresh(); input.focus();
  }
}
stopBtn.addEventListener('click', () => { controller?.abort(); });
window.addEventListener('pagehide', () => { director?.stop(); controller?.abort(); save(); });

async function fillSettings() {
  const response = await fetch('/api/settings');
  const s = await response.json();
  if (!response.ok) throw new Error(s.error || response.statusText);
  // The public page cannot touch the shared server settings; its thinking switch is kept per browser.
  if (s.remote_settings_only && typeof state.thinking === 'boolean') s.thinking = state.thinking;
  settings = s;
  document.getElementById('modal').classList.toggle('remote', s.remote_settings_only === true);
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
  for (const id of ['adapter-sel', 'preset-sel', 'sys-prompt', 'apply', 'unload']) {
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
  if (settings.remote_settings_only) {
    state.thinking = settings.thinking = document.getElementById('think-on').checked;
    state.expandThinking = expandThinking; save();
    for (const card of document.querySelectorAll('.think-card')) card.open = expandThinking;
    refresh(); document.getElementById('modal').hidden = true;
    return;
  }
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
