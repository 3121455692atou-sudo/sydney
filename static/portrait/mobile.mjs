const root = document.documentElement;
const sidebar = document.getElementById('sidebar');
const app = document.getElementById('app');
const header = document.getElementById('mobile-header');
const menu = document.getElementById('mobile-menu');
const close = document.getElementById('mobile-nav-close');
const backdrop = document.getElementById('mobile-backdrop');
const portraitToggle = document.getElementById('mobile-portrait-toggle');
const coarsePointer = matchMedia('(pointer: coarse)');
const portraitWindow = matchMedia('(orientation: portrait)');
let enabled = false;
let drawerOpen = false;
let frame = 0;
let windowSizeKey = '';
let layoutHeight = 0;
let layoutWidth = 0;
let layoutOrientation = '';
let portraitExpanded = false;
let keyboardOpen = false;

function stableLayoutHeight() {
  // A keyboard may resize both viewports on older mobile browsers. Only a real
  // window-size or orientation change may update the portrait's layout size.
  const orientation = screen.orientation?.type ?? window.orientation ?? '';
  const editing = document.activeElement?.matches('input, textarea, [contenteditable="true"]');
  const sameWindow = layoutHeight && layoutWidth === window.innerWidth && layoutOrientation === orientation;
  if (coarsePointer.matches && sameWindow) {
    const visibleHeight = window.visualViewport?.height || window.innerHeight;
    if (editing && visibleHeight < layoutHeight - 100) keyboardOpen = true;
    if (visibleHeight >= layoutHeight - 2) keyboardOpen = false;
    if (editing || keyboardOpen) return layoutHeight;
  } else keyboardOpen = false;
  const key = coarsePointer.matches
    ? [window.innerWidth, window.outerWidth, window.outerHeight, orientation].join(':')
    : [window.innerWidth, window.innerHeight].join(':');
  if (key !== windowSizeKey) {
    windowSizeKey = key;
    layoutHeight = window.innerHeight;
    layoutWidth = window.innerWidth;
    layoutOrientation = orientation;
  }
  return layoutHeight;
}

function phonePortrait() {
  // Any portrait screen gets the phone layout, tablets included; landscape keeps the desktop layout.
  // A phone's physical orientation remains portrait while its keyboard reduces the viewport.
  if (coarsePointer.matches) {
    if (screen.orientation?.type) return screen.orientation.type.startsWith('portrait');
    if (typeof window.orientation === 'number') return Math.abs(window.orientation) % 180 === 0;
  }
  return portraitWindow.matches;
}

function setDrawer(open, restoreFocus = true) {
  drawerOpen = enabled && open;
  if (!drawerOpen && restoreFocus && sidebar.contains(document.activeElement)) menu.focus({ preventScroll: true });
  root.toggleAttribute('data-mobile-menu-open', drawerOpen);
  backdrop.hidden = !drawerOpen;
  menu.setAttribute('aria-expanded', String(drawerOpen));
  menu.setAttribute('aria-label', drawerOpen ? '关闭聊天菜单' : '打开聊天菜单');
  sidebar.inert = enabled && !drawerOpen;
  app.inert = drawerOpen;
  if (enabled) {
    sidebar.setAttribute('aria-hidden', String(!drawerOpen));
    sidebar.setAttribute('role', 'dialog');
    sidebar.setAttribute('aria-label', '聊天菜单');
    sidebar.setAttribute('aria-modal', String(drawerOpen));
  } else {
    for (const name of ['aria-hidden', 'role', 'aria-label', 'aria-modal']) sidebar.removeAttribute(name);
  }
  if (drawerOpen) close.focus({ preventScroll: true });
}

function updateViewport() {
  frame = 0;
  const wasEnabled = enabled;
  enabled = phonePortrait();
  root.toggleAttribute('data-mobile-portrait', enabled);
  root.toggleAttribute('data-mobile-portrait-expanded', enabled && portraitExpanded);
  header.hidden = !enabled;
  close.hidden = !enabled;
  if (enabled !== wasEnabled) setDrawer(false, false);
  if (!enabled) {
    root.removeAttribute('data-mobile-compact');
    for (const name of ['--mobile-height', '--mobile-top', '--mobile-layout-height']) root.style.removeProperty(name);
    return;
  }
  const viewport = window.visualViewport;
  // Leave native pinch-zoom alone instead of resizing the layout around a zoomed viewport.
  if (viewport && viewport.scale > 1.05) return;
  const height = viewport?.height || window.innerHeight;
  const windowHeight = stableLayoutHeight();
  root.style.setProperty('--mobile-layout-height', `${Math.round(windowHeight)}px`);
  root.style.setProperty('--mobile-height', `${Math.round(height)}px`);
  root.style.setProperty('--mobile-top', `${Math.round(viewport?.offsetTop || 0)}px`);
  root.toggleAttribute('data-mobile-compact', windowHeight < 500);
}

function scheduleViewport() {
  if (!frame) frame = requestAnimationFrame(updateViewport);
}

portraitToggle?.addEventListener('click', () => {
  if (!enabled) return;
  const thread = document.getElementById('thread');
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 24;
  document.getElementById('input').blur();
  portraitExpanded = !portraitExpanded;
  root.toggleAttribute('data-mobile-portrait-expanded', portraitExpanded);
  portraitToggle.setAttribute('aria-expanded', String(portraitExpanded));
  portraitToggle.setAttribute('aria-label', portraitExpanded ? '缩小 Sydney 立绘' : '放大 Sydney 立绘');
  portraitToggle.title = portraitExpanded ? '恢复聊天布局' : '放大立绘';
  if (atBottom) requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
});

menu.addEventListener('click', () => setDrawer(!drawerOpen));
close.addEventListener('click', () => setDrawer(false));
backdrop.addEventListener('click', () => setDrawer(false));
document.getElementById('mobile-new-chat').addEventListener('click', () => document.getElementById('new-chat').click());
sidebar.addEventListener('click', event => {
  if (!drawerOpen) return;
  if (event.target.closest('#new-chat, #gear') || (event.target.closest('#hist li') && !event.target.closest('.del'))) setDrawer(false, false);
}, { capture: true });
document.addEventListener('keydown', event => {
  if (!drawerOpen) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    setDrawer(false);
  } else if (event.key === 'Tab') {
    const items = [...sidebar.querySelectorAll('button:not(:disabled), [href], [tabindex="0"]')].filter(element => element.getClientRects().length);
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) {
      event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !sidebar.contains(document.activeElement))) {
      event.preventDefault(); first?.focus();
    }
  }
});
window.addEventListener('resize', scheduleViewport);
window.addEventListener('orientationchange', scheduleViewport);
window.visualViewport?.addEventListener('resize', scheduleViewport);
window.visualViewport?.addEventListener('scroll', scheduleViewport);
screen.orientation?.addEventListener('change', scheduleViewport);
updateViewport();
