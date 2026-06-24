// Best-effort hardening shared by the write routes (/api/scene POST, /api/upload).
//
// NOTE: the rate limiter is per-instance, in-memory only. Serverless instances do
// NOT share this map, so it throttles a single warm instance, not your whole
// deployment. It exists to blunt trivial abuse; for real protection put a durable
// limiter (Vercel KV + @upstash/ratelimit) or the Vercel WAF in front of /api/*.

// ip -> { count, resetAt }
const buckets = new Map();

export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Returns true if the request is allowed, false if it should be rejected (429).
export function rateLimit(req, { limit = 30, windowMs = 60_000 } = {}) {
  const ip = clientIp(req);
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now > b.resetAt) {
    buckets.set(ip, { count: 1, resetAt: now + windowMs });
    // opportunistic cleanup so the map can't grow unbounded
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
    }
    return true;
  }
  if (b.count >= limit) return false;
  b.count++;
  return true;
}

// A saved scene's model_url must be one of OUR Vercel Blob files (https only).
// Blocks using the scenes store to point embeds at arbitrary third-party URLs.
export function isAllowedModelUrl(url) {
  if (typeof url !== 'string' || url.length > 2048) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && u.hostname.endsWith('.public.blob.vercel-storage.com');
}

// Cap stored config size so a single POST can't bloat the Blob store.
export const MAX_CONFIG_BYTES = 50_000;
export function configTooBig(config) {
  try { return JSON.stringify(config).length > MAX_CONFIG_BYTES; }
  catch { return true; } // unserializable (cycles, etc.) -> reject
}
