#!/usr/bin/env python3
"""Cron wrapper for scripts/skillopt_lite.py.

No-agent cron semantics: empty stdout is silent. Print only when a candidate is
accepted, a regression/blocker appears, or the run cannot complete.
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys

REPO_SCRIPT = pathlib.Path(__file__).with_name("skillopt_lite.py")
if not REPO_SCRIPT.exists():
    # Local deployment fallback used by profile cron wrappers.
    REPO_SCRIPT = pathlib.Path("/Users/aytuncyildizli/hermes-workspace/hermes-skillopt-continuous/scripts/skillopt_lite.py")

cmd = ["python3", str(REPO_SCRIPT), "continuous-tick", "--json"]
proc = subprocess.run(cmd, text=True, capture_output=True, timeout=240)
if proc.returncode != 0:
    print(json.dumps({"status": "RED", "error": (proc.stderr or proc.stdout)[-800:]}, ensure_ascii=False))
    sys.exit(1)

try:
    summary = json.loads(proc.stdout.strip().splitlines()[-1])
except Exception as exc:
    print(json.dumps({"status": "RED", "error": f"invalid skillopt output: {exc}", "stdout": proc.stdout[-500:]}, ensure_ascii=False))
    sys.exit(1)

artifact = pathlib.Path(summary["artifact"])
report = (artifact / "report.md").read_text(errors="ignore") if (artifact / "report.md").exists() else ""
score_rows = []
score_path = artifact / "scores.jsonl"
if score_path.exists():
    score_rows = [json.loads(line) for line in score_path.read_text().splitlines() if line.strip()]

base = next((r for r in score_rows if r.get("artifact") == "base_skill.md"), {})
cand = next((r for r in score_rows if r.get("artifact") == "candidate_skill.md"), {})
accepted = summary.get("decision") == "ACCEPT"
regressed = cand.get("score", 0) < base.get("score", 0)

# Stay silent for clean no-op rejections. This is the normal continuous mode.
if not accepted and not regressed:
    sys.exit(0)

print(json.dumps({
    "status": "GREEN" if accepted else "YELLOW",
    "summary": "skillopt-lite continuous tick",
    "target": summary.get("target"),
    "decision": summary.get("decision"),
    "base": {"score": base.get("score"), "max": base.get("max")},
    "candidate": {"score": cand.get("score"), "max": cand.get("max")},
    "artifact": str(artifact),
    "report_head": "\n".join(report.splitlines()[:8]),
}, ensure_ascii=False))
