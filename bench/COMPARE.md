# Comparing two builds

Run `node bench/compare-builds.mjs --baseline /path/to/baseline/dist/modern.mjs --candidate /path/to/candidate/dist/modern.mjs --rounds 20 --json results.json`.

Each path must point to a complete, independently built package with its native binary. Build both packages using the same Node and Rust versions. `--only 'walk children,walk fields'` selects cases. Keep the machine idle and repeat the entire run when results are close.

Each round starts a fresh process for each build, alternates their order, warms up five times, and records the median of ten actual load-plus-operation measurements. Every pair must return the same result. The report shows the median paired speedup and a percentile bootstrap interval over pairs; the JSON includes every pair and the median operation-only times. The interval describes sampling uncertainty in this run, not differences across machines, operating systems, or workloads. The two operations within a pair are sequential, so CPU frequency, thermal effects, and background work can still bias results.

The generated page is synthetic. This compares two Cheerox builds, not Cheerox against Cheerio, and does not establish that the 1.5x target has been met. Use representative input and separate Cheerio comparisons before making broader claims.
