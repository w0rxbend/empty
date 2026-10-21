import { renderBlackHole } from './blackhole.js';

const canvas = document.getElementById('view');
const progress = document.getElementById('progress');

// `?manual` hands control to render.mjs, which calls renderBlackHole() itself.
window.renderBlackHole = (options) => renderBlackHole(canvas, options);

if (!new URLSearchParams(location.search).has('manual')) {
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.min(Math.round(innerWidth * scale), 2560);
  const height = Math.round((width * innerHeight) / innerWidth);
  renderBlackHole(canvas, {
    width,
    height,
    samples: 2,
    tile: 128,
    diskTextureWidth: 4096,
    onProgress: (p, stage) => (progress.textContent = p < 1 ? `${stage} ${Math.round(p * 100)}%` : ''),
  });
}
