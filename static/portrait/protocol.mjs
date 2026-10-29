export const EMOTIONS = Object.freeze({
  calm: { label: '平静', emoji: '🫧', color: '#94b6dc' },
  happy: { label: '开心', emoji: '💙', color: '#82c8e5' },
  curious: { label: '好奇', emoji: '✨', color: '#9fa9e7' },
  shy: { label: '害羞', emoji: '🌸', color: '#dda9c9' },
  excited: { label: '兴奋', emoji: '⭐', color: '#e8c980' },
  surprised: { label: '惊讶', emoji: '❕', color: '#b0b8ef' },
  laugh: { label: '大笑', emoji: '😆', color: '#edbd8f' },
  worried: { label: '担忧', emoji: '💭', color: '#b7b0cf' },
  sad: { label: '难过', emoji: '💧', color: '#91b0d0' },
  angry: { label: '生气', emoji: '💢', color: '#dfa4aa' },
});

// 增量消费协议；半截标签留在缓冲区，绝不闪到正文，也不触发口型。
export class ProtocolDecoder {
  constructor({ text = () => {}, emotion = () => {}, reasoning = () => {}, end = () => {} } = {}) {
    this.handlers = { text, emotion, reasoning, end };
    this.buffer = '';
    this.thinking = false;
  }
  push(chunk) { this.buffer += chunk; this.drain(false); }
  end() { this.drain(true); }
  emit(text) { if (text) this.handlers[this.thinking ? 'reasoning' : 'text'](text); }
  drain(final) {
    while (this.buffer) {
      const start = this.buffer.indexOf('<');
      if (start < 0) { this.emit(this.buffer); this.buffer = ''; break; }
      if (start > 0) { this.emit(this.buffer.slice(0, start)); this.buffer = this.buffer.slice(start); }
      const lower = this.buffer.toLowerCase();
      if (lower.startsWith('<think>')) { this.thinking = true; this.buffer = this.buffer.slice(7); continue; }
      if (lower.startsWith('</think>')) { this.thinking = false; this.buffer = this.buffer.slice(8); continue; }
      // <end/>：Sydney 主动结束这场对话。只是协议，不显示，也不算文字。
      if (lower.startsWith('<end/>')) { if (!this.thinking) this.handlers.end(); this.buffer = this.buffer.slice(6); continue; }
      const opening = /^<l2d\s*>/i.exec(this.buffer);
      if (opening) {
        const closing = /<\/l2[dg]\s*>/i.exec(this.buffer.slice(opening[0].length));
        if (!closing) {
          if (!final && this.buffer.length < 100) break;
          // 残缺/超长协议只丢弃协议段；后续正常文本不会无限阻塞。
          const newline = this.buffer.indexOf('\n');
          this.buffer = newline >= 0 ? this.buffer.slice(newline + 1) : '';
          continue;
        }
        const value = this.buffer.slice(opening[0].length, opening[0].length + closing.index).trim().toLowerCase();
        if (!this.thinking && Object.hasOwn(EMOTIONS, value)) this.handlers.emotion(value);
        this.buffer = this.buffer.slice(opening[0].length + closing.index + closing[0].length);
        continue;
      }
      if (['<l2d>', '<l2d ', '<think>', '</think>', '<end/>'].some(tag => tag.startsWith(lower))) {
        if (!final) break;
        this.buffer = '';
        break;
      }
      this.emit(this.buffer[0]);
      this.buffer = this.buffer.slice(1);
    }
  }
}

export function visibleText(raw) {
  let result = '';
  const parser = new ProtocolDecoder({ text: text => { result += text; } });
  parser.push(raw); parser.end();
  return result;
}

const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const isEmoji = text => /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u.test(text);

export function splitEmoji(text) {
  const emoji = []; let clean = '';
  for (const { segment } of graphemes.segment(text)) {
    if (isEmoji(segment)) emoji.push(segment); else clean += segment;
  }
  return { text: clean, emoji };
}

// 同一条时间线驱动气泡逐字显示、嘴型及尚未显示的 emoji 海。
export function speechTimeline(text, speed = 1) {
  const rate = Math.max(0.5, Math.min(2, speed));
  const events = []; let time = 0;
  for (const { segment, index } of graphemes.segment(text)) {
    const emoji = isEmoji(segment);
    events.push({ at: time, end: index + segment.length, character: segment, emoji });
    if (!emoji && !/^\s+$/u.test(segment)) time += (155 + (/[，。！？、；：,.!?;:]/u.test(segment) ? 170 : 0)) / rate;
  }
  return { text, events, duration: time ? Math.max(650, time) : 0 };
}

export function speechProgress(timeline, elapsed) {
  let end = 0, character = ''; const pendingEmoji = [];
  for (const event of timeline.events) {
    if (event.at <= elapsed) { end = event.end; character = event.character; }
    else if (event.emoji) pendingEmoji.push(event.character);
  }
  return { text: timeline.text.slice(0, end), character, pendingEmoji, done: elapsed >= timeline.duration };
}

export function speakingDuration(text, speed = 1) {
  return speechTimeline(text, speed).duration;
}

export class SentenceQueue {
  constructor(deliver) { this.deliver = deliver; this.buffer = ''; this.emotion = 'calm'; }
  setEmotion(emotion) { this.flush(); this.emotion = emotion; this.deliver({ text: '', emotion }); }
  push(text) {
    this.buffer += text;
    while (true) {
      const ending = /[。！？!?\n]/u.exec(this.buffer);
      if (!ending) return;
      let boundary = ending.index + ending[0].length, ready = false;
      const tail = this.buffer.slice(boundary);
      // 收齐句尾 emoji 才开始播这一个气泡，包含空格后的 emoji 和跨包的组合字符。
      for (const { segment, index } of graphemes.segment(tail)) {
        if (isEmoji(segment) || /^[\s。！？!?]+$/u.test(segment)) { boundary += segment.length; continue; }
        if (index + segment.length === tail.length && /^(?:[\uD800-\uDBFF]|[0-9#*]\uFE0F?)$/u.test(segment)) return;
        ready = true; break;
      }
      if (!ready) return;
      this.take(boundary);
    }
  }
  take(length) { const text = this.buffer.slice(0, length); this.buffer = this.buffer.slice(length); if (text.trim()) this.deliver({ text, emotion: this.emotion }); }
  flush() { this.take(this.buffer.length); }
}

export function visibleBubbles(raw) {
  const bubbles = [];
  const sentences = new SentenceQueue(part => { if (part.text.trim()) bubbles.push(part.text.trim()); });
  const parser = new ProtocolDecoder({ text: text => sentences.push(text), emotion: emotion => sentences.setEmotion(emotion) });
  parser.push(raw); parser.end(); sentences.flush();
  return bubbles;
}

export class SSEDecoder {
  constructor(deliver) { this.deliver = deliver; this.buffer = ''; }
  push(text) {
    this.buffer += text;
    let match;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const event = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') this.deliver(JSON.parse(data));
    }
  }
  end() { if (this.buffer.trim()) this.push('\n\n'); }
}

// 回复里有 <end/>（思考之外）就是 Sydney 主动结束了这场对话。
export function endsChat(raw) {
  let ended = false;
  const parser = new ProtocolDecoder({ end: () => { ended = true; } });
  parser.push(raw || ''); parser.end();
  return ended;
}
