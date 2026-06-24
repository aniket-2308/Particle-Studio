// Vercel serverless: mints Blob client-upload tokens (replaces Supabase storage upload).
//
// The studio uploads .glb/.gltf files DIRECTLY to Vercel Blob from the browser via
// @vercel/blob/client `upload()`, which calls this route to get a short-lived token.
// Client upload (not a server proxy) is required because serverless request bodies
// cap at 4.5 MB and model files routinely exceed that.
//
// Blob paths get a random suffix => unique forever => safe to cache immutably (1 yr),
// matching the old Supabase per-UUID immutable caching.
import { handleUpload } from '@vercel/blob/client';
import { rateLimit } from './_guard.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!rateLimit(req, { limit: 20 })) return res.status(429).json({ error: 'rate limited' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const json = await handleUpload({
      request: req,
      body,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ['model/gltf-binary', 'model/gltf+json', 'application/octet-stream'],
        addRandomSuffix: true,
        cacheControlMaxAge: 31536000, // 1-year immutable; random suffix makes paths unique
      }),
      // No post-upload bookkeeping: the Library list is per-browser localStorage.
      onUploadCompleted: async () => {},
    });
    return res.status(200).json(json);
  } catch (e) {
    console.error('[api/upload]', e);
    return res.status(400).json({ error: e.message });
  }
}
