"""Merge per-VM results into results/final.json.

Each config ran on 3 different VMs. For every config we take each VM's median
(over its repeats) and report the median of those VM medians, plus the min/max
of all individual repeats across VMs.
    python3 aggregate.py <results-root>
<results-root>/vms/<vm>/{scaling,ops,mem}.jsonl plus the single-run files
(html5lib.json, features.json, footprint.json, agreement.json, corpus_stats.json).
"""
import glob, json, os, statistics as st, sys

root = sys.argv[1]
# Spec-compliant parsers only; htmlparser2 and node-html-parser pass <1% of WPT parsing tests.
LIBS = ["rusteerio", "cheerio", "jsdom", "parse5"]

def rows(name):
    out = []
    for f in glob.glob(f"{root}/vms/*/{name}.jsonl"):
        for line in open(f):
            line = line.strip()
            if line: out.append(json.loads(line))
    return out

med = st.median
final = {"libs": LIBS}

# ---- scaling ----
def agg_scaling(rows_all, libs):
    out, failures = {}, []
    for lib in libs:
        out[lib] = []
        for c in (1, 2, 4, 8, 16):
            rs = [r for r in rows_all if r["lib"] == lib and r["cores"] == c]
            ok = [r for r in rs if not r.get("failed")]
            failures += [{"lib": lib, "cores": c, "vm": r["vm"]} for r in rs if r.get("failed")]
            if not ok: continue
            vm_med_ms = [r["medianMs"] for r in ok]
            all_ms = [t for r in ok for t in r["timesMs"]]
            pages, total = ok[0]["pages"], ok[0]["totalBytes"]
            m = med(vm_med_ms)
            out[lib].append({
                "cores": c, "vms": [r["vm"] for r in ok], "replicas": len(ok),
                "medianMs": round(m, 1),
                "pagesPerSec": round(pages / (m / 1000), 1),
                "pagesPerSecMin": round(pages / (max(all_ms) / 1000), 1),
                "pagesPerSecMax": round(pages / (min(all_ms) / 1000), 1),
                "vmPagesPerSec": [round(pages / (x / 1000), 1) for x in vm_med_ms],
                "mbPerSec": round(total / 1e6 / (m / 1000), 2),
                "avgCoresBusy": round(med([r["avgCoresBusy"] for r in ok]), 2),
                "peakRssMB": round(med([r["peakRssMB"] for r in ok]), 0),
                "baselineRssMB": round(med([r["baselineRssMB"] for r in ok]), 0),
                "workingMB": round(med([r["peakRssMB"] - r["baselineRssMB"] for r in ok]), 0),
                "checksums": sorted({r["checksum"] for r in ok}),
                "settings": {k: ok[0].get(k) for k in ("mode", "chunk", "heapMB", "batch", "inflight", "repeats")},
            })
    return out, failures

final["scaling"], failures = agg_scaling(rows("scaling"), LIBS)
# rusteerio's synchronous API in the same worker_threads pool the JS libraries use
final["scalingPool"], pool_failures = agg_scaling(rows("scaling_pool"), ["rusteerio"])
final["scalingFailures"] = failures + pool_failures
scaling = final["scaling"]

# ---- ops ----
ops = {}
for lib in LIBS:
    ops[lib] = {}
    for op in ("parse", "extract", "serialize"):
        ok = [r for r in rows("ops") if r["lib"] == lib and r["op"] == op]
        if not ok: continue
        m = med([r["medianMs"] for r in ok]); pages = ok[0]["pages"]
        all_ms = [t for r in ok for t in r["timesMs"]]
        mbps = med([r["mbPerSec"] for r in ok])
        ops[lib][op] = {
            "replicas": len(ok), "medianMs": round(m, 1), "msPerPage": round(m / pages, 3),
            "mbPerSec": round(mbps, 2), "vmMbPerSec": [r["mbPerSec"] for r in ok],
            "msPerPageMin": round(min(all_ms) / pages, 3), "msPerPageMax": round(max(all_ms) / pages, 3),
        }
final["ops"] = ops

# ---- retained memory ----
mem = {}
for lib in LIBS:
    ok = [r for r in rows("mem") if r["lib"] == lib]
    if not ok: continue
    mem[lib] = {
        "replicas": len(ok), "docs": ok[0]["docs"], "htmlMB": ok[0]["htmlMB"],
        "retainedRssMB": round(med([r["retainedRssMB"] for r in ok]), 1),
        "retainedHeapMB": round(med([r["retainedHeapMB"] for r in ok]), 1),
        "rssPerHtmlMB": round(med([r["rssPerHtmlMB"] for r in ok]), 2),
        "vmRetainedRssMB": [r["retainedRssMB"] for r in ok],
    }
final["mem"] = mem

# ---- single-run inputs ----
def load(name):
    p = f"{root}/{name}"
    return json.load(open(p)) if os.path.exists(p) else None
final["html5lib"] = load("html5lib.json")
final["features"] = load("features.json")
final["footprint"] = load("footprint.json")
final["agreement"] = load("agreement.json")
final["corpus"] = load("corpus_stats.json")
final["rvc"] = load("rusteerio_vs_cheerio.json")

json.dump(final, open(f"{root}/final.json", "w"), indent=1)
print("wrote", f"{root}/final.json")
for lib in LIBS:
    s = {r["cores"]: r["pagesPerSec"] for r in scaling[lib]}
    print(f"{lib:17s}", " ".join(f"{c}:{s.get(c, '-'):>8}" for c in (1, 2, 4, 8, 16)),
          "| work16", next((r["workingMB"] for r in scaling[lib] if r["cores"] == 16), "-"))
if failures: print("FAILURES", failures)
