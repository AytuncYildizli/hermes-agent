#!/usr/bin/env python3
"""Cron wrapper for scripts/skillopt_lite.py.

No-agent cron semantics: empty stdout is silent. This cron is a detector/ledger,
not a production patcher. Print only when a blocker/regression appears or when a
static signal is worth human review.
"""
from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys


def resolve_skillopt_script() -> pathlib.Path:
    """Find the SkillOpt-lite runner without embedding developer-local paths."""
    candidates: list[pathlib.Path] = []
    env_script = os.environ.get("SKILLOPT_LITE_SCRIPT")
    if env_script:
        candidates.append(pathlib.Path(env_script).expanduser())
    candidates.append(pathlib.Path(__file__).with_name("skillopt_lite.py"))
    hermes_home = pathlib.Path(os.environ.get("HERMES_HOME", pathlib.Path.home() / ".hermes")).expanduser()
    candidates.append(hermes_home / "scripts" / "skillopt_lite.py")

    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise FileNotFoundError("skillopt_lite.py not found; set SKILLOPT_LITE_SCRIPT or install it under HERMES_HOME/scripts")


try:
    REPO_SCRIPT = resolve_skillopt_script()
except FileNotFoundError as exc:
    print(json.dumps({"status": "RED", "error": str(exc)}, ensure_ascii=False))
    sys.exit(1)

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

if summary.get("decision") == "NO_TARGETS":
    # Installed profile has none of the configured targets. Ledger already has
    # the no-targets row; cron stays quiet instead of spamming RED.
    sys.exit(0)

artifact = pathlib.Path(summary["artifact"])
report = (artifact / "report.md").read_text(errors="ignore") if (artifact / "report.md").exists() else ""
score_rows = []
score_path = artifact / "scores.jsonl"
if score_path.exists():
    score_rows = [json.loads(line) for line in score_path.read_text().splitlines() if line.strip()]

base = next((r for r in score_rows if r.get("artifact") == "base_skill.md"), {})
cand = next((r for r in score_rows if r.get("artifact") == "candidate_skill.md"), {})
signal = summary.get("decision") == "SIGNAL"
regressed = cand.get("score", 0) < base.get("score", 0)

# Stay silent for clean no-signal ticks. This is the normal continuous mode.
if not signal and not regressed:
    sys.exit(0)

print(json.dumps({
    "status": "SIGNAL" if signal else "YELLOW",
    "summary": "skillopt-lite detector tick",
    "target": summary.get("target"),
    "decision": summary.get("decision"),
    "base": {"score": base.get("score"), "max": base.get("max")},
    "candidate": {"score": cand.get("score"), "max": cand.get("max")},
    "artifact": str(artifact),
    "mode": "detector-ledger",
    "note": "static heuristic signal only; fixture-based behavioral eval is v2",
    "report_head": "\n".join(report.splitlines()[:8]),
}, ensure_ascii=False))
