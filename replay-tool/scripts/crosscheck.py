#!/usr/bin/env python3
"""
Independent cross-check of StampTrace against the recording (and, optionally, against the
reference results of the Python test suite).

It reads the MCAP with the official `mcap` + `mcap-ros2-support` packages, recomputes every
quantity with numpy (no StampTrace code), and compares with StampTrace's verification.json:

    quantity | StampTrace | independent | diff | OK / MISMATCH

Tolerances: exact for counts, 0.1 ms for latencies and intervals, 0.01 Hz for rates.

Usage (from replay-tool/):
    python3 scripts/crosscheck.py dotLumen_CHG-TEST.mcap                       # runs the StampTrace export itself
    python3 scripts/crosscheck.py rec.mcap --stamptrace verification.json
    python3 scripts/crosscheck.py rec.mcap --trigger /farfield/Semantic=/farfield/CameraRGB ...
    python3 scripts/crosscheck.py rec.mcap --reference ../lumen_sw_test/out    # also prints the reference CSV rows it can map
Writes crosscheck.md and crosscheck.csv next to the StampTrace JSON; exit code 1 on any MISMATCH.

Definitions (shared with lumen_sw_test, sw_test/io.py / component.py / metrics.py):
  times relative to the first log time of the recording; stamp = header.stamp, log = MCAP log time
  e2e        = log_time(output) - header.stamp(output), every output message
  processing = log_time(output) - log_time(first trigger message with the same stamp)
  percentiles: numpy.percentile default (linear)
  rate (log)   = (n - 1) / (last - first log time)
  rate (stamp) = (n_unique - 1) / (last - first unique stamp)
  gap = interval > 1.5 x median interval on the same clock
  longest stall = longest interval on the trigger's frame grid with trigger frames and no output,
                  including recording start and end
"""
import argparse
import csv
import json
import os
import subprocess
import sys
from collections import defaultdict

import numpy as np
from mcap.reader import make_reader
from mcap_ros2.decoder import DecoderFactory

GAP_FACTOR = 1.5
TOL = {"count": 0, "ms": 0.1, "hz": 0.01, "s": 0.001, "ratio": 1e-6}


def read(paths):
    """Per topic: log times and header stamps (ns, absolute), in log-time order, all parts merged."""
    log = defaultdict(list)
    stamp = defaultdict(list)
    types = {}
    first = None
    factory = DecoderFactory()
    decoders = {}
    for p in paths:
        with open(p, "rb") as f:
            reader = make_reader(f)
            for schema, channel, message in reader.iter_messages(log_time_order=True):
                t = channel.topic
                types[t] = schema.name if schema else ""
                log[t].append(message.log_time)
                st = None
                if channel.message_encoding == "cdr" and schema is not None:
                    key = (channel.id, schema.id)
                    if key not in decoders:
                        decoders[key] = factory.decoder_for(channel.message_encoding, schema)
                    ros = decoders[key](message.data)
                    h = getattr(ros, "header", None)
                    if h is not None:
                        st = h.stamp.sec * 1_000_000_000 + h.stamp.nanosec
                elif channel.message_encoding == "json":
                    h = json.loads(message.data).get("header") if message.data[:1] == b"{" else None
                    if isinstance(h, dict) and isinstance(h.get("stamp"), dict):
                        st = int(h["stamp"].get("sec", 0)) * 1_000_000_000 + int(h["stamp"].get("nanosec", h["stamp"].get("nsec", 0)))
                stamp[t].append(st)
                first = message.log_time if first is None else min(first, message.log_time)
    for t in log:  # stable sort by log time (parts may interleave)
        order = sorted(range(len(log[t])), key=lambda i: log[t][i])
        log[t] = [log[t][i] for i in order]
        stamp[t] = [stamp[t][i] for i in order]
    return log, stamp, types, first


def pct(values, q):
    return float(np.percentile(np.asarray(values, dtype=np.float64), q)) if len(values) else float("nan")


def iv_stats(times_ns):
    u = np.unique(np.asarray(times_ns, dtype=np.int64))
    if len(u) < 2:
        return {"n": len(u), "rate": float("nan"), "max_ms": float("nan"), "median_ms": float("nan"), "gaps": 0}
    d = np.diff(u)
    med = float(np.median(d))
    return {"n": len(u), "rate": (len(u) - 1) * 1e9 / float(u[-1] - u[0]), "max_ms": float(d.max()) / 1e6, "median_ms": med / 1e6, "gaps": int(np.sum(d > GAP_FACTOR * med))}


def log_stats(times_ns):
    a = np.asarray(times_ns, dtype=np.int64)
    if len(a) < 2:
        return {"rate": float("nan"), "max_ms": float("nan"), "gaps": 0}
    d = np.diff(a)
    med = float(np.median(d))
    return {"rate": (len(a) - 1) * 1e9 / float(a[-1] - a[0]), "max_ms": float(d.max()) / 1e6, "gaps": int(np.sum(d > GAP_FACTOR * med))}


def summary(values_ns):
    v = [x for x in values_ns if x is not None and np.isfinite(x)]
    ms = [x / 1e6 for x in v]
    return {"n": len(v), "p50_ms": pct(ms, 50), "p95_ms": pct(ms, 95), "p99_ms": pct(ms, 99), "max_ms": max(ms) if ms else float("nan")}


def longest_stall(out_stamps, trig_stamps, start_ns, end_ns):
    produced = set(out_stamps)
    best, prev, missed = 0, start_ns, 0
    for s in sorted(set(trig_stamps)):
        if s in produced:
            if missed and s - prev > best:
                best = s - prev
            prev, missed = s, 0
        else:
            missed += 1
    if missed and end_ns - prev > best:
        best = end_ns - prev
    return best / 1e9 if best else None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mcap", nargs="+")
    ap.add_argument("--stamptrace", help="StampTrace verification.json (default: run the export)")
    ap.add_argument("--trigger", action="append", default=[], help="OUTPUT=INPUT (default: StampTrace's triggers)")
    ap.add_argument("--reference", help="lumen_sw_test out/ directory (optional, printed for comparison)")
    a = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    st_path = a.stamptrace
    if not st_path:
        st_path = os.path.join(os.getcwd(), "verification.json")
        cmd = ["npx", "tsx", os.path.join(here, "verify-export.ts"), *a.mcap, "--out", st_path]
        for t in a.trigger:
            cmd += ["--trigger", t]
        subprocess.run(cmd, check=True, cwd=os.path.dirname(here))
    st = json.load(open(st_path))

    log, stamp, types, first_log = read(a.mcap)
    t0 = int(st["first_log_time_ns"])
    rows = []

    def cmp(q, s_val, ref, kind):
        if s_val is None and (ref is None or (isinstance(ref, float) and np.isnan(ref))):
            rows.append((q, "—", "—", "", "OK"))
            return
        if s_val is None or ref is None or (isinstance(ref, float) and np.isnan(ref)):
            rows.append((q, s_val, ref, "", "MISMATCH"))
            return
        diff = abs(float(s_val) - float(ref))
        ok = diff <= TOL[kind] + 1e-9
        rows.append((q, s_val, round(float(ref), 6), round(diff, 6), "OK" if ok else "MISMATCH"))

    rows.append(("first log time (ns)", st["first_log_time_ns"], first_log, abs(int(st["first_log_time_ns"]) - first_log), "OK" if int(st["first_log_time_ns"]) == first_log else "MISMATCH"))
    end_ns = max(v[-1] for v in log.values()) - t0
    for topic in sorted(log):
        s = st["topics"].get(topic)
        if s is None:
            rows.append((f"{topic}: present", "missing", "present", "", "MISMATCH"))
            continue
        cmp(f"{topic}: count", s["count"], len(log[topic]), "count")
        L = log_stats(log[topic])
        cmp(f"{topic}: rate log (Hz)", s["rate_log_hz"], L["rate"], "hz")
        cmp(f"{topic}: max interval log (ms)", s["max_interval_log_ms"], L["max_ms"], "ms")
        cmp(f"{topic}: gaps log (> 1.5 x median)", len(s["gaps_log"]), L["gaps"], "count")
        if s["has_header"]:
            S = iv_stats(stamp[topic])
            cmp(f"{topic}: unique stamps", s["unique_stamps"], S["n"], "count")
            cmp(f"{topic}: rate stamp (Hz)", s["rate_stamp_hz"], S["rate"], "hz")
            cmp(f"{topic}: max interval stamp (ms)", s["max_interval_stamp_ms"], S["max_ms"], "ms")
            cmp(f"{topic}: gaps stamp (> 1.5 x median)", len(s["gaps_stamp"] or []), S["gaps"], "count")

    overrides = dict(t.split("=", 1) for t in a.trigger)
    for out, o in sorted(st["outputs"].items()):
        trig = overrides.get(out, o["trigger"])
        if out in overrides and overrides[out] != o["trigger"]:
            rows.append((f"{out}: trigger", o["trigger"], overrides[out], "", "MISMATCH"))
        else:
            rows.append((f"{out}: trigger", o["trigger"], trig, "", "OK"))
        e2e = [l - s for l, s in zip(log[out], stamp[out]) if s is not None]
        E = summary(e2e)
        for k in ("n", "p50_ms", "p95_ms", "p99_ms", "max_ms"):
            cmp(f"{out}: e2e {k}", o["e2e"][k], E[k], "count" if k == "n" else "ms")
        if trig and trig in log:
            first_by_stamp = {}
            for l, s in zip(log[trig], stamp[trig]):
                first_by_stamp.setdefault(s, l)
            proc = [l - first_by_stamp[s] for l, s in zip(log[out], stamp[out]) if s in first_by_stamp]
            P = summary(proc)
            for k in ("n", "p50_ms", "p95_ms", "p99_ms", "max_ms"):
                cmp(f"{out}: processing {k} (trigger {trig})", o["processing"][k], P[k], "count" if k == "n" else "ms")
            cmp(f"{out}: match ratio vs {trig}", o["match_ratio"], len(proc) / max(1, len(log[out])), "ratio")
            st_rel = [s - t0 for s in stamp[out]]
            tr_rel = [s - t0 for s in stamp[trig]]
            cmp(f"{out}: longest stall (s)", o["longest_stall_s"], longest_stall(st_rel, tr_rel, 0, end_ns), "s")

    if a.reference:
        print(f"\nReference files in {a.reference} (printed as-is; map them to the rows above):")
        for rel in ("inventory/topic_stats.csv", "component/latency_stats.csv", "component/match_ratios.csv", "inventory/gaps.csv"):
            p = os.path.join(a.reference, rel)
            if os.path.exists(p):
                with open(p) as f:
                    print(f"--- {rel}\n" + f.read().strip())
            else:
                print(f"--- {rel}: not found")

    bad = [r for r in rows if r[4] != "OK"]
    width = max(len(str(r[0])) for r in rows)
    lines = [f"| quantity | StampTrace | independent | diff | result |", "|---|---|---|---|---|"] + [f"| {r[0]} | {r[1]} | {r[2]} | {r[3]} | {r[4]} |" for r in rows]
    for r in rows:
        print(f"{str(r[0]).ljust(width)}  {str(r[1]):>14}  {str(r[2]):>14}  {str(r[3]):>10}  {r[4]}")
    base = os.path.splitext(st_path)[0]
    open(base.replace("verification", "crosscheck") + ".md" if "verification" in base else base + ".crosscheck.md", "w").write("\n".join(lines) + "\n")
    with open(base.replace("verification", "crosscheck") + ".csv" if "verification" in base else base + ".crosscheck.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["quantity", "stamptrace", "independent", "diff", "result"])
        w.writerows(rows)
    print(f"\n{len(rows)} quantities compared, {len(bad)} MISMATCH")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
