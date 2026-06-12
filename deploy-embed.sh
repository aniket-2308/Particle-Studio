#!/usr/bin/env bash
# Uploads the embed runtime into the public `models` bucket under embed/.
# Re-run after editing embed.js / js/engine.js / config.json.
set -euo pipefail

SUPABASE_URL="https://exjemvfvuvgoyhovwhkx.supabase.co"
KEY="sb_publishable_2V2OfOlixSXDWj4wNknohA_ftiBU7SF"
DIR="$(cd "$(dirname "$0")" && pwd)"

upload() {
  local src="$1" dest="$2" ctype="$3"
  echo "→ $dest"
  # anon RLS is scoped to the embed/ prefix (SELECT+INSERT+UPDATE+DELETE); user
  # uploads under files/ are unlistable. Delete any existing object first, then
  # POST fresh (avoids needing the upsert header).
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
