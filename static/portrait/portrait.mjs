import { EMOTIONS, splitEmoji, speechTimeline, speechProgress } from './protocol.mjs?v=emoji-loop-1';
import { createEmojiSea } from './emoji-sea.mjs?v=bing-emoji-1';
const $ = id => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const preferences = { particles: true, mouth: true, speed: 1 };

class Portrait {
  constructor(manifest) {
    this.manifest = manifest; this.layers = [$('portrait-a'), $('portrait-b')]; this.active = 0; this.emotion = 'calm'; this.sequence = 0; this.frame = 0; this.images = new Map();
    this.emojiSea = createEmojiSea($('stage'), $('sea'));
    this.layers[0].dataset.emotion = 'calm';
    this.applyLayer(this.layers[0], 'calm');
    this.preload('calm').then(async () => {
      for (const emotion of Object.keys(EMOTIONS)) {
        try { await this.preload(emotion); } catch {}
      }
    }).catch(console.error);
  }
  preload(emotion) {
    if (!this.images.has(emotion)) {
      const entry = this.manifest.emotions[emotion];
      this.images.set(emotion, Promise.all([entry.body, entry.mouth.image].map(src => new Promise((resolve, reject) => {
        const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error(`素材加载失败：${emotion}`)); image.src = src;
      }))));
    }
    return this.images.get(emotion);
  }
  applyLayer(layer, emotion) {
    const entry = this.manifest.emotions[emotion]; layer.dataset.emotion = emotion;
    const body = layer.querySelector('.body-sprite'); body.src = entry.body; body.alt = `Sydney，${EMOTIONS[emotion].label}的表情`;
    layer.querySelector('.mouth-atlas').src = entry.mouth.image;
    this.applyMouth(layer, this.frame);
  }
  async setEmotion(emotion, particles = false) {
    if (!EMOTIONS[emotion]) return;
    const seq = ++this.sequence;
    try { await this.preload(emotion); } catch (error) { console.error(error.message); return; }
    if (seq !== this.sequence) return;
    if (emotion !== this.emotion) {
      const old = this.layers[this.active]; const nextIndex = 1 - this.active; const next = this.layers[nextIndex];
      this.applyLayer(next, emotion); next.setAttribute('aria-hidden', 'false'); old.setAttribute('aria-hidden', 'true');
      next.classList.add('active'); old.classList.remove('active'); this.active = nextIndex; this.emotion = emotion;
    }
    $('stage').dataset.emotion = emotion;
    $('stage').style.setProperty('--emotion', EMOTIONS[emotion].color);
    if (particles) this.particles([EMOTIONS[emotion].emoji]);
  }
  applyMouth(layer, frame) {
    const emotion = layer.dataset.emotion; if (!emotion) return;
    const entry = this.manifest.emotions[emotion], mouth = entry.mouth;
    const rect = mouth.frames[frame]; const [x, y, w, h] = rect;
    const scale = entry.anchor.width / mouth.referenceWidth;
    const crop = layer.querySelector('.mouth-crop'), atlas = layer.querySelector('.mouth-atlas');
    crop.style.left = `${entry.anchor.x / this.manifest.width * 100}%`;
    crop.style.top = `${entry.anchor.y / this.manifest.height * 100}%`;
    crop.style.width = `${w * scale / this.manifest.width * 100}%`;
    crop.style.height = `${h * scale / this.manifest.height * 100}%`;
    crop.style.transform = `translate(-50%, -50%) rotate(${entry.anchor.rotation}deg)`;
    atlas.style.width = `${mouth.width / w * 100}%`; atlas.style.height = `${mouth.height / h * 100}%`;
    atlas.style.left = `${-x / w * 100}%`; atlas.style.top = `${-y / h * 100}%`;
    crop.dataset.frame = String(frame);
  }
  setMouth(frame) { this.frame = frame; this.layers.forEach(layer => this.applyMouth(layer, frame)); }
  particles(symbols) {
    if (!symbols.length || !preferences.particles || reducedMotion.matches || document.hidden) return;
    this.emojiSea.burst(symbols);
  }
  startParticles(symbols) {
    if (!preferences.particles || reducedMotion.matches || document.hidden) { this.emojiSea.stop(); return; }
    this.emojiSea.start(symbols);
  }
  updateParticles(symbols) { this.emojiSea.update(symbols); }
  stopParticles() { this.emojiSea.stop(); }
  clearParticles() { this.emojiSea.clear(); }
}

class SpeechDirector {
  constructor(portrait) { this.portrait = portrait; this.queue = []; this.running = false; this.generation = 0; this.timer = 0; this.currentPart = null; this.idleWaiters = []; }
  whenIdle() {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }
  resolveIdle() { for (const resolve of this.idleWaiters.splice(0)) resolve(); }
  enqueue(part) {
    if (document.hidden) { part.onProgress?.(part.text); return; }
    this.queue.push(part); if (!this.running) this.next();
  }
  async next() {
    const part = this.queue.shift();
    if (!part) { this.running = false; this.portrait.stopParticles(); this.portrait.setMouth(0); $('stage').classList.remove('speaking'); this.resolveIdle(); return; }
    this.running = true; this.currentPart = part;
    const generation = this.generation;
    await this.portrait.setEmotion(part.emotion);
    if (generation !== this.generation) return;
    const timeline = speechTimeline(part.text, preferences.speed);
    this.portrait.startParticles(splitEmoji(part.text).emoji);
    if (!timeline.duration) {
      part.onProgress?.(part.text); this.currentPart = null; this.portrait.stopParticles(); this.next(); return;
    }
    $('stage').classList.add('speaking');
    const start = performance.now();
    const pattern = [0, 1, 2, 1, 2, 1, 0, 1];
    let displayed = null;
    const step = () => {
      if (generation !== this.generation) return;
      const elapsed = performance.now() - start;
      const progress = speechProgress(timeline, elapsed);
      if (displayed !== progress.text) {
        displayed = progress.text; part.onProgress?.(progress.text);
        this.portrait.updateParticles(progress.pendingEmoji);
      }
      if (progress.done) {
        this.currentPart = null; this.portrait.stopParticles(); this.portrait.setMouth(0);
        this.timer = setTimeout(() => this.next(), 180 / preferences.speed); return;
      }
      const pause = !progress.character.trim() || /[，。！？、；：,.!?;:]/.test(progress.character) || splitEmoji(progress.character).emoji.length;
      const frame = !preferences.mouth || pause ? 0 : pattern[Math.floor(elapsed * preferences.speed / 105) % pattern.length];
      this.portrait.setMouth(frame);
      this.timer = setTimeout(step, 75);
    };
    step();
  }
  stop({ finish = true } = {}) {
    this.generation++; this.portrait.sequence++; clearTimeout(this.timer);
    const pending = [this.currentPart, ...this.queue];
    this.currentPart = null; this.queue = []; this.running = false;
    if (finish) for (const part of pending) part?.onProgress?.(part.text);
    this.portrait.setMouth(0); this.portrait.clearParticles(); $('stage').classList.remove('speaking');
    this.resolveIdle();
  }
}


export async function createPortrait() {
  const response = await fetch('/assets/manifest.json');
  if (!response.ok) throw new Error('立绘素材加载失败');
  const portrait = new Portrait(await response.json());
  const director = new SpeechDirector(portrait);
  document.addEventListener('visibilitychange', () => { if (document.hidden) director.stop(); });
  window.addEventListener('pagehide', () => director.stop());
  return { portrait, director };
}
