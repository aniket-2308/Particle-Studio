// Vercel serverless: scenes store (replaces Supabase `scenes` table + get_scene RPC).
//
// Backed by Vercel Blob (same store as model files) — scene JSON lives at the
// deterministic public path `scenes/<id>.json`. Avoids a second storage product.
//
// Capability model preserved from the old Supabase design:
//   - read is BY-ID ONLY  (GET ?id=…)  — there is no list/enumerate route exposed
//   - create is write-only (POST)      — the client never lists existing scenes
//   - the 8-char base62 id is the unguessable capability.
import { put, list } from '@vercel/blob';

// 8-char base62 id, no ambiguous chars — same charset the studio used for scene ids.
function shortId(len = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < len; i++) s += chars[bytes[i] % chars.length];
  return s;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // embeds load cross-site
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const id = req.query.id;
      if (!id || !/^[A-Za-z0-9]{1,16}$/.test(id)) return res.status(400).json({ error: 'bad id' });
      const { blobs } = await list({ prefix: `scenes/${id}.json`, limit: 1 });
      if (!blobs.length) return res.status(404).json({ error: 'not found' });
      const row = await (await fetch(blobs[0].url)).json();
      res.setHeader('cache-control', 'public, max-age=600'); // scenes are effectively immutable
      return res.status(200).json({ config: row.config, model_url: row.model_url, name: row.name });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const { config, model_url, name } = body;
      if (!config || !model_url) return res.status(400).json({ error: 'config and model_url required' });
      const id = shortId();
      const row = { config, model_url, name: name || null, created_at: Date.now() };
      await put(`scenes/${id}.json`, JSON.stringify(row), {
        access: 'public', addRandomSuffix: false, contentType: 'application/json',
        cacheControlMaxAge: 600,
      });
      return res.status(200).json({ id });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('[api/scene]', e);
    return res.status(500).json({ error: 'server error' });
  }
}
