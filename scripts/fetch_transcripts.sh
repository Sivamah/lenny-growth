#!/usr/bin/env bash
# Fetch the demo transcript corpus for Lenny Growth Assistant v2.
#
# Source: the official free starter pack published by Lenny's Newsletter
#   https://github.com/LennysNewsletter/lennys-newsletterpodcastdata
# License: see data/README.md and that repo's LICENSE.md — personal,
#   non-commercial use only; redistribution of the raw files is prohibited.
# That is why this script *fetches* the data at setup time instead of the repo
# vendoring copies of the transcripts.
set -euo pipefail

REPO_URL="https://github.com/LennysNewsletter/lennys-newsletterpodcastdata.git"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/../data"
TRANSCRIPTS_DIR="$DATA_DIR/transcripts"
TMP_DIR="$(mktemp -d)"

CURATED=(
  amol-avasare
  brian-halligan
  elena-verna-40
  eric-ries-2
  evan-spiegel
  jason-cohen
  jason-m-lemkin
  marc-andreessen
  mark-pincus
  nikhyl-singhal-2
)

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

echo "Cloning $REPO_URL (shallow)..."
git clone --depth 1 --quiet "$REPO_URL" "$TMP_DIR"

mkdir -p "$TRANSCRIPTS_DIR"

if [[ "${1:-}" == "--all" ]]; then
  echo "Copying all podcast transcripts..."
  cp "$TMP_DIR"/podcasts/*.md "$TRANSCRIPTS_DIR/"
else
  echo "Copying curated growth/PM subset (${#CURATED[@]} episodes)..."
  for slug in "${CURATED[@]}"; do
    cp "$TMP_DIR/podcasts/$slug.md" "$TRANSCRIPTS_DIR/$slug.md"
  done
fi

count=$(find "$TRANSCRIPTS_DIR" -name '*.md' | wc -l)
echo "Done. $count transcript(s) in $TRANSCRIPTS_DIR"
echo "Next: cd backend && uv run python scripts/ingest.py"
