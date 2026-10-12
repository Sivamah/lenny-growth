#!/usr/bin/env bash
# Fetch the demo transcript corpus for Lenny Growth Assistant v2.
#
# Primary Source: the official starter pack published by Lenny's Newsletter
#   https://github.com/LennysNewsletter/lennys-newsletterpodcastdata
#   License: personal, non-commercial use only (see data/README.md).
#
# Alternative Source: the ChatPRD community repository referenced in assignment:
#   https://github.com/ChatPRD/lennys-podcast-transcripts
#
# Usage:
#   bash scripts/fetch_transcripts.sh              # Fetches curated 10 episodes from official repo
#   bash scripts/fetch_transcripts.sh --all        # Fetches all episodes from official repo
#   bash scripts/fetch_transcripts.sh --chatprd    # Fetches from ChatPRD/lennys-podcast-transcripts
set -euo pipefail

OFFICIAL_REPO_URL="https://github.com/LennysNewsletter/lennys-newsletterpodcastdata.git"
CHATPRD_REPO_URL="https://github.com/ChatPRD/lennys-podcast-transcripts.git"

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

mkdir -p "$TRANSCRIPTS_DIR"

if [[ "${1:-}" == "--chatprd" ]]; then
  echo "Cloning ChatPRD transcripts repository ($CHATPRD_REPO_URL)..."
  git clone --depth 1 --quiet "$CHATPRD_REPO_URL" "$TMP_DIR"
  echo "Copying markdown transcripts from ChatPRD..."
  find "$TMP_DIR" -maxdepth 2 -name "*.md" ! -name "README.md" -exec cp {} "$TRANSCRIPTS_DIR/" \;
else
  echo "Cloning official Lenny's Newsletter starter dataset ($OFFICIAL_REPO_URL)..."
  git clone --depth 1 --quiet "$OFFICIAL_REPO_URL" "$TMP_DIR"

  if [[ "${1:-}" == "--all" ]]; then
    echo "Copying all podcast transcripts..."
    cp "$TMP_DIR"/podcasts/*.md "$TRANSCRIPTS_DIR/"
  else
    echo "Copying curated growth/PM subset (${#CURATED[@]} episodes)..."
    for slug in "${CURATED[@]}"; do
      if [[ -f "$TMP_DIR/podcasts/$slug.md" ]]; then
        cp "$TMP_DIR/podcasts/$slug.md" "$TRANSCRIPTS_DIR/$slug.md"
      fi
    done
  fi
fi

count=$(find "$TRANSCRIPTS_DIR" -name '*.md' | wc -l)
echo "Done. $count transcript(s) in $TRANSCRIPTS_DIR"
echo "Next: cd backend && uv run python scripts/ingest.py"
