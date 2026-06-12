/* Particle Studio — embed 1-liner.
 *
 *   <script src="…/embed.js?preset=explode_on_hover&accent=electric_blue&density=0.8"></script>
 *   <script src="…/embed.js?config=…/my_preset.json"></script>
 *   <script src="…/embed.js?s=AbC12345"></script>   (saved Supabase scene)
 *
 * Classic script: parses its own URL params, injects the three.js import map
 * (once), then boots the engine as a module. One container is created per tag.
 */
(function () {
  var SUPABASE_URL = 'https://REDACTED_PROJECT_REF.supabase.co';
  var SUPABASE_KEY = 'REDACTED_SUPABASE_KEY';

  var me = document.currentScript;
  if (!me) return;
  var src = new URL(me.src, location.href);
  var params = src.searchParams;
  var base = src.href.replace(/embed\.js(\?.*)?$/, ''); // dir holding embed.js

  // 1. Inject the import map once, before any module imports 'three'.
  if (!document.querySelector('script[type="importmap"]')) {
    var im = document.createElement('script');
    im.type = 'importmap';
    im.textContent = JSON.stringify({
      imports: {
        'three': 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js',
        'three/addons/': 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/'
      }
    });
    document.head.appendChild(im);
  }

  // 2. Resolve a container.
  //    - target=<selector>  -> render into that element (position:relative, filled)
  //    - otherwise          -> fixed full-viewport div at z-index 0
  var target = params.get('target');
  var container;
  if (target && document.querySelector(target)) {
    container = document.querySelector(target);
    var cs = getComputedStyle(container);
    if (cs.position === 'static') container.style.position = 'relative';
  } else {
    container = document.createElement('div');
    container.setAttribute('data-particle-studio', '');
    container.style.cssText = 'position:fixed;inset:0;z-index:0;background:#000';
    document.body.appendChild(container);
  }

  // 3. Build a config-request payload from params and queue it.
  function paramConfig() {
    var c = {};
    var num = { density: 'densBias', count: 'particleCount', particleCount: 'particleCount',
      size: 'size', parallax: 'parallaxStrength', parallaxStrength: 'parallaxStrength',
      acceleration: 'acceleration', explosionRadius: 'explosionRadius', dentAmount: 'dentAmount' };
    var str = { accent: 'accent', animation: 'animation', shape: 'shape', model: 'model' };
    params.forEach(function (v, k) {
      if (num[k] != null) c[num[k]] = parseFloat(v);
      else if (str[k] != null) c[str[k]] = v;
      else if (k === 'autoRotate') c.autoRotate = v !== 'false' && v !== '0';
      else if (k === 'shapes') c.shapes = v.split(',').map(function (s) { return s.trim(); });
    });
    return c;
  }

  window.__PS_EMBEDS = window.__PS_EMBEDS || [];
  window.__PS_EMBEDS.push({
    container: container,
    scene: params.get('s') || params.get('scene'),
    preset: params.get('preset'),
    configUrl: params.get('config'),
    overrides: paramConfig(),
    model: params.get('model'),
    base: base,
    supaUrl: SUPABASE_URL,
    supaKey: SUPABASE_KEY
  });

  // 4. Boot the engine once; it drains the queue.
  if (!window.__PS_BOOTED) {
    window.__PS_BOOTED = true;
    var boot = document.createElement('script');
    boot.type = 'module';
    boot.textContent =
      "import { createParticleStudio } from '" + base + "js/engine.js';\n" +
      "(async () => {\n" +
      "  const jobs = window.__PS_EMBEDS || [];\n" +
      "  for (const j of jobs) {\n" +
      "    let cfg = {}, model = null;\n" +
      "    try {\n" +
      "      if (j.scene) {\n" +
      "        const r = await fetch(j.supaUrl + '/rest/v1/scenes?select=*&id=eq.' + encodeURIComponent(j.scene), {\n" +
      "          headers: { apikey: j.supaKey, Authorization: 'Bearer ' + j.supaKey } });\n" +
      "        const rows = await r.json();\n" +
      "        const row = Array.isArray(rows) ? rows[0] : null;\n" +
      "        if (!row) throw new Error('scene not found: ' + j.scene);\n" +
      "        cfg = row.config || {};\n" +
      "        if (row.file_path) model = j.supaUrl + '/storage/v1/object/public/models/' + row.file_path;\n" +
      "      } else if (j.configUrl) cfg = await (await fetch(j.configUrl)).json();\n" +
      "      else if (j.preset) {\n" +
      "        const all = await (await fetch(j.base + 'config.json')).json();\n" +
      "        cfg = (all.presets && all.presets[j.preset]) || {};\n" +
      "      }\n" +
      "    } catch (e) { console.warn('[particle-studio] config load failed', e); }\n" +
      "    cfg = Object.assign({}, cfg, j.overrides);\n" +
      "    const studio = createParticleStudio(j.container, cfg);\n" +
      "    model = j.model || model || cfg.model;\n" +
      "    if (model) studio.loadModelFromURL(model).catch(e => console.warn('[particle-studio] model load failed', e));\n" +
      "  }\n" +
      "})();";
    document.head.appendChild(boot);
  }
})();
