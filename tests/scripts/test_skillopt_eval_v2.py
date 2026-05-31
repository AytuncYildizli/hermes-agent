from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


def load_eval_module(repo_root: Path):
    path = repo_root / "scripts" / "skillopt_eval_v2.py"
    spec = importlib.util.spec_from_file_location("skillopt_eval_v2", path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def test_fixture_behavioral_eval_scaffold_loads_contracts():
    repo = Path(__file__).resolve().parents[2]
    mod = load_eval_module(repo)
    fixtures = mod.load_fixtures(repo / "tests" / "fixtures" / "skillopt_behavior")

    assert fixtures
    result = mod.evaluate_fixture(fixtures[0])
    assert result["passed"] is True
    assert result["expected_behavior_count"] > 0
    assert result["forbidden_behavior_count"] > 0


def test_fixture_behavioral_eval_rejects_malformed_fixture():
    repo = Path(__file__).resolve().parents[2]
    mod = load_eval_module(repo)

    result = mod.evaluate_fixture({"id": "broken"})

    assert result["passed"] is False
    assert "expected_behavior" in result["missing_fields"]
