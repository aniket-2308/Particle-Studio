// Studio UI — wires the controls panel, drag/drop, export and Supabase library
// to the shared particle engine (js/engine.js). Rendering/sampling/animation
// all live in the engine now; this file is glue + persistence.

import { createParticleStudio, THREE } from './engine.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { createClient } from '@supabase/supabase-js';

// ---- Backend (Supabase): model files in public storage (for embeds); the
//      Library list itself is LOCAL to this browser, never shared — see below. ----
const SUPABASE_URL = 'https://exjemvfvuvgoyhovwhkx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_2V2OfOlixSXDWj4wNknohA_ftiBU7SF';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Hosted embed loader (uploaded into the public `models` bucket under embed/)
const EMBED_LOADER = `${SUPABASE_URL}/storage/v1/object/public/models/embed/embed.js`;

// Short, URL-safe id (no ambiguous chars) for scene links
function shortId(len = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (let i = 0; i < len; i++) s += chars[bytes[i] % chars.length];
  return s;
}

// ---- Color mix: the cloud blends ALL swatches at equal weight ----
const DEFAULT_PALETTE = ['#00e5ff'];   // start with one cyan
let palette = DEFAULT_PALETTE.slice();
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const ACCENT_ALIASES = { plum: '#8052ff', amber: '#ffb829', electric_blue: '#2f6bff', lichen: '#15846e', bone: '#ffffff' };

// Equal-weight stops across the whole palette -> engine picks a weighted-random
// color per particle, so every swatch is mixed into the cloud.
function accentStops() {
  const w = 1 / Math.max(1, palette.length);
  return palette.map(h => [new THREE.Color(h), w]);
}
function applyAccent() { studio?.setConfig({ accent: accentStops() }); }

// ---- Hover effects (engine animation keys) ----
const FX = [
  { key: 'idle',               label: 'None' },
  { key: 'explode_on_hover',   label: 'Supernova' },
  { key: 'dent_out_on_hover',  label: 'Bulge' },
  { key: 'dent_at_cursor',     label: 'Dimple' },
];
const FX_KEYS = FX.map(f => f.key);
let hoverFx = 'idle';
let hoverIntensity = 1.0;

// ---- DOM ----
const stage = document.getElementById('stage');
const dropzone = document.getElementById('dropzone');
const panel = document.getElementById('panel');
const panelToggle = document.getElementById('panelToggle');
const panelHeader = document.getElementById('panelHeader');
const reloadPill = document.getElementById('reloadBtn');
const fileInput = document.getElementById('fileInput');
const countSlider = document.getElementById('countSlider');
const sizeSlider  = document.getElementById('sizeSlider');
const densSlider  = document.getElementById('densSlider');
const paraSlider  = document.getElementById('paraSlider');
const status = document.getElementById('status');
function setStatus(s) { status.textContent = s; }

// ---- Error toast (bottom-left, auto-dismiss + click-to-dismiss) ----
const toast = document.getElementById('toast');
let toastTimer = null;
function showToast(msg) {
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 4000);
}
function hideToast() { clearTimeout(toastTimer); toast?.classList.remove('visible'); }
toast?.addEventListener('click', hideToast);

// ---- Settings persistence (single namespaced localStorage blob) ----
const SETTINGS_KEY = 'particleStudio_settings';
const DEFAULT_SETTINGS = { particleCount: 9000, size: 1.0, densBias: 0.6, parallax: 1.0 };

let studio = null;        // engine instance, created lazily on first load
let loadedFile = null;
let currentModel = null;  // { id, file_path } of the loaded model, for scene links

function currentConfig() {
  return {
    particleCount: parseInt(countSlider.value, 10),
    size: parseFloat(sizeSlider.value),
    densBias: parseFloat(densSlider.value),
    parallaxStrength: parseFloat(paraSlider.value),
    accent: accentStops(),
    animation: hoverFx,
    hoverIntensity,
    autoRotate: true,
  };
}

// ---- Settings persistence ----
// Palette persists as a plain hex array.
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      particleCount: parseInt(countSlider.value, 10),
      size: parseFloat(sizeSlider.value),
      densBias: parseFloat(densSlider.value),
      parallax: parseFloat(paraSlider.value),
      palette: palette.slice(),
      hoverFx,
      hoverIntensity,
    }));
  } catch (e) { /* private mode / quota — non-fatal */ }
}

function syncLabels() {
  countVal.textContent = countSlider.value;
  sizeVal.textContent = parseFloat(sizeSlider.value).toFixed(1);
  densVal.textContent = parseFloat(densSlider.value).toFixed(2);
  paraVal.textContent = parseFloat(paraSlider.value).toFixed(1);
}

// Restore slider + accent state into the DOM (runs before swatches/engine exist).
function loadSettings() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); }
  catch (e) { console.warn('[particle-studio] bad saved settings, using defaults'); }
  if (!s || typeof s !== 'object') { syncLabels(); return; }

  if (Number.isFinite(s.particleCount)) countSlider.value = s.particleCount;
  if (Number.isFinite(s.size)) sizeSlider.value = s.size;
  if (Number.isFinite(s.densBias)) densSlider.value = s.densBias;
  if (Number.isFinite(s.parallax)) paraSlider.value = s.parallax;
  syncLabels();

  if (Array.isArray(s.palette)) {
    const clean = s.palette.filter(h => typeof h === 'string' && HEX_RE.test(h));
    if (clean.length) palette = clean;
  } else if (typeof s.accent === 'string') {     // migrate old single-accent setting
    const hex = HEX_RE.test(s.accent) ? s.accent : ACCENT_ALIASES[s.accent];
    if (hex) palette = [hex];
  }

  if (FX_KEYS.includes(s.hoverFx)) hoverFx = s.hoverFx;
  if (Number.isFinite(s.hoverIntensity)) hoverIntensity = s.hoverIntensity;
  intensitySlider.value = hoverIntensity;
  intensityVal.textContent = hoverIntensity.toFixed(1);
}

function resetSettings() {
  try { localStorage.removeItem(SETTINGS_KEY); } catch (e) { /* ignore */ }
  countSlider.value = DEFAULT_SETTINGS.particleCount;
  sizeSlider.value = DEFAULT_SETTINGS.size;
  densSlider.value = DEFAULT_SETTINGS.densBias;
  paraSlider.value = DEFAULT_SETTINGS.parallax;
  syncLabels();
  palette = DEFAULT_PALETTE.slice();
  hoverFx = 'idle';
  hoverIntensity = 1.0;
  intensitySlider.value = hoverIntensity;
  intensityVal.textContent = hoverIntensity.toFixed(1);
  closeColorPop();
  renderPalette();
  renderFx();
  studio?.setConfig({
    particleCount: DEFAULT_SETTINGS.particleCount, size: DEFAULT_SETTINGS.size,
    densBias: DEFAULT_SETTINGS.densBias, parallaxStrength: DEFAULT_SETTINGS.parallax,
    accent: accentStops(), animation: hoverFx, hoverIntensity,
  });
  saveSettings();
  setStatus('Settings reset to defaults');
}

// ---- File loading ----
async function loadFile(file) {
  if (!file) return;
  const hadStudio = !!studio;       // so a first-load failure leaves the dropzone clean
  loadedFile = file;
  setStatus('Sampling…');
  try {
    if (!studio) studio = createParticleStudio(stage, currentConfig());
    else studio.setConfig(currentConfig());
    await studio.loadModelFromFile(file);
    dropzone.classList.add('hidden');
    panel.classList.add('visible');
    reloadPill.classList.add('visible');
    hideToast();                    // clear any prior error on success
    setStatus(`Loaded · ${studio.getPointCount().toLocaleString()} particles · drag cursor to parallax`);
    saveToLibrary(file);
  } catch (err) {
    console.error('[particle-studio] file load failed:', err);
    // Keep any existing cloud visible; only tear down a studio we just created.
    if (!hadStudio && studio) { studio.dispose(); studio = null; }
    setStatus('');
    showToast("Couldn't open that file — try a different one.");
  }
}

['dragenter','dragover'].forEach(ev => addEventListener(ev, e => {
  e.preventDefault(); dropzone.classList.add('dragging');
}));
['dragleave','drop'].forEach(ev => addEventListener(ev, e => {
  e.preventDefault(); dropzone.classList.remove('dragging');
}));
addEventListener('drop', e => loadFile(e.dataTransfer.files[0]));
document.getElementById('browseBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => loadFile(e.target.files[0]));
reloadPill.addEventListener('click', () => {
  dropzone.classList.remove('hidden'); panel.classList.remove('visible'); reloadPill.classList.remove('visible');
  if (studio) { studio.dispose(); studio = null; }
  setStatus('');
});

// ---- Controls ----
countSlider.oninput = () => { countVal.textContent = countSlider.value; studio?.setConfig({ particleCount: parseInt(countSlider.value, 10) }); saveSettings(); };
sizeSlider.oninput  = () => { sizeVal.textContent = parseFloat(sizeSlider.value).toFixed(1); studio?.setConfig({ size: parseFloat(sizeSlider.value) }); saveSettings(); };
densSlider.oninput  = () => { densVal.textContent = parseFloat(densSlider.value).toFixed(2); studio?.setConfig({ densBias: parseFloat(densSlider.value) }); saveSettings(); };
paraSlider.oninput  = () => { paraVal.textContent = parseFloat(paraSlider.value).toFixed(1); studio?.setConfig({ parallaxStrength: parseFloat(paraSlider.value) }); saveSettings(); };
document.getElementById('resetBtn').addEventListener('click', resetSettings);

// ---- Palette swatches + edit popover ----
const swatchWrap = document.getElementById('swatches');
const colorPop = document.getElementById('colorPop');
const popColor = document.getElementById('popColor');
const popHex = document.getElementById('popHex');
const popSave = document.getElementById('popSave');
const popDelete = document.getElementById('popDelete');
const EDIT_SVG = '<span class="swatch-edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></span>';
let editIdx = -1;

function swatchEls() { return [...swatchWrap.querySelectorAll('.swatch:not(.swatch-add)')]; }

function renderPalette() {
  swatchWrap.innerHTML = '';
  palette.forEach((hex, i) => {
    const el = document.createElement('button');
    el.className = 'swatch';
    el.style.background = hex;
    el.title = 'Click to edit';
    el.innerHTML = EDIT_SVG;
    el.onclick = () => openColorPop(i, el);
    swatchWrap.appendChild(el);
  });
  const add = document.createElement('button');
  add.className = 'swatch swatch-add';
  add.title = 'Add color';
  add.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
  add.onclick = addColor;
  swatchWrap.appendChild(add);
}

function addColor() {
  palette.push('#ffffff');
  renderPalette();
  applyAccent();
  saveSettings();
  const els = swatchEls();
  openColorPop(palette.length - 1, els[els.length - 1]);  // edit it immediately
}

function positionPop(anchorEl) {
  const r = anchorEl.getBoundingClientRect();
  const w = 180, h = 150;
  let left = r.left - w - 12;                 // sit to the LEFT of the swatch (panel is on the right)
  if (left < 12) left = r.right + 12;         // flip to the right if no room
  const top = Math.max(12, Math.min(innerHeight - h - 12, r.top - 8));
  colorPop.style.left = left + 'px';
  colorPop.style.top = top + 'px';
}

function openColorPop(i, anchorEl) {
  editIdx = i;
  popColor.value = palette[i];
  popHex.value = palette[i];
  popDelete.disabled = palette.length <= 1;   // never delete the last color
  positionPop(anchorEl);
  colorPop.classList.add('visible');
}
function closeColorPop() { colorPop.classList.remove('visible'); editIdx = -1; }

function updateEditColor(hex) {
  if (editIdx < 0 || !HEX_RE.test(hex)) return;
  palette[editIdx] = hex;
  const els = swatchEls();
  if (els[editIdx]) els[editIdx].style.background = hex;  // live swatch preview
  applyAccent();                                          // live cloud preview
}

popColor.oninput = () => { popHex.value = popColor.value; updateEditColor(popColor.value); };
popHex.oninput = () => { const v = popHex.value.trim(); if (HEX_RE.test(v)) { popColor.value = v; updateEditColor(v); } };
popSave.onclick = () => { saveSettings(); closeColorPop(); setStatus('Color saved'); };
popDelete.onclick = () => {
  if (palette.length <= 1) return;
  palette.splice(editIdx, 1);
  closeColorPop();
  renderPalette();
  applyAccent();
  saveSettings();
};
// Dismiss popover on outside click
addEventListener('pointerdown', e => {
  if (colorPop.classList.contains('visible') && !colorPop.contains(e.target) && !e.target.closest('.swatch')) closeColorPop();
});

// ---- Hover-effect picker + intensity ----
const fxGroup = document.getElementById('fxGroup');
const intensityRow = document.getElementById('intensityRow');
const intensitySlider = document.getElementById('intensitySlider');
const intensityVal = document.getElementById('intensityVal');

function renderFx() {
  fxGroup.innerHTML = '';
  FX.forEach(fx => {
    const b = document.createElement('button');
    b.className = 'fx-btn' + (fx.key === hoverFx ? ' active' : '');
    b.textContent = fx.label;
    b.onclick = () => {
      hoverFx = fx.key;
      renderFx();
      studio?.setConfig({ animation: hoverFx });
      saveSettings();
    };
    fxGroup.appendChild(b);
  });
  intensityRow.hidden = hoverFx === 'idle';   // intensity only relevant for an active effect
}

intensitySlider.oninput = () => {
  hoverIntensity = parseFloat(intensitySlider.value);
  intensityVal.textContent = hoverIntensity.toFixed(1);
  studio?.setConfig({ hoverIntensity });
  saveSettings();
};

loadSettings();      // restore sliders + palette + hover fx before first paint
renderPalette();
renderFx();

// ---- Particle export (Download particles .glb) ----
// Current resting point cloud -> binary glTF (POINTS primitive, vertex colors)
function exportParticlesGLB() {
  return new Promise((resolve, reject) => {
    if (!studio) return reject(new Error('No particles to export'));
    const { positions, colors } = studio.exportPositionsColors();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.02, vertexColors: true }));
    pts.name = 'particles';
    new GLTFExporter().parse(pts, resolve, reject, { binary: true });
  });
}

document.getElementById('downloadBtn').addEventListener('click', async () => {
  if (!studio) { setStatus('No model loaded'); return; }
  try {
    const buf = await exportParticlesGLB();
    const blob = new Blob([buf], { type: 'model/gltf-binary' });
    const base = (loadedFile?.name || 'model').replace(/\.(glb|gltf)$/i, '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${base}-particles.glb`;
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus(`Particles downloaded · ${studio.getPointCount().toLocaleString()} points`);
  } catch (err) {
    console.error(err);
    setStatus('Export failed.');
  }
});

// ---- Copy embed link: save current model + tuning as a Supabase scene ----
document.getElementById('embedBtn').addEventListener('click', async () => {
  if (!studio || !currentModel) { setStatus('Load a model first'); return; }
  try {
    setStatus('Creating embed link…');
    const config = {
      particleCount: parseInt(countSlider.value, 10),
      size: parseFloat(sizeSlider.value),
      densBias: parseFloat(densSlider.value),
      parallaxStrength: parseFloat(paraSlider.value),
      accent: palette.slice(),          // hex array -> engine mixes equally
      animation: hoverFx, hoverIntensity, autoRotate: true,
    };
    const id = shortId();
    const { error } = await supabase.from('scenes').insert({
      id, model_id: null, file_path: currentModel.file_path,
      name: loadedFile?.name || null, config,
    });
    if (error) throw error;
    const link = `<script src="${EMBED_LOADER}?s=${id}"><\/script>`;
    await navigator.clipboard.writeText(link);
    setStatus('Embed link copied · paste into any page');
  } catch (err) {
    console.error(err);
    setStatus('Could not create embed link');
  }
});

// ---- Library: auto-save dropped models + history UI ----
const historyPanel = document.getElementById('historyPanel');
const historyList = document.getElementById('historyList');
const historyBtn = document.getElementById('historyBtn');
const dzHistoryWrap = document.getElementById('dzHistoryWrap');
const dzHistory = document.getElementById('dzHistory');

let libraryRows = [];

// ---- Local library store (per-browser, never shared) ----
// The model FILE still lives in public storage (embeds need it), but the LIST of
// what you uploaded is kept only in this browser, so no other device can see it.
const LIBRARY_KEY = 'particleStudio_library';
function loadLibrary() {
  try { const v = JSON.parse(localStorage.getItem(LIBRARY_KEY)); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function saveLibrary(rows) {
  try { localStorage.setItem(LIBRARY_KEY, JSON.stringify(rows)); } catch (e) { console.warn(e); }
}

// Downscale a JPEG blob to a small (~256px) data URL so thumbs fit in localStorage.
async function blobToThumbDataURL(blob, side = 256) {
  try {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas'); c.width = c.height = side;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, side, side);
    ctx.drawImage(bmp, 0, 0, side, side);
    bmp.close?.();
    return c.toDataURL('image/jpeg', 0.7);
  } catch { return null; }
}

function mimeForName(name) {
  return name.toLowerCase().endsWith('.gltf') ? 'model/gltf+json' : 'model/gltf-binary';
}
function fmtBytes(n) {
  if (!n) return '';
  return n < 1024 * 1024 ? (n / 1024).toFixed(0) + ' KB' : (n / (1024 * 1024)).toFixed(1) + ' MB';
}
function fmtAge(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
  return new Date(iso).toLocaleDateString();
}
function escapeHtml(s) {
  return s.replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
}
function publicUrl(path) {
  return supabase.storage.from('models').getPublicUrl(path).data.publicUrl;
}

async function saveToLibrary(file) {
  try {
    setStatus('Loaded · saving to library…');
    // Dedup against THIS browser's local library (name + size).
    const rows = loadLibrary();
    const dup = rows.find(r => r.name === file.name && r.size_bytes === file.size);
    if (dup) {
      currentModel = { id: dup.id, file_path: dup.file_path };
      setStatus('Loaded · already in library'); return;
    }

    const id = crypto.randomUUID();
    const filePath = `files/${id}-${file.name.replace(/[^\w.\-]+/g, '_')}`;
    const { error: upErr } = await supabase.storage.from('models')
      .upload(filePath, file, { contentType: mimeForName(file.name), cacheControl: '31536000' });
    if (upErr) throw upErr;

    // let the spin settle into a representative frame, then keep the thumb LOCAL
    await new Promise(r => setTimeout(r, 600));
    let thumb = null;
    if (loadedFile === file && studio) {   // skip thumb if another model superseded this one
      const blob = await studio.snapshotJPEG(512);
      if (blob) thumb = await blobToThumbDataURL(blob);
    }

    rows.unshift({ id, name: file.name, file_path: filePath, thumb, size_bytes: file.size,
                   created_at: new Date().toISOString() });
    saveLibrary(rows);

    currentModel = { id, file_path: filePath };
    setStatus('Loaded · saved to library');
    refreshHistory();
  } catch (err) {
    console.error(err);
    setStatus('Loaded · save failed — working offline');
  }
}

async function openFromLibrary(row) {
  setStatus('Fetching from library…');
  try {
    const res = await fetch(publicUrl(row.file_path));
    if (!res.ok) throw new Error('storage fetch ' + res.status);
    const blob = await res.blob();
    currentModel = { id: row.id, file_path: row.file_path };
    historyPanel.classList.remove('visible');
    loadFile(new File([blob], row.name, { type: mimeForName(row.name) }));
  } catch (err) {
    console.error(err);
    setStatus('');
    showToast('Couldn’t fetch that model from the library.');
  }
}

async function deleteFromLibrary(row, btn) {
  if (!btn.classList.contains('confirm')) {
    btn.classList.add('confirm'); btn.textContent = 'sure?';
    setTimeout(() => { btn.classList.remove('confirm'); btn.textContent = '×'; }, 2500);
    return;
  }
  // Remove from this browser's library. The storage file is intentionally NOT
  // deleted: anon delete would require a storage SELECT policy, which would also
  // expose file listing. The orphaned file stays unlisted + unguessable (and any
  // embed you already shared keeps working).
  saveLibrary(loadLibrary().filter(r => r.id !== row.id));
  refreshHistory();
}

function makeCard(row) {
  const el = document.createElement('div');
  el.className = 'hcard';
  const thumb = row.thumb
    ? `<img src="${row.thumb}" alt="" loading="lazy">`
    : `<div class="hthumb-empty">no preview</div>`;
  el.innerHTML = `${thumb}
    <div class="hmeta">
      <div class="hname" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</div>
      <div class="hsub">${fmtBytes(row.size_bytes)} · ${fmtAge(row.created_at)}</div>
    </div>
    <button class="hdel" title="Delete">×</button>`;
  el.onclick = () => openFromLibrary(row);
  const del = el.querySelector('.hdel');
  del.onclick = e => { e.stopPropagation(); deleteFromLibrary(row, del); };
  return el;
}

function renderHistory() {
  historyList.innerHTML = '';
  if (!libraryRows.length) {
    historyList.innerHTML = '<p class="hempty">Nothing saved yet — drop a model to start your library.</p>';
  } else {
    libraryRows.forEach(row => historyList.appendChild(makeCard(row)));
  }
  dzHistory.innerHTML = '';
  dzHistoryWrap.hidden = !libraryRows.length;
  libraryRows.slice(0, 4).forEach(row => dzHistory.appendChild(makeCard(row)));
}

function refreshHistory() {
  libraryRows = loadLibrary();   // local to this browser; already newest-first
  renderHistory();
}

// Mobile: tapping the panel header (title or chevron) collapses/expands the
// controls drawer. On desktop the chevron is hidden and .expanded is a no-op,
// so the header click does nothing visible.
panelHeader.addEventListener('click', () => {
  const expanded = panel.classList.toggle('expanded');
  panelToggle.setAttribute('aria-expanded', String(expanded));
});

historyBtn.addEventListener('click', () => historyPanel.classList.toggle('visible'));
refreshHistory();
