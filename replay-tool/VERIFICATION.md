# StampTrace — verification against the Python analysis

Status: **definitions, labels and rules fixed and tested; the comparison on the challenge recording
(`dotLumen_CHG-TEST.mcap`) and on the reference results (`lumen_sw_test/out`) is NOT run yet** — neither
was available in the environment where this was done. Everything below that says "verified" was run;
everything that needs the real recording is listed under *Still to run* with the exact command.

## 1. What was checked

| Check | How | Result |
|---|---|---|
| Every number StampTrace computes vs an independent implementation | `scripts/crosscheck.py` (official `mcap` + `mcap-ros2-support` + numpy, no StampTrace code) on the demo recording | **139 / 139 OK** — [docs/verification/crosscheck-demo.md](docs/verification/crosscheck-demo.md) |
| Same, on a recording with injected faults (gap, late output, duplicate stamp, missing inputs, 2 FOVs) | same script on the fault recording of `tests/unit/faults.test.ts` | **133 / 133 OK** — [docs/verification/crosscheck-faults.md](docs/verification/crosscheck-faults.md) |
| The cross-check detects a difference | one count −1 and one p95 +0.2 ms changed in the StampTrace file | 2 MISMATCH reported, exit code 1 |
| Formulas pinned by tests | 8 deliberate mutations of the code (e2e offset, processing on stamp, nearest-rank percentile, gap factor 2, stale k 2, `>=` instead of `>`, intervals without unique stamps, stamp clock on log time) | **8 / 8 caught** (each makes ≥ 1 test fail) |
| Latency strip values in the browser | e2e: strip statistics vs a computation from the decoded arrays with an independent numpy-style percentile | OK |
| Both clocks | e2e: same moment, log vs header.stamp, the output panel shows the frame defined by each clock; tooltips explain them | OK |
| URL state | e2e: time, clock, view, layout and every override restored identically; links of older versions still work | OK |
| SHA-256 | unit: the hash shown equals `sha256` of every byte of the file | OK |
| English UI, no console errors | static scan of the source + e2e scan of text, tooltips, aria-labels in every view; console/page errors collected | 0 Romanian texts, 0 errors |
| Full suite | `npm run test:all` | typecheck, 130 unit (+8 skipped: the challenge regression, no file), 35 e2e — all pass |

## 2. The "p95 218.7 vs 215.6 ms" difference — cause

Found in the code (to be confirmed with numbers on the real recording): the replay latency strip
did not show an output's latency. It showed a **causal edge** (`src/views/ReplayView.tsx`, before the
fix): `log_time(output) − header.stamp(input)` computed **only on the output messages whose stamp
also exists in that input**, and the input could be another output. The deep link shown in the demo
had the chain `/farfield/Semantic → /farfield/ColorizedPointCloud`: the p95 was over the clouds that
have a Semantic with the same stamp — a subset of the 123 — while the max cloud is in that subset.
Reproduced in `tests/unit/chains.test.ts` ("the old edge-based value is a subset statistic and differs").

Fix: one **e2e** chain (`log(output) − stamp(output)`, every message) and one **processing** chain
(`log(output) − log(trigger, same stamp)`) per output, labelled `<trigger> → <output> (e2e|processing)`,
with n, p50, p95, p99, max and the definition under the strip.

## 3. Definitions used (single source: `src/core/parity.ts`, `src/core/stats.ts`, `src/core/sync.ts`)

| Quantity | Definition |
|---|---|
| Times | ns relative to the first log time of the recording (`stamp` = header.stamp, `log` = MCAP log time) |
| e2e latency | `log_time(output) − header.stamp(output)` (= stamp of the input frame), every output message |
| processing latency | `log_time(output) − log_time(first trigger message with the same stamp)` |
| Trigger | input whose stamps the output copies (≥ 50 %, logged before it) and whose missing frames suppress it; several → the one logged last. **`check` badge when the data cannot tell the inputs apart** (no missing frame) |
| Percentiles | linear interpolation (numpy.percentile default) |
| Rate (log) | `(n − 1) / (last − first log time)` |
| Rate (stamp) | `(n_unique − 1) / (last − first unique header.stamp)` |
| Gap | interval between consecutive messages `> 1.5 ×` the topic's median interval on the same clock (timeline: log; Inventory: log and stamp) |
| Stale panel | `age > 3 ×` nominal period (k configurable), age = replay time − message time on the selected clock; only OK / Stale |
| Nominal period | median unique-stamp interval; images/clouds: median of the intervals `< 1.5 ×` the median (dropped frames excluded); overridable |
| Longest stall | longest interval on the trigger's frame grid with trigger frames and no output, incl. recording start/end |
| Walking distance | `latency × speed`, speed shown next to it (1.4 m/s assumed without IMU) |
| SHA-256 | of every byte of the loaded file(s) |

## 4. What changed

1. Latency strip: chains named by what is measured, e2e + processing for every output, n/p50/p95/p99/max, definition under the strip, walking speed stated.
2. Trigger inference: reports *evidence* vs *tie-break*; a `check` badge appears when the choice is not supported by missing frames.
3. Slow outputs (< 20 % of the camera frames, e.g. farfield Semantic at 4.66 Hz) are outputs, not inputs.
4. Gap rule 1.5 × median on both clocks (was 2× in Inventory and a free factor in the timeline); Inventory shows rate, max interval and gaps on log **and** stamp.
5. Stale rule `age > 3 × nominal period`, the undocumented "Late" level removed; panel header shows `age …` with clock, period and threshold in its tooltip.
6. Clock buttons explain their clock; English everywhere (static check in `npm run test:all`).
7. Issue markers from a JSON file on the timeline (`docs/demo/lumen-issues.json`, also in the app: palette → *Load issue markers*), one jump button each (clock + time + topics).
8. `verification.json` export (app: Causality & latency → *Verification JSON*; CLI: `npm run verify:export`) and `scripts/crosscheck.py`.
9. Command palette: Enter ignored when the pointer rested over the list (fixed).

## 5. Still to run on the challenge recording

These need `dotLumen_CHG-TEST.mcap` and `lumen_sw_test/out`; **no value below has been measured by me yet**.

```bash
cd replay-tool
pip install mcap==1.2.2 mcap-ros2-support==0.5.5 numpy
python3 scripts/crosscheck.py /path/dotLumen_CHG-TEST.mcap \
  --trigger /farfield/Semantic=/farfield/CameraRGB --trigger /farfield/ColorizedPointCloud=/farfield/CameraDepth \
  --trigger /nearfield/Semantic=/nearfield/CameraRGB --trigger /nearfield/ColorizedPointCloud=/nearfield/CameraDepth \
  --reference /path/lumen_sw_test/out
LUMEN_MCAP=/path/dotLumen_CHG-TEST.mcap npx vitest run tests/unit/regression-lumen.test.ts
```

The first command prints StampTrace vs independent for every quantity (`trigger` rows show MISMATCH if
StampTrace inferred a different trigger than the reference one) and prints the reference CSVs next to
it. Expected from the reference (to compare): e2e (n, p50, p95, max) farfield Semantic 140 / 108.7 /
342.6 / 1897.5 ms; farfield ColorizedPointCloud 123 / 107.0 / 215.6 / 341.2; nearfield Semantic 421 /
64.7 / 164.5 / 1078.0; nearfield ColorizedPointCloud 406 / 67.3 / 113.3 / 201.6.

**Risks to check first** (Inventory → Inferred settings):
- `CameraDepth` must be an **input**. If it shares CameraRGB's stamps, is logged > 2 ms after it and is
  never present when CameraRGB is missing, StampTrace classifies it as an output of CameraRGB (the data
  cannot prove otherwise). Fix: set its role to input — saved in the deep link.
- Triggers marked `check`: confirm or override (CameraRGB for Semantic, CameraDepth for ColorizedPointCloud).
- Nominal periods: expected 33.3 ms (inputs), 200 ms (farfield outputs), 66.7 ms (nearfield outputs).

## 6. Two-minute demo path (on the challenge recording, after section 5 is OK)

Open the file, palette (Ctrl+K) → *Load issue markers: .lumen challenge*. Layout preset → *Inputs and outputs per FOV*.

| Time | Do | Visible | Point at |
|---|---|---|---|
| 0:00 | Causality & latency → *Python test-suite metrics* | per output: trigger, n, e2e p50/p95/p99/max, processing | farfield Semantic e2e p95 (reference 342.6 ms) and its definition line |
| 0:25 | Replay, latency strip: `/farfield/CameraDepth → /farfield/ColorizedPointCloud (e2e)` | n · p50 · p95 · p99 · max under the definition | p95 (reference 215.6 ms), n (reference 123) |
| 0:45 | Timeline → `ISSUE-3 ↗` (header.stamp clock, 14.836 s) | farfield cloud and depth of the same stamp | FOV consistency: median depth error of that cloud |
| 1:05 | `ISSUE-2 ↗` (log clock, 28.53 s) | farfield output panels **Stale** (age ≈ 1.0 s > 3 × 200 ms), cameras OK (≈ 20 ms) | the age in the panel header and its tooltip (rule) |
| 1:30 | `ISSUE-1 ↗` (log clock, 33.7 s) | all 4 output panels Stale (≈ 3.7 s), cameras live; timeline band 29.9–33.71 s | output ages ≈ 3.7 s, timeline gap rows |
| 1:50 | Switch to header.stamp | outputs line up with their input frames, ages change | the clock tooltip: log = what the consumer received when, stamp = which frame it was computed from |

The expected values in this table are the reference values from the brief; confirm each with the
cross-check (section 5) before the demo.
