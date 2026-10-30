"""Assign every benchmark config to REPLICAS distinct VMs, balancing estimated time.
    python3 plan.py <out-dir> vm1 vm2 ...
"""
import os, sys, zlib

REPLICAS = 3
LIBS = ["rusteerio", "cheerio", "jsdom", "htmlparser2", "parse5", "node-html-parser"]
# rough single-config durations in seconds (5 repeats; jsdom 3), used only for balancing
ONE_CORE = {"rusteerio": 45, "cheerio": 190, "jsdom": 2200, "htmlparser2": 30, "parse5": 75, "node-html-parser": 50}
jobs = []
for lib in LIBS:
    for c in (1, 2, 4, 8, 16):
        jobs.append((f"scaling {lib} {c}", ONE_CORE[lib] / min(c, 12) + 15))
    for op in ("parse", "extract", "serialize"):
        jobs.append((f"ops {lib} {op}", ONE_CORE[lib] * 0.9 + 15))
    jobs.append((f"mem {lib}", 30 if lib != "jsdom" else 90))

out, vms = sys.argv[1], sys.argv[2:]
load = {v: 0.0 for v in vms}
assign = {v: [] for v in vms}
for job, est in sorted(jobs, key=lambda j: -j[1]):
    for v in sorted(vms, key=lambda v: load[v])[:REPLICAS]:
        assign[v].append(job); load[v] += est
os.makedirs(out, exist_ok=True)
for v in vms:
    # interleave libraries within a VM so slow drift does not hit one library
    lines = sorted(assign[v], key=lambda j: zlib.crc32(j.encode()))
    open(f"{out}/jobs_{v}.txt", "w").write("\n".join(lines) + "\n")
    print(v, len(lines), f"{load[v] / 60:.0f} min est")
