# Knowledge base data

The retrieval knowledge base is built from real **Lenny's Podcast** transcripts.

## Source and license (verified)

- **Source:** the official public starter pack, [`LennysNewsletter/lennys-newsletterpodcastdata`](https://github.com/LennysNewsletter/lennys-newsletterpodcastdata).
- **License:** see that repository's `LICENSE.md` ("Lenny's Data", Copyright (c) 2019-2026
  Lenny Rachitsky). Verified terms:
  - **Allowed:** personal, non-commercial use — studying, remixing locally, building and
    publishing projects that use the dataset.
  - **Not allowed:** redistributing the raw dataset files, or using the raw contents for
    commercial work.

This project is a personal, non-commercial build, so ingesting the starter dataset locally
is permitted. Because redistribution of the raw files is prohibited:

- `data/transcripts/*.md` is **git-ignored** — raw transcripts are never committed.
- Only metadata (`corpus_manifest.json`, this README) is safe to commit.

## Getting the data locally

The intended reproducible paths are:

```bash
# Option 1: Official starter dataset (default, curated 10 episodes)
bash scripts/fetch_transcripts.sh

# Option 2: ChatPRD community repository referenced in the assignment
bash scripts/fetch_transcripts.sh --chatprd

# Option 3: All official episodes
bash scripts/fetch_transcripts.sh --all
```

After the files are present, ingest them:

```bash
cd backend
uv run python scripts/ingest.py
```

## Corpus

10 episodes selected for growth/PM relevance (Elena Verna, Amol Avasare, Jason Cohen,
Evan Spiegel, Mark Pincus, Brian Halligan, Nikhyl Singhal, Jason Lemkin, Eric Ries,
Marc Andreessen). See `corpus_manifest.json` for titles, guests, and source URLs.

## File format

Each transcript is markdown with YAML frontmatter (`title`, `date`, `guest`, `channel`,
`description`, `word_count`) followed by speaker turns formatted as
`**Speaker** (hh:mm:ss):`. The ingestion pipeline reads this format but is not hardcoded
to it — any `.md` file with the same shape drops in without code changes.
