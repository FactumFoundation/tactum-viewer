/** "181.4 × 230.9 mm" from scan metadata, or null when not metric. */
export function physicalDimensionsMM(metadata) {
  const { imageWidth, imageHeight, pixelSizeMM } = metadata ?? {};
  if (!imageWidth || !imageHeight || !pixelSizeMM) return null;
  const w = (imageWidth * pixelSizeMM).toFixed(1);
  const h = (imageHeight * pixelSizeMM).toFixed(1);
  return `${w} × ${h} mm`;
}

/**
 * "Selene PSS · 23.9 µm/px" when info.json names a scanner, otherwise just
 * "23.9 µm/px". Returns null without a physical pixel size.
 */
export function scannerLine(info, metadata) {
  const pixelSizeMM = metadata?.pixelSizeMM;
  if (!pixelSizeMM) return null;
  const px = `${(pixelSizeMM * 1000).toFixed(1)} µm/px`;
  return info?.scanner ? `${info.scanner} · ${px}` : px;
}

/**
 * Museum-plaque info overlay. Fetches <tileBase>/info.json;
 * if absent, the toggle button stays hidden and nothing else changes.
 */
export class InfoOverlay {
  constructor({ metadata, infoUrl, button }) {
    this._btn = button;
    this._panel = document.createElement('div');
    this._panel.id = 'infoOverlay';
    document.body.appendChild(this._panel);
    this.visible = false;

    fetch(infoUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then((info) => {
        if (!info) return;
        this._render(info, metadata);
        this._btn.style.display = 'flex';
        this._btn.onclick = () => this.toggle();
      })
      .catch(() => {});
  }

  toggle() {
    this.visible = !this.visible;
    this._panel.style.display = this.visible ? 'block' : 'none';
    this._btn.classList.toggle('active', this.visible);
  }

  _render(info, metadata) {
    const dims = physicalDimensionsMM(metadata);
    const scan = scannerLine(info, metadata);
    const line = (cls, text) => (text ? `<div class="${cls}">${text}</div>` : '');
    this._panel.innerHTML =
      line('io-title', info.title) +
      line('io-author', [info.author, info.date].filter(Boolean).join(', ')) +
      line('io-detail', info.technique) +
      line('io-detail', info.collection) +
      line('io-detail', dims) +
      line('io-scan', scan) +
      line('io-desc', info.description);
  }

  dispose() { this._panel.remove(); }
}
