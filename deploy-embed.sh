#!/usr/bin/env bash
# Uploads the embed runtime into the public `models` bucket under embed/.
# Re-run after editing embed.js / js/engine.js / config.json.
set -euo pipefail

SUPABASE_URL="https://REDACTED_PROJECT_REF.supabase.co"
KEY="REDACTED_SUPABASE_KEY"
DIR="$(cd "$(dirname "$0")" && pwd)"

upload() {
  local src="$1" dest="$2" ctype="$3"
  echo "→ $dest"
  # anon RLS allows INSERT + DELETE but not UPDATE, so delete any existing object
  # first, then POST a fresh one (upsert/UPDATE would 403).
  curl -sS -X DELETE \
    "$SUPABASE_URL/storage/v1/object/models/$dest" \
    -H "Authorization: Bearer $KEY" -H "apikey: $KEY" >/dev/null
  # Runtime lives at a FIXED path and is overwritten on redeploy, so it must NOT
  # be immutable — a short cache absorbs traffic bursts but still picks up fixes.
  # (Model .glb files are uploaded by app.js to unique UUID paths with a 1-year
  #  immutable cache, which is safe because each URL maps to fixed bytes forever.)
  curl -sS -X POST \
    "$SUPABASE_URL/storage/v1/object/models/$dest" \
    -H "Authorization: Bearer $KEY" \
    -H "apikey: $KEY" \
    -H "Content-Type: $ctype" \
    -H "cache-control: max-age=600" \
    --data-binary "@$src"
  echo
}

upload "$DIR/embed.js"        "embed/embed.js"     "application/javascript"
upload "$DIR/js/engine.js"    "embed/js/engine.js" "application/javascript"
upload "$DIR/config.json"     "embed/config.json"  "application/json"

echo "Done. Loader: $SUPABASE_URL/storage/v1/object/public/models/embed/embed.js"
