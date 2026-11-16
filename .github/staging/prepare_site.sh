#!/usr/bin/env bash
# Turns a copy of a fleetr site (website, check-in app or staff app) into its
# staging copy, in place. Run by each app's deploy-staging workflow on the
# folder it is about to publish; the source in the repo is never changed. The
# same file is kept in each app repo as .github/staging/prepare_site.sh
# (fleetr-infra's staging_sites.test.mjs checks the copies match).
#
#   STAGING_SUPABASE_URL=https://<ref>.supabase.co STAGING_SUPABASE_ANON_KEY=... \
#     prepare_site.sh <folder>
#
# Every production address is swapped for its staging one: the Supabase
# project and key, both Workers, the three sites. Turnstile gets Cloudflare's
# published test site key. Each page gets a "Staging" banner and noindex. Then
# it fails if anything still points at production, so a staging page can never
# reach the live database, Workers or sites.
set -euo pipefail
DIR="${1:?Usage: prepare_site.sh <folder>}"
: "${STAGING_SUPABASE_URL:?Set STAGING_SUPABASE_URL}"
: "${STAGING_SUPABASE_ANON_KEY:?Set STAGING_SUPABASE_ANON_KEY}"
PROD_REF="hzcatlecvwpqxedrzfog"
case "$STAGING_SUPABASE_URL$STAGING_SUPABASE_ANON_KEY" in
  *"$PROD_REF"*) echo "Refusing: the staging settings name the production project." >&2; exit 1 ;;
esac
PROD_ANON="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh6Y2F0bGVjdndwcXhlZHJ6Zm9nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwNzQzMTMsImV4cCI6MjA5MzY1MDMxM30.mfqwWQh54hPsRunAVB6RDf_IrvwKmhSYWWJ4sMy0rcw"
STAMP="$(date +%s)"
export PROD_REF PROD_ANON STAMP STAGING_SUPABASE_URL STAGING_SUPABASE_ANON_KEY

FILES=()
while IFS= read -r -d '' f; do FILES+=("$f"); done < <(find "$DIR" -type f \
  \( -name '*.html' -o -name '*.js' -o -name '*.json' -o -name '*.webmanifest' \) -not -path '*/.git/*' -print0)
[ "${#FILES[@]}" -gt 0 ] || { echo "No site files in $DIR" >&2; exit 1; }

perl -pi -e '
  s{https://\Q$ENV{PROD_REF}\E\.supabase\.co}{$ENV{STAGING_SUPABASE_URL}}g;
  s{\Q$ENV{PROD_ANON}\E}{$ENV{STAGING_SUPABASE_ANON_KEY}}g;
  s{https://fleetr-ai-proxy\.connor-0a5\.workers\.dev}{https://fleetr-ai-proxy-staging.connor-0a5.workers.dev}g;
  s{https://fleetr-reset\.connor-0a5\.workers\.dev}{https://fleetr-reset-staging.connor-0a5.workers.dev}g;
  s{https://app\.fleetr\.ai}{https://staging-app.fleetr.ai}g;
  s{https://internal\.fleetr\.ai}{https://staging-internal.fleetr.ai}g;
  s{https://fleetr\.ai(?=[/"\x27#?)\s<`]|$)}{https://staging.fleetr.ai}g;
  s{0x4AAAAAAFP1n93AtpZAqdDg}{1x00000000000000000000AA}g;
  s{\{\{ site\.time \| date: \x27%s\x27 \}\}}{$ENV{STAMP}}g;
  s{(src="(?:\./)?(?:src/main|app)\.js)\?v=[^"]*"}{$1?v=$ENV{STAMP}"}g;
' "${FILES[@]}"

# Jekyll front matter (the staff app's index.html and version.json), which
# only GitHub Pages strips. Left in, index.html showed "--- ---" above the
# app and opened in quirks mode, with no doctype first.
for f in "${FILES[@]}"; do perl -0pi -e 's/\A---\s*\n---\s*\n//' "$f"; done
# Cloudflare Pages takes its domains from the project, not a CNAME file.
rm -f "$DIR/CNAME"

BANNER='<div id="fleetr-staging-banner" role="note" style="position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647;background:#FDB022;color:#1F1E1D;font:600 12px/1.2 system-ui,-apple-system,sans-serif;padding:5px 12px;border-radius:0 0 8px 8px;pointer-events:none;white-space:nowrap">Staging &middot; test data, nothing is sent</div>'
export BANNER
while IFS= read -r -d '' f; do
  # A page with no </head> or </body> (demo.html) gets them at its end.
  perl -0pi -e 's{</head>}{<meta name="robots" content="noindex, nofollow" />\n</head>}i or $_ .= qq{\n<meta name="robots" content="noindex, nofollow" />};
                s{</body>}{$ENV{BANNER}\n</body>}i or $_ .= "\n$ENV{BANNER}\n"' "$f"
done < <(find "$DIR" -type f -name '*.html' -not -path '*/.git/*' -print0)

# Nothing may still point at production.
if grep -rIl -e "$PROD_REF" -e 'fleetr-ai-proxy\.connor-0a5' -e 'fleetr-reset\.connor-0a5' \
     -e 'https://app\.fleetr\.ai' -e 'https://internal\.fleetr\.ai' -e '0x4AAAAAAFP1n93AtpZAqdDg' \
     -e "site\.time" "$DIR" --include='*.html' --include='*.js' --include='*.json' --include='*.webmanifest'; then
  echo "Refusing to publish: the files above still point at production." >&2; exit 1
fi
pages=$(find "$DIR" -type f -name '*.html' -not -path '*/.git/*' | wc -l | tr -d ' ')
banners=$(grep -rl 'id="fleetr-staging-banner"' "$DIR" --include='*.html' | wc -l | tr -d ' ')
[ "$pages" = "$banners" ] || { echo "Only $banners of $pages pages have the Staging banner." >&2; exit 1; }
echo "Staging copy ready: $pages pages, all pointing at staging."
