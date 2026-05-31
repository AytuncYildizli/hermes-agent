#!/usr/bin/env python3
"""SkillOpt-lite: validation-gated optimizer scaffold for Hermes SKILL.md files.

This is intentionally conservative: it never mutates production skills. Each run
selects one target skill, writes an artifact bundle under ``~/hermes-workspace``
or ``$SKILLOPT_RUN_ROOT``, scores base vs candidate, and exports ``best_skill.md``
only when the bounded candidate improves validation checks.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

DEFAULT_TARGETS = [
    "code-review",
    "systematic-debugging",
    "x-bookmark-browser-patrol",
    "hermes-agent",
    "executive-assistant",
]

CHECKS = {
    "trigger": (r"trigger|when to use|ne zaman|use when", "declares when the skill should run"),
    "workflow": (r"workflow|steps|protocol|checklist|mandatory|zorunlu", "has a mechanical workflow"),
    "evidence": (r"evidence|receipt|file/line|path:line|source|kaynak|kanıt", "requires evidence/receipts"),
    "verification": (r"verify|verification|test|smoke|doğrula|kontrol", "requires verification"),
    "failure_recovery": (r"failure|blocked|fallback|retry|recovery|hata|blocker", "has failure/fallback handling"),
    "bounded_scope": (r"bounded|scope|do not|never|yasak|smallest|surgical", "keeps scope bounded"),
    "output_contract": (r"output|final|format|template|receipt|çıktı", "defines output contract"),
    "side_effects": (r"approval|confirm|side effects|delete|send|pay|onay|danger", "guards risky side effects"),
}

GENERIC_PATCH = """
## SkillOpt-lite hardening

- State the trigger before acting; if the trigger is fuzzy, write the assumption.
- Keep the workflow mechanical: inspect inputs, act in the narrow scope, then verify.
- Every non-obvious claim needs a receipt: file path, command output, source URL, or artifact path.
- If verification is blocked, report the exact blocker and the safest fallback instead of calling it GREEN.
- Do not expand into adjacent cleanup, production changes, deletes, sends, payments, or auth churn without explicit approval.
- Final output should be compact: changed, verified, blocker, next.
""".strip()

TARGET_PATCHES = {
    "code-review": """
### Evidence discipline for review findings

- Every Must Fix finding should cite concrete file/line evidence when available.
- Prefer `path:line` receipts over broad claims.
- Mark speculative issues as `Question` or `Needs verification`; do not present guesses as blockers.
- For security findings, include exploit path or failing input shape, not just category names.
- Keep fixes bounded: smallest safe patch, plus exact test/smoke command when known.
""".strip(),
    "systematic-debugging": """
### Repro-before-fix gate

- Do not patch before reproducing or building a deterministic failing check.
- If reproduction is impossible, name the missing input/env/log and create the smallest diagnostic probe.
- Verify the fix with the same failing check plus one regression guard.
- Keep unrelated cleanup out of the debugging patch.
""".strip(),
    "x-bookmark-browser-patrol": """
### Duplicate and breadth gate

- A patrol is incomplete unless it inspects a useful breadth of newest visible items or reports YELLOW with the UI/login blocker.
- Maintain a seen ledger before origin delivery; empty/no-new output must stay silent.
- Open promising detail pages before classifying AL/WATCH/PARK.
- Never use X write actions during patrol.
""".strip(),
    "hermes-agent": """
### Hermes ops receipt gate

- For Hermes config/tool/profile changes, record the exact profile, files changed, restart command, and smoke result.
- Do not attach broad Hermes lifecycle instructions to unrelated crons; use narrow skills to avoid prompt-injection scanner trips.
- If a profile-specific skill/config is touched, verify with that profile, not the default profile by accident.
""".strip(),
    "executive-assistant": """
### External-action approval gate

- Draft emails/messages/calendar changes as proposals unless the user explicitly authorized sending or modifying.
- Stop before payment, booking, OTP/2FA, account changes, or messaging another person.
- For current facts, dates, travel rules, and reservations, verify with a current source before giving instructions.
""".strip(),
}


@dataclass(frozen=True)
class Score:
    total: int
    max_total: int
    hits: dict[str, bool]


def hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")).expanduser()


def default_run_root() -> Path:
    return Path(os.environ.get("SKILLOPT_RUN_ROOT", Path.home() / "hermes-workspace" / "skillopt-runs")).expanduser()


def skill_roots(extra: Iterable[str] = ()) -> list[Path]:
    roots = [hermes_home() / "skills"]
    for raw in extra:
        if raw:
            roots.append(Path(raw).expanduser())
    return roots


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


def write_json(path: Path, data: object) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_jsonl(path: Path, rows: Iterable[dict]) -> None:
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")


def resolve_skill(name: str, roots: Iterable[Path]) -> Path:
    candidates: list[Path] = []
    frontmatter_name = re.compile(rf"^name:\s*['\"]?{re.escape(name)}['\"]?\s*$", re.M)
    for root in roots:
        if not root.exists():
            continue
        for p in root.rglob("SKILL.md"):
            try:
                head = read_text(p)[:2000]
            except OSError:
                continue
            if p.parent.name == name or frontmatter_name.search(head):
                candidates.append(p)
    if not candidates:
        raise SystemExit(f"skill not found: {name}")
    candidates.sort(key=lambda p: (p.parent.name != name, len(str(p))))
    return candidates[0]


def score_skill(text: str) -> Score:
    hits = {name: bool(re.search(pattern, text, re.I)) for name, (pattern, _) in CHECKS.items()}
    return Score(sum(hits.values()), len(hits), hits)


def propose_candidate(skill_name: str, base: str) -> tuple[str, list[dict]]:
    patch_text = TARGET_PATCHES.get(skill_name, GENERIC_PATCH)
    title = patch_text.splitlines()[0].strip()
    if title in base:
        return base, []

    missing_before = [key for key, hit in score_skill(base).hits.items() if not hit]
    patch = [{
        "op": "append_section",
        "title": title.lstrip("# "),
        "missing_checks_before": missing_before,
        "budget_tokens_est": len(patch_text.split()),
    }]
    candidate = base.rstrip() + "\n\n" + patch_text + "\n"
    return candidate, patch


def run_once(skill_name: str, *, roots: list[Path], run_root: Path) -> Path:
    skill_path = resolve_skill(skill_name, roots)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = run_root / skill_name / ts
    run_dir.mkdir(parents=True, exist_ok=True)

    base = read_text(skill_path)
    candidate, patch = propose_candidate(skill_name, base)
    base_score = score_skill(base)
    cand_score = score_skill(candidate)
    accepted = bool(patch) and cand_score.total > base_score.total

    (run_dir / "base_skill.md").write_text(base, encoding="utf-8")
    (run_dir / "candidate_skill.md").write_text(candidate, encoding="utf-8")
    (run_dir / "best_skill.md").write_text(candidate if accepted else base, encoding="utf-8")
    (run_dir / "source_path.txt").write_text(str(skill_path) + "\n", encoding="utf-8")
    write_jsonl(run_dir / "candidate_edits.jsonl", patch)
    write_jsonl(run_dir / "scores.jsonl", [
        {"artifact": "base_skill.md", "score": base_score.total, "max": base_score.max_total, "hits": base_score.hits},
        {"artifact": "candidate_skill.md", "score": cand_score.total, "max": cand_score.max_total, "hits": cand_score.hits},
    ])
    write_jsonl(run_dir / "rejected_edits.jsonl", [] if accepted else [{
        "patch": patch,
        "reason": "no validation improvement",
        "base": base_score.total,
        "candidate": cand_score.total,
    }])

    improved = [k for k, v in cand_score.hits.items() if v and not base_score.hits.get(k)]
    report = [
        f"# SkillOpt-lite run: {skill_name}",
        "",
        f"Source: {skill_path}",
        f"Base: {base_score.total}/{base_score.max_total}",
        f"Candidate: {cand_score.total}/{cand_score.max_total}",
        f"Decision: {'ACCEPT' if accepted else 'REJECT'}",
        "",
        "## Candidate edit budget",
        f"Edits: {len(patch)}",
        f"Tokens est: {sum(p.get('budget_tokens_est', 0) for p in patch)}",
        "",
        "## Improved checks",
        *(f"- {key}" for key in improved),
        "",
        "## Artifacts",
        "- base_skill.md",
        "- candidate_skill.md",
        "- best_skill.md",
        "- scores.jsonl",
        "- rejected_edits.jsonl",
    ]
    (run_dir / "report.md").write_text("\n".join(report) + "\n", encoding="utf-8")
    return run_dir


def load_state(path: Path) -> dict:
    if not path.exists():
        return {"index": 0, "runs": []}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"index": 0, "runs": [], "state_error": "invalid json replaced"}


def choose_target(targets: list[str], state_path: Path) -> tuple[str, dict]:
    state = load_state(state_path)
    idx = int(state.get("index", 0)) % len(targets)
    return targets[idx], state


def update_state(state_path: Path, state: dict, targets: list[str], target: str, run_dir: Path, decision: str) -> None:
    idx = (targets.index(target) + 1) % len(targets)
    state.update({"index": idx, "targets": targets, "updated_at": datetime.now(timezone.utc).isoformat()})
    runs = list(state.get("runs", []))[-49:]
    runs.append({"target": target, "artifact": str(run_dir), "decision": decision, "ts": state["updated_at"]})
    state["runs"] = runs
    state_path.parent.mkdir(parents=True, exist_ok=True)
    write_json(state_path, state)


def decision_from_report(run_dir: Path) -> str:
    report = read_text(run_dir / "report.md") if (run_dir / "report.md").exists() else ""
    return "ACCEPT" if "Decision: ACCEPT" in report else "REJECT" if "Decision: REJECT" in report else "UNKNOWN"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["run", "continuous-tick", "init-code-review"], nargs="?", default="continuous-tick")
    ap.add_argument("--target", action="append", help="Skill target. Repeat to define the continuous rotation.")
    ap.add_argument("--skills-root", action="append", default=[], help="Additional skills root to search.")
    ap.add_argument("--run-root", default=str(default_run_root()))
    ap.add_argument("--state", default="", help="Continuous state path. Defaults under run root.")
    ap.add_argument("--json", action="store_true", help="Print JSON summary instead of just artifact path.")
    args = ap.parse_args()

    targets = args.target or DEFAULT_TARGETS
    roots = skill_roots(args.skills_root)
    run_root = Path(args.run_root).expanduser()
    state_path = Path(args.state).expanduser() if args.state else run_root / "skillopt-lite-state.json"

    if args.cmd == "init-code-review":
        targets = ["code-review"]
        target = "code-review"
        state = load_state(state_path)
    elif args.cmd == "run":
        target = targets[0]
        state = load_state(state_path)
    else:
        target, state = choose_target(targets, state_path)

    run_dir = run_once(target, roots=roots, run_root=run_root)
    decision = decision_from_report(run_dir)
    update_state(state_path, state, targets, target, run_dir, decision)

    summary = {"target": target, "decision": decision, "artifact": str(run_dir)}
    if args.json:
        print(json.dumps(summary, ensure_ascii=False))
    else:
        print(run_dir)


if __name__ == "__main__":
    main()
