from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


def load_module(repo_root: Path):
    path = repo_root / "scripts" / "skillopt_lite.py"
    spec = importlib.util.spec_from_file_location("skillopt_lite", path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def write_skill(root: Path, name: str, body: str) -> Path:
    skill_dir = root / name
    skill_dir.mkdir(parents=True)
    path = skill_dir / "SKILL.md"
    path.write_text(f"---\nname: {name}\n---\n\n# {name}\n\n{body}\n", encoding="utf-8")
    return path


def test_default_targets_exist_in_repo_skills():
    repo = Path(__file__).resolve().parents[2]
    mod = load_module(repo)
    roots = [repo / "skills"]

    missing = []
    for target in mod.DEFAULT_TARGETS:
        try:
            mod.resolve_skill(target, roots)
        except SystemExit:
            missing.append(target)

    assert missing == []


def test_continuous_tick_rotates_targets_and_writes_artifacts(tmp_path):
    repo = Path(__file__).resolve().parents[2]
    mod = load_module(repo)
    skills = tmp_path / "skills"
    run_root = tmp_path / "runs"
    state = run_root / "state.json"
    write_skill(skills, "alpha", "Use when asked. Steps: inspect then answer. Output: short.")
    write_skill(skills, "beta", "Use when asked. Steps: inspect then answer. Output: short.")

    target, loaded_state = mod.choose_target(["alpha", "beta"], state)
    assert target == "alpha"
    run_a = mod.run_once(target, roots=[skills], run_root=run_root)
    decision_a = mod.decision_from_report(run_a)
    mod.update_state(state, loaded_state, ["alpha", "beta"], target, run_a, decision_a)

    target, loaded_state = mod.choose_target(["alpha", "beta"], state)
    assert target == "beta"
    run_b = mod.run_once(target, roots=[skills], run_root=run_root)
    decision_b = mod.decision_from_report(run_b)
    mod.update_state(state, loaded_state, ["alpha", "beta"], target, run_b, decision_b)

    data = json.loads(state.read_text())
    assert data["index"] == 0
    assert [r["target"] for r in data["runs"]] == ["alpha", "beta"]
    for run_dir in [run_a, run_b]:
        assert (run_dir / "base_skill.md").exists()
        assert (run_dir / "candidate_skill.md").exists()
        assert (run_dir / "best_skill.md").exists()
        assert (run_dir / "report.md").exists()


def test_tick_wrapper_has_no_developer_local_fallback_path():
    repo = Path(__file__).resolve().parents[2]
    wrapper = (repo / "scripts" / "skillopt_lite_tick.py").read_text(encoding="utf-8")

    assert "/Users/" not in wrapper
    assert "SKILLOPT_LITE_SCRIPT" in wrapper
    assert "HERMES_HOME" in wrapper


def test_candidate_is_rejected_when_skill_already_scores_full(tmp_path):
    repo = Path(__file__).resolve().parents[2]
    mod = load_module(repo)
    skills = tmp_path / "skills"
    run_root = tmp_path / "runs"
    full_body = """
Trigger: use when asked.
Workflow: inspect, act, verify.
Evidence: cite source and file/line receipts.
Verification: run tests or smoke.
Failure fallback: report blocked state.
Bounded scope: do not touch adjacent cleanup.
Output contract: changed, verified, next.
Side effects require approval before send/delete/pay.
"""
    write_skill(skills, "full", full_body)

    run_dir = mod.run_once("full", roots=[skills], run_root=run_root)
    report = (run_dir / "report.md").read_text()
    rejected = (run_dir / "rejected_edits.jsonl").read_text()

    assert "Base: 8/8" in report
    assert "Decision: REJECT" in report
    assert "no validation improvement" in rejected
