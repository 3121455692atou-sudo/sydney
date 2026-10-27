// 2023 年 New Bing 的 emoji 样式：Windows 10 版 Segoe UI Emoji（粗黑描边、扁平黄色）。
// 字体在本站 /assets/fonts/seguiemj-win10.ttf（个人使用，打包时排除）；字体里没有的新 emoji 退回系统字体。
const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const isEmoji = text => /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]️?⃣/u.test(text);

// 把 root 里文字节点中的 emoji 包进 span.bing-emoji，让它们用这套字体显示；代码块里的不动。
export function decorateEmoji(root) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => (node.parentElement?.closest('code, pre, .bing-emoji') || !isEmoji(node.nodeValue)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const frag = document.createDocumentFragment(); let text = '';
    for (const { segment } of graphemes.segment(node.nodeValue)) {
      if (!isEmoji(segment)) { text += segment; continue; }
      if (text) { frag.append(text); text = ''; }
      const span = document.createElement('span');
      span.className = 'bing-emoji'; span.textContent = segment;
      frag.append(span);
    }
    if (text) frag.append(text);
    node.replaceWith(frag);
  }
}
