"""Extract a deterministic sample of real HTML pages from Common Crawl WARC files.

Keeps HTTP 200 text/html responses whose body decodes as UTF-8, 2 KB - 2 MB,
one page per host, then shuffles with a fixed seed and keeps N pages.
Output: corpus/pages.jsonl  ({"url":..., "html":...} per line)
"""
import glob, json, random, sys
from urllib.parse import urlparse
from warcio.archiveiterator import ArchiveIterator

N = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
out_dir = sys.argv[2] if len(sys.argv) > 2 else "corpus"

pages, hosts = [], set()
for path in sorted(glob.glob(f"{out_dir}/*.warc.gz")):
    with open(path, "rb") as fh:
        for rec in ArchiveIterator(fh):
            if rec.rec_type != "response" or rec.http_headers is None:
                continue
            if rec.http_headers.get_statuscode() != "200":
                continue
            ctype = (rec.http_headers.get_header("Content-Type") or "").lower()
            if "text/html" not in ctype:
                continue
            url = rec.rec_headers.get_header("WARC-Target-URI")
            host = urlparse(url).hostname
            if host in hosts:
                continue
            body = rec.content_stream().read()
            if not (2_000 <= len(body) <= 2_000_000):
                continue
            try:
                html = body.decode("utf-8")
            except UnicodeDecodeError:
                continue
            if "<html" not in html[:5000].lower():
                continue
            hosts.add(host)
            pages.append({"url": url, "html": html})

random.Random(20261015).shuffle(pages)
pages = pages[:N]
with open(f"{out_dir}/pages.jsonl", "w") as fh:
    for p in pages:
        fh.write(json.dumps(p) + "\n")

sizes = sorted(len(p["html"].encode()) for p in pages)
print(json.dumps({
    "candidates_unique_hosts": len(hosts),
    "pages": len(pages),
    "total_bytes": sum(sizes),
    "median_bytes": sizes[len(sizes) // 2],
    "p90_bytes": sizes[int(len(sizes) * 0.9)],
    "max_bytes": sizes[-1],
}))
