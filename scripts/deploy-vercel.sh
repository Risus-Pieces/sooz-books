#!/usr/bin/env bash
# Deploy Sooz Books to Vercel production.
#
#   vercel login            # once, interactively
#   bash scripts/deploy-vercel.sh
#
# Links (or creates) the Vercel project "sooz-books", copies the production environment
# variables from .env.local, and deploys. Secrets go to `vercel env add` on stdin, so they
# never appear on a command line, in `ps`, or in shell history.
#
# Deliberately NOT copied: E2E_EMAIL / E2E_PASSWORD (test account, local only) and
# DATABASE_URL_SESSION (psql convenience).
set -euo pipefail
cd "$(dirname "$0")/.."

if ! vercel whoami >/dev/null 2>&1; then
  echo "Not logged in to Vercel. Run: vercel login" >&2
  exit 1
fi

value_of() {
  # Read NAME="value" from .env.local without sourcing it.
  sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" .env.local | tail -1
}

# The account belongs to more than one team, and a non-interactive link must name one.
VERCEL_SCOPE="${VERCEL_SCOPE:-boxuanzhao1128-7935s-projects}"
vercel link --yes --project sooz-books --scope "$VERCEL_SCOPE"

set_env() {
  local name="$1" value="$2"
  if [ -z "$value" ]; then
    echo "  skip $name (empty)"
    return
  fi
  vercel env rm "$name" production --yes >/dev/null 2>&1 || true
  printf '%s' "$value" | vercel env add "$name" production >/dev/null
  echo "  set  $name"
}

echo "Production environment:"
set_env DATABASE_URL                 "$(value_of DATABASE_URL)"
set_env NEXT_PUBLIC_SUPABASE_URL     "$(value_of NEXT_PUBLIC_SUPABASE_URL)"
set_env NEXT_PUBLIC_SUPABASE_ANON_KEY "$(value_of NEXT_PUBLIC_SUPABASE_ANON_KEY)"
set_env ANTHROPIC_API_KEY            "$(value_of ANTHROPIC_API_KEY)"
set_env AI_SUGGEST_MODEL             "$(value_of AI_SUGGEST_MODEL)"
# The Supabase session pooler allows 15 clients for the whole project; a few per function
# instance keeps concurrent instances from exhausting it.
set_env DB_POOL_MAX                  "3"

echo "Deploying to production…"
vercel deploy --prod --yes
