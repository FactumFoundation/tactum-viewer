/**
 * Custom Ctrl+Click context menu: Tactum Viewer branding + screenshot.
 * Include via <script type="module" src="../context-menu.js"></script>
 */

const NAME = 'Tactum Viewer';
const VERSION = '0.1.0';
const COPYRIGHT = '\u00a9 2026 Jorge Cano';

// ── Build menu element ──────────────────────────────────────────────────

const menu = document.createElement('div');
menu.id = 'ctx-menu';
menu.innerHTML = `
  <div class="ctx-title">${NAME}</div>
  <div class="ctx-line">v${VERSION}</div>
  <div class="ctx-sep"></div>
  <div class="ctx-action" id="ctx-screenshot">Screenshot</div>
`;
document.body.appendChild(menu);

// ── Styles ──────────────────────────────────────────────────────────────

const style = document.createElement('style');
style.textContent = `
#ctx-menu {
  display: none;
  position: fixed;
  z-index: 9999;
  min-width: 160px;
  background: rgba(10, 10, 10, 0.94);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  padding: 10px 14px;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', 'Menlo', monospace;
  pointer-events: auto;
}
#ctx-menu .ctx-title {
  color: rgba(255, 255, 255, 0.85);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-bottom: 6px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
#ctx-menu .ctx-line {
  color: rgba(255, 255, 255, 0.35);
  font-size: 10px;
  letter-spacing: 0.04em;
  line-height: 1.8;
}
#ctx-menu .ctx-sep {
  height: 1px;
  background: rgba(255, 255, 255, 0.06);
  margin: 6px 0;
}
#ctx-menu .ctx-action {
  color: rgba(255, 255, 255, 0.55);
  font-size: 10px;
  letter-spacing: 0.04em;
  line-height: 1.8;
  cursor: pointer;
  padding: 2px 0;
  transition: color 0.15s;
}
#ctx-menu .ctx-action:hover {
  color: rgba(255, 255, 255, 0.9);
}
`;
document.head.appendChild(style);

// ── Prevent native context menu (RMB is used for panning) ───────────────

document.addEventListener('contextmenu', (e) => e.preventDefault());

// ── Ctrl+Click → show custom menu ──────────────────────────────────────

document.addEventListener('click', (e) => {
  if (e.ctrlKey) {
    e.preventDefault();
    e.stopPropagation();
    menu.style.display = 'block';

    // Position, keeping within viewport
    const x = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8);
    const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    return;
  }

  // Any non-Ctrl click hides the menu
  menu.style.display = 'none';
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') menu.style.display = 'none';
});

// ── Screenshot action ──────────────────────────────────────────────────

document.getElementById('ctx-screenshot').addEventListener('click', (e) => {
  e.stopPropagation();
  menu.style.display = 'none';

  const canvas = document.querySelector('canvas');
  if (!canvas) return;

  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tactum-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
});
