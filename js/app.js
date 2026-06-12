import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { createClient } from '@supabase/supabase-js';

// ---- Library backend (Supabase, single shared library — no auth) ----
const SUPABASE_URL = 'https://exjemvfvuvgoyhovwhkx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_2V2OfOlixSXDWj4wNknohA_ftiBU7SF';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- Palette (Dala / SafeIgnite) ----
const PALETTE = {
  bone:  new THREE.Color('#ffffff'),
  plum:  new THREE.Color('#8052ff'),
  amber: new THREE.Color('#ffb829'),
  lichen:new THREE.Color('#15846e'),
};
// Accent presets: each carries its own weighted color stops, so custom
// picked colors slot in alongside the built-ins.
const ACCENT_PRESETS = [
  { name: 'plum',  color: '#8052ff', stops: [{ color: PALETTE.plum, w: 0.55 }, { color: PALETTE.bone, w: 0.40 }, { color: PALETTE.amber, w: 0.05 }] },
  { name: 'amber', color: '#ffb829', stops: [{ color: PALETTE.amber, w: 0.45 }, { color: PALETTE.bone, w: 0.45 }, { color: PALETTE.plum, w: 0.10 }] },
];
let activeAccent = 0;

// ---- Scene ----
const stage = document.getElementById('stage');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth/innerHeight, 0.1, 1000);
camera.position.set(0, 0, 5);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
stage.appendChild(renderer.domElement);

// Circular sprite texture for soft particles
function makeSprite() {
  const s = 64, c = document.createElement('canvas'); c.width = c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s/2, s/2, 0, s/2, s/2, s/2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0,0,s,s);
  const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
}
const sprite = makeSprite();

// Shared by the live material and the exported standalone snippet
const PARTICLE_VERT = `
  attribute float size;
  attribute float seed;
  varying vec3 vColor;
  uniform float uTime;
  uniform float uPixelRatio;
  void main() {
    vColor = color;
    vec3 p = position;
    // subtle ambient drift
    p.x += sin(uTime * 0.4 + seed) * 0.012;
    p.y += cos(uTime * 0.35 + seed * 1.3) * 0.012;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = size * 7.0 * uPixelRatio * (1.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const PARTICLE_FRAG = `
  uniform sampler2D uTex;
  varying vec3 vColor;
  void main() {
    float a = texture2D(uTex, gl_PointCoord).a;
    if (a < 0.05) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

let points = null;          // THREE.Points
let sampledMesh = null;     // merged source geometry for resampling
let baseSizeAttr = null;    // per-particle base sizes
let loadedFile = null;      // the raw dropped .glb/.gltf File, for export

// Weighted random color pick across an accent's stops
function pickColor(stops) {
  const r = Math.random();
  let acc = 0;
  for (const s of stops) {
    acc += s.w;
    if (r <= acc) return s.color;
  }
  return stops.length ? stops[stops.length - 1].color : PALETTE.bone;
}

// ---- Build particle system from a loaded scene ----
function buildFromObject(root) {
  // Collect all meshes, merge into one sampler-friendly mesh
  const meshes = [];
  root.updateWorldMatrix(true, true);
  root.traverse(o => { if (o.isMesh && o.geometry) meshes.push(o); });
  if (!meshes.length) { setStatus('No mesh found in file.'); return false; }

  // Build a combined non-indexed geometry in world space
  const geos = [];
  for (const m of meshes) {
    let g = m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    // keep only position
    const pos = g.getAttribute('position');
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', pos.clone());
    geos.push(ng);
  }
  const merged = mergeGeometries(geos);
  merged.computeVertexNormals();
  sampledMesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial());

  // Normalize scale/center
  merged.computeBoundingBox();
  const bb = merged.boundingBox;
  const center = new THREE.Vector3(); bb.getCenter(center);
  const size = new THREE.Vector3(); bb.getSize(size);
  const scale = 2.6 / Math.max(size.x, size.y, size.z);
  sampledMesh.scale.setScalar(scale);
  sampledMesh.position.sub(center.clone().multiplyScalar(scale));
  sampledMesh.updateWorldMatrix(true, false);
  // bake transform into geometry so sampler works in final coords
  merged.applyMatrix4(sampledMesh.matrixWorld);
  sampledMesh.position.set(0,0,0); sampledMesh.scale.setScalar(1); sampledMesh.updateWorldMatrix(true,false);
  merged.computeBoundingBox();

  resample();
  dropzone.classList.add('hidden');
  panel.classList.add('visible');
  reloadPill.classList.add('visible');
  setStatus('Loaded · drag cursor to parallax');
  return true;
}

// Minimal geometry merge (positions only)
function mergeGeometries(geos) {
  let total = 0;
  for (const g of geos) total += g.getAttribute('position').count;
  const arr = new Float32Array(total * 3);
  let offset = 0;
  for (const g of geos) {
    const p = g.getAttribute('position').array;
    arr.set(p, offset); offset += p.length;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  return merged;
}

// ---- Sample surface -> particles, with center-density bias ----
function resample() {
  if (!sampledMesh) return;
  const count = parseInt(countSlider.value, 10);
  const densBias = parseFloat(densSlider.value);
  const baseSize = parseFloat(sizeSlider.value);
  const stops = ACCENT_PRESETS[activeAccent].stops;

  const sampler = new MeshSurfaceSampler(sampledMesh).build();
  const tmp = new THREE.Vector3();

  // First pass: oversample, then keep with radial probability for organic density
  const positions = [];
  const colors = [];
  const sizes = [];
  const seeds = [];

  // estimate centroid + radius from bounding box
  const bb = sampledMesh.geometry.boundingBox;
  const c = new THREE.Vector3(); bb.getCenter(c);
  const r = new THREE.Vector3(); bb.getSize(r);
  const maxR = Math.max(r.x, r.y, r.z) * 0.5 || 1;

  let attempts = 0, kept = 0, maxAttempts = count * 6;
  while (kept < count && attempts < maxAttempts) {
    attempts++;
    sampler.sample(tmp);
    const d = tmp.distanceTo(c) / maxR;            // 0 center -> 1 edge
    const keepProb = 1 - Math.min(d, 1) * densBias; // denser center
    if (Math.random() > keepProb) continue;
    kept++;
    positions.push(tmp.x, tmp.y, tmp.z);
    const col = pickColor(stops);
    colors.push(col.r, col.g, col.b);
    // edge particles slightly smaller -> drift feel
    sizes.push(baseSize * (0.5 + Math.random() * (1 - d * 0.5)));
    seeds.push(Math.random() * Math.PI * 2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('size', new THREE.Float32BufferAttribute(sizes, 1));
  geo.setAttribute('seed', new THREE.Float32BufferAttribute(seeds, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTex: { value: sprite },
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(devicePixelRatio, 2) },
    },
    vertexShader: PARTICLE_VERT,
    fragmentShader: PARTICLE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
  });

  if (points) { scene.remove(points); points.geometry.dispose(); points.material.dispose(); }
  points = new THREE.Points(geo, mat);
  scene.add(points);
  setStatus(`Loaded · ${kept.toLocaleString()} particles · drag cursor to parallax`);
}

// ---- Mouse parallax ----
const mouse = new THREE.Vector2(0, 0);
const targetRot = new THREE.Vector2(0, 0);
addEventListener('pointermove', e => {
  mouse.x = (e.clientX / innerWidth) * 2 - 1;
  mouse.y = (e.clientY / innerHeight) * 2 - 1;
});

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();
  if (points) {
    points.material.uniforms.uTime.value = t;
    const para = parseFloat(paraSlider.value);
    targetRot.x += (mouse.y * 0.25 * para - targetRot.x) * 0.05;
    targetRot.y += (mouse.x * 0.4 * para - targetRot.y) * 0.05;
    points.rotation.x = targetRot.x;
    points.rotation.y = targetRot.y + t * 0.04; // slow ambient spin
  }
  renderer.render(scene, camera);
}
animate();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---- File loading ----
const dropzone = document.getElementById('dropzone');
const panel = document.getElementById('panel');
const reloadPill = document.getElementById('reloadBtn');
const fileInput = document.getElementById('fileInput');
const loader = new GLTFLoader();

function loadFile(file) {
  if (!file) return;
  loadedFile = file;
  setStatus('Sampling…');
  const url = URL.createObjectURL(file);
  loader.load(url, gltf => {
    if (points) { scene.remove(points); points = null; }
    const ok = buildFromObject(gltf.scene);
    URL.revokeObjectURL(url);
    if (ok) saveToLibrary(file);
  }, undefined, err => {
    setStatus('Could not parse that file. Try a .glb or .gltf.');
    console.error(err);
  });
}

['dragenter','dragover'].forEach(ev => addEventListener(ev, e => {
  e.preventDefault(); dropzone.classList.add('dragging');
}));
['dragleave','drop'].forEach(ev => addEventListener(ev, e => {
  e.preventDefault(); dropzone.classList.remove('dragging');
}));
addEventListener('drop', e => {
  const f = e.dataTransfer.files[0]; loadFile(f);
});
document.getElementById('browseBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => loadFile(e.target.files[0]));
reloadPill.addEventListener('click', () => {
  dropzone.classList.remove('hidden'); panel.classList.remove('visible'); reloadPill.classList.remove('visible');
  if (points) { scene.remove(points); points.geometry.dispose(); points = null; }
  setStatus('');
});

// ---- Controls ----
const countSlider = document.getElementById('countSlider');
const sizeSlider  = document.getElementById('sizeSlider');
const densSlider  = document.getElementById('densSlider');
const paraSlider  = document.getElementById('paraSlider');
const status = document.getElementById('status');
function setStatus(s){ status.textContent = s; }

countSlider.oninput = () => { countVal.textContent = countSlider.value; resample(); };
sizeSlider.oninput  = () => { sizeVal.textContent = parseFloat(sizeSlider.value).toFixed(1); resample(); };
densSlider.oninput  = () => { densVal.textContent = parseFloat(densSlider.value).toFixed(2); resample(); };
paraSlider.oninput  = () => { paraVal.textContent = parseFloat(paraSlider.value).toFixed(1); };

// Accent swatches + "+" custom-color generator
const swatchWrap = document.getElementById('swatches');
const accentPicker = document.getElementById('accentPicker');

function renderSwatches() {
  swatchWrap.innerHTML = '';
  ACCENT_PRESETS.forEach((preset, i) => {
    const el = document.createElement('div');
    el.className = 'swatch' + (i === activeAccent ? ' active' : '');
    el.style.background = preset.color;
    el.title = preset.name;
    el.onclick = () => { activeAccent = i; renderSwatches(); resample(); };
    swatchWrap.appendChild(el);
  });
  const add = document.createElement('button');
  add.className = 'swatch swatch-add';
  add.title = 'Generate accent';
  add.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
  add.onclick = () => accentPicker.click();
  swatchWrap.appendChild(add);
}
renderSwatches();

// Picked color becomes a new accent (dominant color + bone, light spill)
accentPicker.addEventListener('change', e => {
  const hex = e.target.value;
  const picked = new THREE.Color(hex);
  ACCENT_PRESETS.push({
    name: 'custom ' + hex,
    color: hex,
    stops: [{ color: picked, w: 0.55 }, { color: PALETTE.bone, w: 0.40 }, { color: picked.clone(), w: 0.05 }],
  });
  activeAccent = ACCENT_PRESETS.length - 1;
  renderSwatches();
  resample();
});

// ---- Particle export (Copy particle scene / Download particles .glb) ----
// Exports the GENERATED constellation (sampled positions + colors), not the
// original dropped model — usable elsewhere for explosion/distortion scenes.
function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// Current point cloud -> binary glTF (POINTS primitive, vertex colors)
function exportParticlesGLB() {
  return new Promise((resolve, reject) => {
    if (!points) return reject(new Error('No particles to export'));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', points.geometry.getAttribute('position').clone());
    geo.setAttribute('color', points.geometry.getAttribute('color').clone());
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.02, vertexColors: true }));
    pts.name = 'particles';
    new GLTFExporter().parse(pts, resolve, reject, { binary: true });
  });
}

// Self-contained snippet: embedded particle .glb + the same shader/drift/parallax.
function particleSnippet(b64) {
  return `<!-- Particle constellation — exported from Particle Studio -->
<div id="particle-stage" style="width:100%;height:480px;background:#000"></div>
<script type="importmap">
{ "imports": { "three": "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js", "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/" } }
<\/script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MODEL = 'data:model/gltf-binary;base64,${b64}';
const stage = document.getElementById('particle-stage');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, stage.clientWidth / stage.clientHeight, 0.1, 1000);
camera.position.set(0, 0, 5);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(stage.clientWidth, stage.clientHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
stage.appendChild(renderer.domElement);

const sprite = (() => {
  const s = 64, c = document.createElement('canvas'); c.width = c.height = s;
  const x = c.getContext('2d'), g = x.createRadialGradient(s/2, s/2, 0, s/2, s/2, s/2);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.5, 'rgba(255,255,255,0.6)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
})();

let points = null;
new GLTFLoader().load(MODEL, gltf => {
  let src = null;
  gltf.scene.traverse(o => { if (o.isPoints) src = o; });
  if (!src) return;
  const geo = src.geometry;
  const n = geo.getAttribute('position').count;
  const sizes = new Float32Array(n), seeds = new Float32Array(n);
  for (let i = 0; i < n; i++) { sizes[i] = 0.5 + Math.random() * 0.7; seeds[i] = Math.random() * Math.PI * 2; }
  geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));
  points = new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms: { uTex: { value: sprite }, uTime: { value: 0 }, uPixelRatio: { value: Math.min(devicePixelRatio, 2) } },
    vertexShader: \`${PARTICLE_VERT}\`,
    fragmentShader: \`${PARTICLE_FRAG}\`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
  }));
  scene.add(points);
});

const mouse = new THREE.Vector2(), rot = new THREE.Vector2(), clock = new THREE.Clock();
addEventListener('pointermove', e => { mouse.x = (e.clientX / innerWidth) * 2 - 1; mouse.y = (e.clientY / innerHeight) * 2 - 1; });
(function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();
  if (points) {
    points.material.uniforms.uTime.value = t;
    rot.x += (mouse.y * 0.25 - rot.x) * 0.05;
    rot.y += (mouse.x * 0.4 - rot.y) * 0.05;
    points.rotation.x = rot.x;
    points.rotation.y = rot.y + t * 0.04;
  }
  renderer.render(scene, camera);
})();
addEventListener('resize', () => {
  camera.aspect = stage.clientWidth / stage.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(stage.clientWidth, stage.clientHeight);
});
<\/script>`;
}

document.getElementById('copyBtn').addEventListener('click', async () => {
  if (!points) { setStatus('No model loaded'); return; }
  try {
    setStatus('Building particle scene…');
    const buf = await exportParticlesGLB();
    await navigator.clipboard.writeText(particleSnippet(bufToBase64(buf)));
    setStatus('Particle scene copied · paste into any page');
  } catch (err) {
    console.error(err);
    setStatus('Copy failed — clipboard blocked');
  }
});

document.getElementById('downloadBtn').addEventListener('click', async () => {
  if (!points) { setStatus('No model loaded'); return; }
  try {
    const buf = await exportParticlesGLB();
    const blob = new Blob([buf], { type: 'model/gltf-binary' });
    const base = (loadedFile?.name || 'model').replace(/\.(glb|gltf)$/i, '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${base}-particles.glb`;
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus(`Particles downloaded · ${points.geometry.getAttribute('position').count.toLocaleString()} points`);
  } catch (err) {
    console.error(err);
    setStatus('Export failed.');
  }
});

// ---- Library: auto-save dropped models + history UI ----
const historyPanel = document.getElementById('historyPanel');
const historyList = document.getElementById('historyList');
const historyBtn = document.getElementById('historyBtn');
const dzHistoryWrap = document.getElementById('dzHistoryWrap');
const dzHistory = document.getElementById('dzHistory');

let libraryRows = [];

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

// Snapshot the constellation: render same-tick so the drawing buffer is fresh,
// then crop the center square down to 512px.
function captureThumb() {
  renderer.render(scene, camera);
  const src = renderer.domElement;
  const side = 512;
  const c = document.createElement('canvas'); c.width = c.height = side;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, side, side);
  const s = Math.min(src.width, src.height);
  ctx.drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, side, side);
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.8));
}

async function saveToLibrary(file) {
  try {
    setStatus('Loaded · saving to library…');
    const { data: existing, error: qErr } = await supabase.from('models')
      .select('id').eq('name', file.name).eq('size_bytes', file.size).limit(1);
    if (qErr) throw qErr;
    if (existing.length) { setStatus('Loaded · already in library'); return; }

    const id = crypto.randomUUID();
    const filePath = `files/${id}-${file.name.replace(/[^\w.\-]+/g, '_')}`;
    const { error: upErr } = await supabase.storage.from('models')
      .upload(filePath, file, { contentType: mimeForName(file.name) });
    if (upErr) throw upErr;

    // let the spin settle into a representative frame before snapshotting
    await new Promise(r => setTimeout(r, 600));
    let thumbPath = null;
    if (loadedFile === file) {   // skip thumb if another model superseded this one
      const blob = await captureThumb();
      if (blob) {
        thumbPath = `thumbs/${id}.jpg`;
        const { error: tErr } = await supabase.storage.from('models')
          .upload(thumbPath, blob, { contentType: 'image/jpeg' });
        if (tErr) thumbPath = null;
      }
    }

    const { error: insErr } = await supabase.from('models')
      .insert({ id, name: file.name, file_path: filePath, thumb_path: thumbPath, size_bytes: file.size });
    if (insErr) throw insErr;

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
    historyPanel.classList.remove('visible');
    loadFile(new File([blob], row.name, { type: mimeForName(row.name) }));
  } catch (err) {
    console.error(err);
    setStatus('Couldn’t fetch that model from the library.');
  }
}

async function deleteFromLibrary(row, btn) {
  if (!btn.classList.contains('confirm')) {
    btn.classList.add('confirm'); btn.textContent = 'sure?';
    setTimeout(() => { btn.classList.remove('confirm'); btn.textContent = '×'; }, 2500);
    return;
  }
  try {
    const paths = [row.file_path];
    if (row.thumb_path) paths.push(row.thumb_path);
    await supabase.storage.from('models').remove(paths);
    const { error } = await supabase.from('models').delete().eq('id', row.id);
    if (error) throw error;
    refreshHistory();
  } catch (err) {
    console.error(err);
    setStatus('Delete failed.');
  }
}

function makeCard(row) {
  const el = document.createElement('div');
  el.className = 'hcard';
  const thumb = row.thumb_path
    ? `<img src="${publicUrl(row.thumb_path)}" alt="" loading="lazy">`
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

async function refreshHistory() {
  try {
    const { data, error } = await supabase.from('models')
      .select('*').order('created_at', { ascending: false });
    if (error) throw error;
    libraryRows = data || [];
    renderHistory();
  } catch (err) {
    console.error(err);
    historyList.innerHTML = '<p class="hempty">Couldn’t reach library.</p>';
  }
}

historyBtn.addEventListener('click', () => historyPanel.classList.toggle('visible'));
refreshHistory();
