#!/usr/bin/env bash
# Prepare a fresh boat.dev VM: pinned library versions + the same Common Crawl corpus.
set -euo pipefail
cd ~/bench
[ -f package.json ] || npm init -y >/dev/null
npm i --no-audit --no-fund rusteerio@1.1.6 cheerio@1.2.0 jsdom@30.1.3 htmlparser2@12.0.0 parse5@8.0.1 node-html-parser@9.0.4 >/dev/null
pip install --user --break-system-packages -q warcio
mkdir -p corpus results
if [ ! -f corpus/pages.jsonl ]; then
  cd corpus
  for p in crawl-data/CC-MAIN-2026-39/segments/1788492699475.64/warc/CC-MAIN-20260904131603-20260904161603-00000.warc.gz \
           crawl-data/CC-MAIN-2026-39/segments/1788492699525.42/warc/CC-MAIN-20260905012745-20260905042745-00999.warc.gz; do
    curl -sf -o "$(basename "$p")" "https://data.commoncrawl.org/$p"
  done
  cd .. && python3 bench/build_corpus.py 3000 corpus > results/corpus_stats.json
fi
md5sum corpus/pages.jsonl | cut -d' ' -f1 > results/corpus_md5.txt
[ "$(cat results/corpus_md5.txt)" = "1dd774a7fcc3079113f6828d82ecf6fb" ] || { echo "CORPUS MISMATCH"; exit 1; }
echo BOOTSTRAP_OK
