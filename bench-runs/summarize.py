#!/usr/bin/env python3
"""Summarize N benchmark-report.json files into a comparison table."""
import json, sys, glob, os, statistics as st

pat = sys.argv[1] if len(sys.argv) > 1 else "run*.json"
paths = sorted(glob.glob(os.path.join(os.path.dirname(__file__), pat)))
if not paths:
    sys.exit("no run*.json found")
reps = [(os.path.basename(p).replace(".json",""), json.load(open(p))) for p in paths]

def g(d, *keys, default=None):
    for k in keys:
        if d is None: return default
        d = d.get(k) if isinstance(d, dict) else None
    return default if d is None else d

def fmt(v, nd=2):
    if v is None: return "-"
    if isinstance(v, bool): return "yes" if v else "NO"
    if isinstance(v, float): return f"{v:,.{nd}f}"
    return str(v)

W = 26
def row(label, vals, nd=2):
    print(f"{label:<{W}}" + "".join(f"{fmt(v,nd):>16}" for v in vals))

names = [n for n,_ in reps]
print("="*(W+16*len(reps)))
print("ENVIRONMENT")
print("="*(W+16*len(reps)))
e = reps[0][1].get("engine", {})
print(f"  OS                 : {e.get('operatingSystem')}")
print(f"  CPUs               : {e.get('cpus')}  (required {e.get('requiredCpus')}, sufficient={e.get('sufficient')})")
print(f"  Memory             : {e.get('memoryBytes',0)/2**30:.1f} GiB  (required {e.get('requiredMemoryBytes',0)/2**30:.2f} GiB, sufficient={e.get('memorySufficient')})")
print(f"  Generator          : {reps[0][1].get('generator')}  isolated={reps[0][1].get('generatorIsolated')}")
print(f"  Resource limits    : enforced={reps[0][1].get('resourceLimitsEnforced')}")
print(f"  Score version      : {g(reps[0][1],'score','version')}")
for n,d in reps:
    print(f"  {n} generatedAt    : {d.get('generatedAt')}")

print()
print("="*(W+16*len(reps)))
print("SCORE" + " "*(W-5) + "".join(f"{n:>16}" for n in names))
print("="*(W+16*len(reps)))
row("machine speed (factor)", [g(d,'machineSpeed','factor') for _,d in reps], 4)
row("  workUnits/sec",        [g(d,'machineSpeed','workUnitsPerSecond') for _,d in reps], 3)
print("-"*(W+16*len(reps)))
row("TOTAL SCORE /100",       [g(d,'score','score') for _,d in reps])
row("  Correctness /15",      [g(d,'score','correctness','points') for _,d in reps])
row("  Performance /50",      [g(d,'score','performance','points') for _,d in reps])
row("  Queries /15",          [g(d,'score','queries','points') for _,d in reps])
row("  Reliability /20",      [g(d,'score','reliability','points') for _,d in reps])
row("  applied cap",          [g(d,'score','calculation','appliedCap') for _,d in reps])
row("  eligible",             [g(d,'score','eligibility','eligible') for _,d in reps])
print("-"*(W+16*len(reps)))
print("component detail")
row("  perf.throughput",      [g(d,'score','performance','components','throughput') for _,d in reps], 4)
row("  perf.errors",          [g(d,'score','performance','components','errors') for _,d in reps], 4)
row("  perf.latency",         [g(d,'score','performance','components','latency') for _,d in reps], 4)
row("  perf.sustainedBonus",  [g(d,'score','performance','components','sustainedBonus') for _,d in reps], 4)
row("  q.aggregateLatency",   [g(d,'score','queries','components','aggregateLatency') for _,d in reps], 4)
row("  q.eventualConsist pts",[g(d,'score','queries','components','eventualConsistencyPoints') for _,d in reps], 3)
row("  q.readAfterWrite",     [g(d,'score','queries','components','readAfterWrite') for _,d in reps], 4)
row("  rel.scenarioCompletion",[g(d,'score','reliability','components','scenarioCompletion') for _,d in reps], 3)
row("  rel.crashFree",        [g(d,'score','reliability','components','crashFree') for _,d in reps], 3)

print()
print("="*(W+16*len(reps)))
print("CORRECTNESS (the only category that transfers to the grade)")
print("="*(W+16*len(reps)))
row("passed / total", [f"{g(d,'correctness','passed')}/{g(d,'correctness','total')}" for _,d in reps])
check_names = [c["name"] for c in reps[0][1]["correctness"]["checks"]]
any_fail = False
for cn in check_names:
    res = []
    for _,d in reps:
        c = next((x for x in d["correctness"]["checks"] if x["name"]==cn), None)
        res.append(c.get("passed") if c else None)
    if not all(r is True for r in res):
        any_fail = True
        row("  FAIL " + cn, res)
        for n,d in reps:
            c = next((x for x in d["correctness"]["checks"] if x["name"]==cn), None)
            if c and not c.get("passed"):
                print(f"      {n}: expected={c.get('expected')!r} actual={c.get('actual')!r}")
if not any_fail:
    print("  all checks passed in every run")

print()
print("="*(W+16*len(reps)))
print("SCENARIOS")
print("="*(W+16*len(reps)))
scen_names = [s["scenario"] for s in reps[0][1]["scenarios"]]
FIELDS = [("status",None),("logsPerSecond",1),("offeredLogsPerSecond",0),("errorRate",5),
          ("latencyP95Ms",1),("aggregateP95Ms",1),("readAfterWriteSuccessRate",4),
          ("thresholdPassed",None),("consistencyPassed",None),("acceptedRecords",0),
          ("visibleRecords",0),("droppedIterations",0),("generatorLimited",None),("serviceLimited",None)]
for sn in scen_names:
    print(f"\n-- scenario: {sn} " + "-"*(W+16*len(reps)-len(sn)-15))
    print(" "*W + "".join(f"{n:>16}" for n in names))
    for f, nd in FIELDS:
        vals = []
        for _,d in reps:
            s = next((x for x in d["scenarios"] if x["scenario"]==sn), None)
            vals.append(s.get(f) if s else None)
        row("  "+f, vals, nd if nd is not None else 2)

print()
print("="*(W+16*len(reps)))
print("VARIANCE ACROSS RUNS  (spread = max-min; %spread relative to mean)")
print("="*(W+16*len(reps)))
def spread(label, vals, thresh_pct=5.0):
    nums = [v for v in vals if isinstance(v,(int,float)) and not isinstance(v,bool)]
    if len(nums) < 2: return
    mn, mx, mean = min(nums), max(nums), st.mean(nums)
    sp = mx-mn
    pct = (sp/mean*100) if mean else 0.0
    flag = "  <-- LARGE" if pct >= thresh_pct else ""
    sd = st.stdev(nums) if len(nums)>1 else 0.0
    print(f"{label:<30} min={mn:>12,.3f} max={mx:>12,.3f} mean={mean:>12,.3f} sd={sd:>10,.3f} spread={sp:>11,.3f} ({pct:5.1f}%){flag}")

spread("TOTAL SCORE",        [g(d,'score','score') for _,d in reps], 2.0)
spread("Correctness pts",    [g(d,'score','correctness','points') for _,d in reps], 0.1)
spread("Performance pts",    [g(d,'score','performance','points') for _,d in reps], 3.0)
spread("Queries pts",        [g(d,'score','queries','points') for _,d in reps], 3.0)
spread("Reliability pts",    [g(d,'score','reliability','points') for _,d in reps], 1.0)
spread("machine speed factor",[g(d,'machineSpeed','factor') for _,d in reps], 5.0)
for sn in scen_names:
    for f in ("logsPerSecond","latencyP95Ms","aggregateP95Ms","errorRate","readAfterWriteSuccessRate"):
        vals = []
        for _,d in reps:
            s = next((x for x in d["scenarios"] if x["scenario"]==sn), None)
            vals.append(s.get(f) if s else None)
        spread(f"{sn}.{f}", vals, 10.0)
