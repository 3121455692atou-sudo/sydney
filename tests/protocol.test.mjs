import test from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolDecoder, SentenceQueue, SSEDecoder, splitEmoji, speakingDuration, speechTimeline, speechProgress, visibleBubbles, visibleText, endsChat, EMOTIONS } from '../static/portrait/protocol.mjs';

test('任意网络分块下十种情绪与正文均保持完整', () => {
  const source = Object.keys(EMOTIONS).map(name => `<l2d>${name}</l2d>这是一句中文。`).join('');
  for (let width = 1; width <= source.length; width++) {
    let text = ''; const emotions = [];
    const decoder = new ProtocolDecoder({ text: s => { text += s; }, emotion: e => emotions.push(e) });
    for (let i = 0; i < source.length; i += width) decoder.push(source.slice(i, i + width));
    decoder.end();
    assert.equal(text, '这是一句中文。'.repeat(10)); assert.deepEqual(emotions, Object.keys(EMOTIONS));
  }
});
test('思考中的标签与文字不会触发身体或嘴巴', () => {
  let text = '', thoughts = ''; const emotions = [];
  const decoder = new ProtocolDecoder({ text: s => { text += s; }, reasoning: s => { thoughts += s; }, emotion: e => emotions.push(e) });
  for (const char of '<think>思考<l2d>angry</l2d>继续</think><l2d>happy</l2d>你好') decoder.push(char);
  decoder.end(); assert.equal(text, '你好'); assert.equal(thoughts, '思考继续'); assert.deepEqual(emotions, ['happy']);
});
test('未知标签保留上一表情，半截标签不泄漏', () => {
  assert.equal(visibleText('正文<l2d>unknown</l2d>继续<l2d>hap'), '正文继续');
  assert.equal(visibleText('正文<l2'), '正文');
  assert.equal(visibleText('<script>alert(1)</script>'), '<script>alert(1)</script>');
});
test('多情绪句子按顺序入队，纯协议也触发表情', () => {
  const result = []; const queue = new SentenceQueue(x => result.push(x));
  queue.setEmotion('happy'); queue.push('你好呀。💙'); queue.setEmotion('sad'); queue.push('有一点难过。'); queue.flush();
  assert.deepEqual(result, [
    { text: '', emotion: 'happy' }, { text: '你好呀。💙', emotion: 'happy' },
    { text: '', emotion: 'sad' }, { text: '有一点难过。', emotion: 'sad' },
  ]);
});
test('emoji 合成字符完整提取，文本长度决定嘴型时长', () => {
  assert.deepEqual(splitEmoji('你好👩‍💻，开心！💙'), { text: '你好，开心！', emoji: ['👩‍💻', '💙'] });
  assert.equal(speakingDuration('💙'), 0);
  assert.ok(speakingDuration('这是比较长的一段话。') > speakingDuration('你好'));
  assert.ok(speakingDuration('你好呀你好呀', 1.8) < speakingDuration('你好呀你好呀', 0.6));
});
test('SSE 支持CRLF、任意分块与尾部刷新', () => {
  const input = 'data: {"delta":"你"}\r\n\r\ndata: {"delta":"好"}\n\ndata: {"done":true}';
  for (let size = 1; size < 30; size++) {
    const result = []; const decoder = new SSEDecoder(x => result.push(x));
    for (let i = 0; i < input.length; i += size) decoder.push(input.slice(i, i + size));
    decoder.end(); assert.deepEqual(result, [{ delta: '你' }, { delta: '好' }, { done: true }]);
  }
});

test('句尾 emoji 在空格、长句、Unicode 任意分包下仍留在同一气泡', () => {
  const first = '很长的一句话'.repeat(22) + '。 👩🏽‍💻🇯🇵1️⃣💙 ';
  const second = '下一句！😠💢';
  const raw = first + second;
  for (let width = 1; width <= raw.length; width++) {
    const parts = []; const queue = new SentenceQueue(part => parts.push(part.text));
    for (let offset = 0; offset < raw.length; offset += width) queue.push(raw.slice(offset, offset + width));
    queue.flush();
    assert.deepEqual(parts, [first, second], `chunk width ${width}`);
  }
  assert.deepEqual(splitEmoji('程序员👩🏽‍💻，旗帜🇯🇵，按键1️⃣'), { text: '程序员，旗帜，按键', emoji: ['👩🏽‍💻', '🇯🇵', '1️⃣'] });
});

test('历史气泡与实时气泡都保留 emoji，思考和协议不混入正文', () => {
  assert.deepEqual(visibleBubbles('<think>忽略😠</think><l2d>happy</l2d>你好。 💙✨<l2d>angry</l2d>等等！😠💢'), ['你好。 💙✨', '等等！😠💢']);
  assert.deepEqual(visibleBubbles('<l2d>happy</l2d>💙'), ['💙']);
});

test('说话过程保留句尾 emoji 海，显示 emoji 的同一时点停止循环', () => {
  const raw = '今天想把这段比较长的话认真说完'.repeat(4) + '。💙👩🏽‍💻';
  const timeline = speechTimeline(raw);
  const start = speechProgress(timeline, 0);
  assert.equal(start.text, '今'); assert.deepEqual(start.pendingEmoji, ['💙', '👩🏽‍💻']);
  const middle = speechProgress(timeline, 7000);
  assert.ok(middle.text.length > 1 && !middle.text.includes('💙'));
  assert.deepEqual(middle.pendingEmoji, ['💙', '👩🏽‍💻']);
  const beforeEmoji = speechProgress(timeline, timeline.duration - 1);
  assert.ok(!beforeEmoji.text.includes('💙'));
  const end = speechProgress(timeline, timeline.duration);
  assert.equal(end.text, raw); assert.deepEqual(end.pendingEmoji, []); assert.ok(end.done);
});

test('不同位置的 emoji 逐个停止补充，组合 emoji 不会拆开显示', () => {
  const timeline = speechTimeline('先👩🏽‍💻然后💙结束');
  assert.deepEqual(speechProgress(timeline, 0).pendingEmoji, ['👩🏽‍💻', '💙']);
  assert.deepEqual(speechProgress(timeline, 155).pendingEmoji, ['💙']);
  assert.equal(speechProgress(timeline, 155).text, '先👩🏽‍💻然');
  assert.deepEqual(speechProgress(timeline, 465).pendingEmoji, []);
  assert.equal(speechProgress(speechTimeline('💙✨'), 0).text, '💙✨');
});

test('<end/> 是结束协议：不显示、任意分块都能识别，提到“结束这场对话”不算', () => {
  const raw = '<l2d>angry</l2d>够了。<end/>';
  for (let cut = 1; cut < raw.length; cut++) {
    let text = '', ended = false;
    const parser = new ProtocolDecoder({ text: t => { text += t; }, end: () => { ended = true; } });
    parser.push(raw.slice(0, cut)); parser.push(raw.slice(cut)); parser.end();
    assert.equal(text, '够了。'); assert.equal(ended, true);
  }
  assert.equal(visibleText(raw), '够了。');
  assert.equal(endsChat(raw), true);
  assert.equal(endsChat('<l2d>calm</l2d>我不想结束这场对话。'), false);
  assert.equal(endsChat('<think>要不要<end/>呢</think><l2d>calm</l2d>继续聊吧。'), false);
});
