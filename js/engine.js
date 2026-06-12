// Particle Studio engine — config-driven particle cloud renderer.
// No DOM controls inside; everything comes from a config object.
// Consumed by: js/app.js (studio UI), embed.js (1-liner), factory.html (builder).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';

export { THREE };

// ---- Accent presets: weighted color stops ----
const C = hex => new THREE.Color(hex);
export const ACCENTS = {
  plum:          [[C('#8052ff'), .55], [C('#ffffff'), .40], [C('#ffb829'), .05]],
  amber:         [[C('#ffb829'), .45], [C('#ffffff'), .45], [C('#8052ff'), .10]],
  electric_blue: [[C('#2f6bff'), .50], [C('#7fd8ff'), .30], [C('#ffffff'), .20]],
  lichen:        [[C('#15846e'), .50], [C('#ffffff'), .40], [C('#8052ff'), .10]],
  bone:          [[C('#ffffff'), .70], [C('#9a9a9a'), .30]],
};

export const DEFAULTS = {
  animation: 'idle',          // idle | explode_on_hover | shape_shifter | dented
  shape: 'sphere',            // base generated shape when no model
  shapes: ['sphere', 'box', 'torus'], // morph targets for shape_shifter
  model: null,                // url to .glb/.gltf, or null for generated shape
  particleCount: 6000,
  size: 1.0,
  densBias: 0.6,              // center-density bias (model sampling only)
  parallaxStrength: 1.0,
  autoRotate: true,
  acceleration: 0.08,         // explode lerp speed (0–1)
  explosionRadius: 1.2,
  dentAmount: 0.5,
  hoverIntensity: 1.0,        // multiplier for hover-effect magnitude (read live)
  accent: 'plum',
};

// ---- Shaders (shared with exported snippet) ----
export const PARTICLE_VERT = `
  attribute float size;
  attribute float seed;
  varying vec3 vColor;
  uniform float uTime;
  uniform float uPixelRatio;
  void main() {
    vColor = color;
    vec3 p = position;
    p.x += sin(uTime * 0.4 + seed) * 0.012;
    p.y += cos(uTime * 0.35 + seed * 1.3) * 0.012;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = size * 7.0 * uPixelRatio * (1.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
export const PARTICLE_FRAG = `
  uniform sampler2D uTex;
  varying vec3 vColor;
  void main() {
    float a = texture2D(uTex, gl_PointCoord).a;
    if (a < 0.05) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

function makeSprite() {
  const s = 64, c = document.createElement('canvas'); c.width = c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s/2, s/2, 0, s/2, s/2, s/2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
}

// ---- Parametric shape generators (write n*3 into a Float32Array, ~2.6u extent) ----
const EXT = 1.3;
function genSphere(n) {
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = Math.random(), v = Math.random();
    const theta = 2 * Math.PI * u, phi = Math.acos(2 * v - 1);
    a[i*3]   = EXT * Math.sin(phi) * Math.cos(theta);
    a[i*3+1] = EXT * Math.sin(phi) * Math.sin(theta);
    a[i*3+2] = EXT * Math.cos(phi);
  }
  return a;
}
function genBox(n) {
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const face = Math.floor(Math.random() * 6);
    const u = (Math.random() * 2 - 1) * EXT, w = (Math.random() * 2 - 1) * EXT;
    let x, y, z;
    if (face === 0) { x = EXT; y = u; z = w; }
    else if (face === 1) { x = -EXT; y = u; z = w; }
    else if (face === 2) { y = EXT; x = u; z = w; }
    else if (face === 3) { y = -EXT; x = u; z = w; }
    else if (face === 4) { z = EXT; x = u; y = w; }
    else { z = -EXT; x = u; y = w; }
    a[i*3] = x; a[i*3+1] = y; a[i*3+2] = z;
  }
  return a;
}
function genTorus(n) {
  const a = new Float32Array(n * 3), R = 0.95, r = 0.42;
  for (let i = 0; i < n; i++) {
    const u = 2 * Math.PI * Math.random(), v = 2 * Math.PI * Math.random();
    a[i*3]   = (R + r * Math.cos(v)) * Math.cos(u);
    a[i*3+1] = (R + r * Math.cos(v)) * Math.sin(u);
    a[i*3+2] = r * Math.sin(v);
  }
  return a;
}
const SHAPE_GENS = { sphere: genSphere, box: genBox, cube: genBox, torus: genTorus };
function generateShape(name, n) {
  return (SHAPE_GENS[name] || genSphere)(n);
}

// ---- Sample a loaded glTF scene into n positions, with center-density bias ----
function sampleModel(root, n, densBias) {
  const meshes = [];
  root.updateWorldMatrix(true, true);
  root.traverse(o => { if (o.isMesh && o.geometry) meshes.push(o); });
  if (!meshes.length) return null;

  let total = 0;
  const geos = [];
  for (const m of meshes) {
    let g = m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    const pos = g.getAttribute('position');
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', pos.clone());
    geos.push(ng); total += pos.count;
  }
  const arr = new Float32Array(total * 3);
  let off = 0;
  for (const g of geos) { const p = g.getAttribute('position').array; arr.set(p, off); off += p.length; }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  merged.computeVertexNormals();

  const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial());
  merged.computeBoundingBox();
  const bb = merged.boundingBox;
  const center = new THREE.Vector3(); bb.getCenter(center);
  const size = new THREE.Vector3(); bb.getSize(size);
  const scale = 2.6 / Math.max(size.x, size.y, size.z);
  mesh.scale.setScalar(scale);
  mesh.position.sub(center.clone().multiplyScalar(scale));
  mesh.updateWorldMatrix(true, false);
  merged.applyMatrix4(mesh.matrixWorld);
  merged.computeBoundingBox();

  const sampler = new MeshSurfaceSampler(mesh).build();
  const tmp = new THREE.Vector3();
  const bc = new THREE.Vector3(); merged.boundingBox.getCenter(bc);
  const r = new THREE.Vector3(); merged.boundingBox.getSize(r);
  const maxR = Math.max(r.x, r.y, r.z) * 0.5 || 1;

  const out = new Float32Array(n * 3);
  let attempts = 0, kept = 0, maxAttempts = n * 6;
  while (kept < n && attempts < maxAttempts) {
    attempts++;
    sampler.sample(tmp);
    const d = tmp.distanceTo(bc) / maxR;
    if (Math.random() > 1 - Math.min(d, 1) * densBias) continue;
    out[kept*3] = tmp.x; out[kept*3+1] = tmp.y; out[kept*3+2] = tmp.z;
    kept++;
  }
  // fill any shortfall with sphere fallback
  for (let i = kept; i < n; i++) {
    const u = Math.random(), v = Math.random();
    const theta = 2 * Math.PI * u, phi = Math.acos(2 * v - 1);
    out[i*3] = EXT*Math.sin(phi)*Math.cos(theta);
    out[i*3+1] = EXT*Math.sin(phi)*Math.sin(theta);
    out[i*3+2] = EXT*Math.cos(phi);
  }
  return out;
}

function pickColor(stops) {
  const r = Math.random();
  let acc = 0;
  for (const [col, w] of stops) { acc += w; if (r <= acc) return col; }
  return stops[stops.length - 1][0];
}
function resolveAccent(accent) {
  if (Array.isArray(accent)) {
    if (typeof accent[0] === 'string') {               // list of hex -> equal-weight mix
      const w = 1 / accent.length;
      return accent.map(h => [new THREE.Color(h), w]);
    }
    return accent;                                     // raw [color, weight] stops
  }
  if (typeof accent === 'string' && accent[0] === '#') { // single hex custom accent
    const col = new THREE.Color(accent);
    return [[col, 0.55], [new THREE.Color('#ffffff'), 0.40], [col.clone(), 0.05]];
  }
  return ACCENTS[accent] || ACCENTS.plum;              // preset key
}
const ease = t => t * t * (3 - 2 * t); // smoothstep

// ---- Engine factory ----
export function createParticleStudio(container, userConfig = {}) {
  const cfg = { ...DEFAULTS, ...userConfig };

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  camera.position.set(0, 0, 5);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.appendChild(renderer.domElement);
  const sprite = makeSprite();

  let points = null;
  let homePos = null;     // resting shape positions (Float32Array n*3)
  let curPos = null;      // live positions written each frame
  let dirArr = null;      // normalized outward dir per particle
  let dentArr = null;     // per-particle dent magnitude
  let normArr = null;     // normalized home (dent direction)
  let shapesPos = [];     // morph targets for shape_shifter
  let morphFrom = 0, morphTo = 1, morphT = 0;
  let explodeT = 0;
  let modelPos = null;    // sampled model positions (if a model loaded)
  let lastModelScene = null; // retained glTF scene, for re-sampling on count/density change

  // interaction state
  const mouse = new THREE.Vector2(0, 0);
  let hovered = false;    // true only when the cursor is over the cloud disc, not the whole canvas
  let pointerInside = false;
  let boundR = 0;         // cloud bounding radius (max particle distance from origin)
  let hoverCx = 0, hoverCy = 0, hoverRx = 2, hoverRy = 2; // projected hover ellipse (NDC)
  const targetRot = new THREE.Vector2(0, 0);
  const dragRot = new THREE.Vector2(0, 0);   // extra rotation from click-drag, persists as spin
  const dragVel = new THREE.Vector2(0, 0);   // momentum after release
  let dragging = false, lastPX = 0, lastPY = 0;

  function size() {
    const w = container.clientWidth || container.offsetWidth || innerWidth;
    const h = container.clientHeight || container.offsetHeight || innerHeight;
    return { w: w || 1, h: h || 1 };
  }
  function resize() {
    const { w, h } = size();
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    computeHoverEllipse();
  }

  // Project the cloud's bounding sphere to a screen-space (NDC) ellipse, so the
  // hover effect only fires when the cursor is over the cloud — not the whole canvas.
  function computeHoverEllipse() {
    if (!boundR) { hoverCx = hoverCy = 0; hoverRx = hoverRy = 2; return; }
    camera.updateMatrixWorld();
    _mvp.multiplyMatrices(camera.projectionMatrix, _camInv.copy(camera.matrixWorld).invert());
    const right = _v.setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(boundR);
    const ex = right.applyMatrix4(_mvp).x;                         // NDC x at +R right
    const up = _v.setFromMatrixColumn(camera.matrixWorld, 1).multiplyScalar(boundR);
    const ey = up.applyMatrix4(_mvp).y;                            // NDC y at +R up
    const c = _v.set(0, 0, 0).applyMatrix4(_mvp);                  // cloud center in NDC
    hoverCx = c.x; hoverCy = c.y;
    hoverRx = Math.max(0.05, Math.abs(ex - hoverCx));
    hoverRy = Math.max(0.05, Math.abs(ey - hoverCy));
  }

  function updateHover() {
    if (!pointerInside) { hovered = false; return; }
    const dx = (mouse.x - hoverCx) / hoverRx, dy = (mouse.y - hoverCy) / hoverRy;
    hovered = (dx * dx + dy * dy) <= 1;                            // inside projected disc
  }

  // Scratch objects for the cursor-dent projection (avoid per-frame allocation)
  const _v = new THREE.Vector3();
  const _mv = new THREE.Matrix4();
  const _mvp = new THREE.Matrix4();
  const _camInv = new THREE.Matrix4();

  function basePositions(n) {
    if (modelPos && modelPos.length === n * 3) return modelPos.slice();
    return generateShape(cfg.shape, n);
  }

  function buildMorphTargets(n) {
    if (cfg.animation !== 'shape_shifter') { shapesPos = []; return; }
    if (modelPos && modelPos.length === n * 3) {
      shapesPos = [modelPos.slice(), generateShape('sphere', n), generateShape('torus', n)];
    } else {
      const names = (cfg.shapes && cfg.shapes.length) ? cfg.shapes : ['sphere', 'box', 'torus'];
      shapesPos = names.map(name => generateShape(name, n));
    }
    morphFrom = 0; morphTo = shapesPos.length > 1 ? 1 : 0; morphT = 0;
  }

  // Rebuild the whole point cloud (count / shape / accent / animation change)
  function rebuild() {
    const n = Math.max(100, cfg.particleCount | 0);
    homePos = basePositions(n);
    buildMorphTargets(n);
    if (cfg.animation === 'shape_shifter' && shapesPos.length) homePos = shapesPos[0].slice();
    curPos = homePos.slice();

    const stops = resolveAccent(cfg.accent);
    const colors = new Float32Array(n * 3);
    const sizes = new Float32Array(n);
    const seeds = new Float32Array(n);
    dirArr = new Float32Array(n * 3);
    normArr = new Float32Array(n * 3);
    dentArr = new Float32Array(n);

    let maxLen = 0;
    for (let i = 0; i < n; i++) {
      const col = pickColor(stops);
      colors[i*3] = col.r; colors[i*3+1] = col.g; colors[i*3+2] = col.b;
      const x = homePos[i*3], y = homePos[i*3+1], z = homePos[i*3+2];
      const len = Math.hypot(x, y, z) || 1;
      if (len > maxLen) maxLen = len;
      dirArr[i*3] = x/len; dirArr[i*3+1] = y/len; dirArr[i*3+2] = z/len;
      normArr[i*3] = x/len; normArr[i*3+1] = y/len; normArr[i*3+2] = z/len;
      sizes[i] = cfg.size * (0.5 + Math.random() * 0.8);
      seeds[i] = Math.random() * Math.PI * 2;
      dentArr[i] = (Math.random() * 2 - 1);
    }
    boundR = maxLen;
    computeHoverEllipse();

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(curPos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: sprite }, uTime: { value: 0 }, uPixelRatio: { value: Math.min(devicePixelRatio, 2) } },
      vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
    });

    if (points) { scene.remove(points); points.geometry.dispose(); points.material.dispose(); }
    points = new THREE.Points(geo, mat);
    scene.add(points);
    explodeT = 0;
  }

  // ---- per-frame position update by animation ----
  function step(dt, t) {
    if (!points) return;
    const n = curPos.length / 3;
    const posAttr = points.geometry.getAttribute('position');

    // Hover-triggered radial displacement (Supernova burst / Bulge swell).
    const a = cfg.animation;
    if (a === 'explode_on_hover' || a === 'dent_out_on_hover') {
      const k = Math.min(1, Math.max(0.01, cfg.acceleration));
      explodeT += ((hovered ? 1 : 0) - explodeT) * k;
      const e = ease(explodeT);
      const scatter = a === 'explode_on_hover';            // big outward burst with variance
      const base = (scatter ? cfg.explosionRadius : 0.45) * cfg.hoverIntensity;  // Bulge = gentle swell
      for (let i = 0; i < n; i++) {
        const variance = scatter ? (0.6 + Math.abs(dentArr[i]) * 0.8) : 1;
        const d = base * e * variance;
        curPos[i*3]   = homePos[i*3]   + normArr[i*3]   * d;
        curPos[i*3+1] = homePos[i*3+1] + normArr[i*3+1] * d;
        curPos[i*3+2] = homePos[i*3+2] + normArr[i*3+2] * d;
      }
      posAttr.needsUpdate = true;
    } else if (a === 'dent_at_cursor') {
      // Dimple: particles under the cursor cave inward, relax back on leave.
      // Select by screen-space distance so the dent tracks the cursor as the cloud spins.
      const k = Math.min(1, Math.max(0.04, cfg.acceleration * 2));
      const depth = 0.6 * cfg.hoverIntensity, radius = 0.28, radius2 = radius * radius;
      const mx = mouse.x, my = -mouse.y;                   // NDC (flip y)
      points.updateMatrixWorld();
      _mv.multiplyMatrices(_camInv.copy(camera.matrixWorld).invert(), points.matrixWorld);
      _mvp.multiplyMatrices(camera.projectionMatrix, _mv);
      for (let i = 0; i < n; i++) {
        let t0 = homePos[i*3], t1 = homePos[i*3+1], t2 = homePos[i*3+2];
        if (hovered) {
          _v.set(t0, t1, t2).applyMatrix4(_mvp);            // -> NDC (perspective divide)
          const dx = _v.x - mx, dy = _v.y - my, d2 = dx*dx + dy*dy;
          if (d2 < radius2 && _v.z < 1) {                   // inside cursor disc & in front
            const f = 1 - Math.sqrt(d2) / radius;           // 1 at center -> 0 at edge
            const dep = depth * f * f * (3 - 2 * f);
            t0 -= normArr[i*3] * dep; t1 -= normArr[i*3+1] * dep; t2 -= normArr[i*3+2] * dep;
          }
        }
        curPos[i*3]   += (t0 - curPos[i*3])   * k;          // smooth carve / relax
        curPos[i*3+1] += (t1 - curPos[i*3+1]) * k;
        curPos[i*3+2] += (t2 - curPos[i*3+2]) * k;
      }
      posAttr.needsUpdate = true;
    } else if (cfg.animation === 'shape_shifter' && shapesPos.length > 1) {
      const infl = Math.min(1, Math.hypot(mouse.x, mouse.y));
      morphT += dt * 0.25 * (1 + infl * 2);
      while (morphT >= 1) {
        morphT -= 1;
        morphFrom = morphTo;
        morphTo = (morphTo + 1) % shapesPos.length;
      }
      const a = shapesPos[morphFrom], b = shapesPos[morphTo], m = ease(morphT);
      for (let i = 0; i < n * 3; i++) curPos[i] = a[i] + (b[i] - a[i]) * m;
      posAttr.needsUpdate = true;
    } else if (cfg.animation === 'dented') {
      const jitter = 0.5 + Math.min(1, Math.hypot(mouse.x, mouse.y)) * 0.5;
      const amt = cfg.dentAmount;
      for (let i = 0; i < n; i++) {
        const d = dentArr[i] * amt * jitter * (0.6 + 0.4 * Math.sin(t * 0.6 + i));
        curPos[i*3]   = homePos[i*3]   + normArr[i*3]   * d;
        curPos[i*3+1] = homePos[i*3+1] + normArr[i*3+1] * d;
        curPos[i*3+2] = homePos[i*3+2] + normArr[i*3+2] * d;
      }
      posAttr.needsUpdate = true;
    }
    // idle: positions stay = home (set once at rebuild), shader handles drift
  }

  // ---- render loop ----
  const clock = new THREE.Clock();
  let elapsed = 0;
  let raf = null;
  function animate() {
    raf = requestAnimationFrame(animate);
    const dt = Math.min(0.05, clock.getDelta());
    elapsed += dt;
    const t = elapsed;
    if (points) {
      points.material.uniforms.uTime.value = t;
      step(dt, t);
      const p = cfg.parallaxStrength;
      targetRot.x += (mouse.y * 0.25 * p - targetRot.x) * 0.05;
      targetRot.y += (mouse.x * 0.4 * p - targetRot.y) * 0.05;
      if (!dragging) {
        // momentum spin decays after release, drag rotation persists
        dragRot.x += dragVel.x;
        dragRot.y += dragVel.y;
        dragVel.x *= 0.94;
        dragVel.y *= 0.94;
      }
      points.rotation.x = targetRot.x + dragRot.x;
      points.rotation.y = targetRot.y + dragRot.y + (cfg.autoRotate ? t * 0.04 : 0);
    }
    renderer.render(scene, camera);
  }

  // ---- listeners (scoped to container) ----
  function onMove(e) {
    const r = renderer.domElement.getBoundingClientRect();
    mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    mouse.y = ((e.clientY - r.top) / r.height) * 2 - 1;
    pointerInside = true;
    updateHover();          // hovered = cursor over the cloud disc, not just the canvas
    if (!dragging) el.style.cursor = hovered ? 'grab' : '';
    if (dragging) {
      const dx = e.clientX - lastPX, dy = e.clientY - lastPY;
      lastPX = e.clientX; lastPY = e.clientY;
      const spin = 0.005;
      dragRot.y += dx * spin;
      dragRot.x += dy * spin;
      dragVel.x = dy * spin;
      dragVel.y = dx * spin;
    }
  }
  function onEnter() { pointerInside = true; updateHover(); }
  function onLeave() { pointerInside = false; hovered = false; }
  function onDown(e) {
    if (!hovered) return;
    dragging = true;
    dragVel.set(0, 0);
    lastPX = e.clientX; lastPY = e.clientY;
    el.style.cursor = 'grabbing';
    el.setPointerCapture?.(e.pointerId);
  }
  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    el.style.cursor = hovered ? 'grab' : '';
    el.releasePointerCapture?.(e.pointerId);
  }
  const el = renderer.domElement;
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerenter', onEnter);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointerup', onUp);
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  addEventListener('resize', resize);

  resize();
  rebuild();
  // clock.getDelta primed
  animate();

  // ---- public API ----
  // Re-sample the retained model with current count/density (model loaded only)
  function resample() {
    if (!lastModelScene) { rebuild(); return; }
    const n = Math.max(100, cfg.particleCount | 0);
    const sampled = sampleModel(lastModelScene, n, cfg.densBias);
    if (sampled) modelPos = sampled;
    rebuild();
  }

  function setConfig(partial = {}) {
    const resampleKeys = ['particleCount', 'densBias'];
    const rebuildKeys = ['shape', 'shapes', 'animation', 'accent', 'size'];
    const hasModel = !!lastModelScene;
    const needsResample = hasModel && Object.keys(partial).some(k => resampleKeys.includes(k));
    const needsRebuild = Object.keys(partial).some(k => rebuildKeys.includes(k)) ||
      (!hasModel && partial.particleCount != null);
    Object.assign(cfg, partial);
    if (needsResample) resample();
    else if (needsRebuild) rebuild();
  }

  async function loadModelFromURL(url, densBias) {
    const loader = new GLTFLoader();
    const gltf = await new Promise((res, rej) => loader.load(url, res, undefined, rej));
    const n = Math.max(100, cfg.particleCount | 0);
    const sampled = sampleModel(gltf.scene, n, densBias ?? cfg.densBias);
    if (!sampled) throw new Error('No mesh in model');
    lastModelScene = gltf.scene;
    modelPos = sampled;
    cfg.model = url;
    rebuild();
  }

  async function loadModelFromFile(file) {
    const url = URL.createObjectURL(file);
    try { await loadModelFromURL(url); } finally { URL.revokeObjectURL(url); }
  }

  function clearModel() { lastModelScene = null; modelPos = null; cfg.model = null; rebuild(); }

  function exportPositionsColors() {
    const g = points.geometry;
    return {
      positions: homePos.slice(),                          // resting shape, not exploded
      colors: g.getAttribute('color').array.slice(),
    };
  }

  function snapshotJPEG(side = 512, quality = 0.8) {
    renderer.render(scene, camera);
    const src = renderer.domElement;
    const c = document.createElement('canvas'); c.width = c.height = side;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, side, side);
    const s = Math.min(src.width, src.height);
    ctx.drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, side, side);
    return new Promise(res => c.toBlob(res, 'image/jpeg', quality));
  }

  function getPointCount() { return points ? points.geometry.getAttribute('position').count : 0; }

  function dispose() {
    if (raf) cancelAnimationFrame(raf);
    ro.disconnect();
    removeEventListener('resize', resize);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerenter', onEnter);
    el.removeEventListener('pointerleave', onLeave);
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointerup', onUp);
    if (points) { scene.remove(points); points.geometry.dispose(); points.material.dispose(); }
    renderer.dispose();
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  return {
    canvas: el, scene, camera, renderer, config: cfg,
    setConfig, getConfig: () => ({ ...cfg }),
    loadModelFromURL, loadModelFromFile, clearModel,
    exportPositionsColors, snapshotJPEG, getPointCount, dispose,
  };
}
