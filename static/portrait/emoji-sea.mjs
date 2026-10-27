// emojiSea: emoji particles floating up behind the portrait.
// Its burst algorithm and animation parameters are kept verbatim.
export function createEmojiSea(stage, sea) {
  function emojiSea(list) {
    const n = Math.min(70, 26 * list.length), H = stage.clientHeight;
    for (let i = 0; i < n; i++) {
      const e = document.createElement('span');
      e.textContent = list[Math.floor(Math.random() * list.length)];
      const size = 22 + Math.random() * 46, x = Math.random() * 100, drift = (Math.random() - 0.5) * 160, spin = (Math.random() - 0.5) * 120;
      e.style.cssText = `left:${x}%;font-size:${size}px`;
      sea.append(e);
      e.animate([
        { transform: 'translate(0, 0) rotate(0deg)', opacity: 0 },
        { opacity: 0.95, offset: 0.12 },
        { opacity: 0.85, offset: 0.75 },
        { transform: `translate(${drift}px, ${-(H + size * 2)}px) rotate(${spin}deg)`, opacity: 0 },
      ], { duration: 2600 + Math.random() * 2600, delay: Math.random() * 1400, easing: 'cubic-bezier(.2,.6,.4,1)', fill: 'both' }).onfinish = () => e.remove();
    }
  }

  let loopTimer = null, symbols = [];
  function stop() {
    clearInterval(loopTimer); loopTimer = null; symbols = [];
    sea.dataset.looping = 'false';
  }

  return {
    burst: emojiSea,
    start(list) {
      stop(); symbols = [...list];
      if (!symbols.length) return;
      sea.dataset.looping = 'true';
      emojiSea(symbols);
      loopTimer = setInterval(() => emojiSea(symbols), 2600);
    },
    update(list) {
      symbols = [...list];
      if (!symbols.length) stop();
    },
    stop,
    clear() {
      stop();
      for (const element of sea.children) {
        for (const animation of element.getAnimations()) animation.cancel();
      }
      sea.replaceChildren();
    },
  };
}
