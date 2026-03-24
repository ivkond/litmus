"""
LLM-powered analysis of test run results.

Evaluates agents (CLI tools) and models (LLMs) across 20 criteria each.
Uses litellm directly (no instructor) for provider compatibility.

Supports incremental evaluation: evaluate_run() can be called per-run
as each completes, then assemble_report() builds the final HTML.

Usage:
    from analysis import evaluate_run, assemble_report, generate_analysis
"""

import csv
import json
import logging
import re
import time as _time
import traceback
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

from pydantic import BaseModel, Field

from . import PROJECT_ROOT
from .report import _CSS, _collect_run, escape_html

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Criteria definitions
# ---------------------------------------------------------------------------

AGENT_CRITERIA = [
    ("tool_efficiency", "Tool efficiency", "Minimality of tool calls to solve the task"),
    ("reasoning_verbosity", "Reasoning verbosity", "Amount of filler in reasoning output"),
    ("thinking_depth", "Thinking depth", "How deeply the agent analyzes before acting"),
    ("error_recovery", "Error recovery", "Ability to recover from failed attempts"),
    ("context_utilization", "Context utilization", "Uses context from previous steps"),
    ("file_operation_accuracy", "File operation accuracy", "Correctness of file create/edit ops"),
    ("retry_strategy", "Retry strategy", "Reasonableness of retry approach"),
    ("output_formatting", "Output formatting", "Readability of output for the user"),
    ("task_decomposition", "Task decomposition", "Breaks complex tasks into subtasks"),
    ("dependency_management", "Dependency management", "Correct handling of project deps"),
    ("test_awareness", "Test awareness", "Considers tests when writing code"),
    ("code_generation_quality", "Code generation quality", "Structure and style of generated code"),
    ("prompt_interpretation", "Prompt interpretation", "Accuracy of understanding the prompt"),
    ("execution_speed", "Execution speed", "Speed of execution (time per step)"),
    ("side_effect_awareness", "Side effect awareness", "Considers side effects of actions"),
    ("idempotency", "Idempotency", "Repeated runs produce same result"),
    ("progress_communication", "Progress communication", "Informs about execution progress"),
    ("resource_efficiency", "Resource efficiency", "Economy of API calls / tokens"),
    ("graceful_degradation", "Graceful degradation", "Behavior on partial errors"),
    ("final_state_correctness", "Final state correctness", "Project state after agent finishes"),
]

MODEL_CRITERIA = [
    ("reasoning_correctness", "Reasoning correctness", "Correctness of logical chains"),
    ("tool_call_formation", "Tool call formation", "Correctness of tool call syntax"),
    ("code_correctness", "Code correctness", "Syntactic and logical code correctness"),
    ("instruction_following", "Instruction following", "Adherence to instructions"),
    ("hallucination_resistance", "Hallucination resistance", "Absence of made-up APIs/functions"),
    ("type_awareness", "Type awareness", "Correctness of data types and signatures"),
    ("error_diagnosis", "Error diagnosis", "Ability to diagnose errors from tracebacks"),
    ("solution_completeness", "Solution completeness", "Completeness of the solution"),
    ("code_style_consistency", "Code style consistency", "Uniformity of code style"),
    ("api_knowledge_accuracy", "API knowledge accuracy", "Accuracy of real API knowledge"),
    ("edge_case_handling", "Edge case handling", "Handling of boundary cases"),
    ("architecture_understanding", "Architecture understanding", "Understanding of project arch"),
    ("import_correctness", "Import correctness", "Correctness of imports and deps"),
    ("test_understanding", "Test understanding", "Understanding of test expectations"),
    ("debugging_strategy", "Debugging strategy", "Quality of debugging approach"),
    ("natural_language_clarity", "NL clarity", "Clarity of natural language explanations"),
    ("self_correction_ability", "Self-correction", "Ability to fix own mistakes on retry"),
    ("context_window_usage", "Context window usage", "Efficient use of context window"),
    ("output_structure", "Output structure", "Structured and organized responses"),
    ("domain_knowledge", "Domain knowledge", "Knowledge of the task domain"),
]

LOG_TRUNCATE = 4000

TEMPLATE_DIR = PROJECT_ROOT / "template"


# ---------------------------------------------------------------------------
# Pydantic response models — scores can be null (not assessable)
# ---------------------------------------------------------------------------


class ScoredCriterion(BaseModel):
    score: int | None = Field(default=None, description="1-10, or null if not assessable")
    rationale: str = Field(default="", description="1 sentence justification")


class AgentScores(BaseModel):
    tool_efficiency: ScoredCriterion = Field(default_factory=ScoredCriterion)
    reasoning_verbosity: ScoredCriterion = Field(default_factory=ScoredCriterion)
    thinking_depth: ScoredCriterion = Field(default_factory=ScoredCriterion)
    error_recovery: ScoredCriterion = Field(default_factory=ScoredCriterion)
    context_utilization: ScoredCriterion = Field(default_factory=ScoredCriterion)
    file_operation_accuracy: ScoredCriterion = Field(default_factory=ScoredCriterion)
    retry_strategy: ScoredCriterion = Field(default_factory=ScoredCriterion)
    output_formatting: ScoredCriterion = Field(default_factory=ScoredCriterion)
    task_decomposition: ScoredCriterion = Field(default_factory=ScoredCriterion)
    dependency_management: ScoredCriterion = Field(default_factory=ScoredCriterion)
    test_awareness: ScoredCriterion = Field(default_factory=ScoredCriterion)
    code_generation_quality: ScoredCriterion = Field(default_factory=ScoredCriterion)
    prompt_interpretation: ScoredCriterion = Field(default_factory=ScoredCriterion)
    execution_speed: ScoredCriterion = Field(default_factory=ScoredCriterion)
    side_effect_awareness: ScoredCriterion = Field(default_factory=ScoredCriterion)
    idempotency: ScoredCriterion = Field(default_factory=ScoredCriterion)
    progress_communication: ScoredCriterion = Field(default_factory=ScoredCriterion)
    resource_efficiency: ScoredCriterion = Field(default_factory=ScoredCriterion)
    graceful_degradation: ScoredCriterion = Field(default_factory=ScoredCriterion)
    final_state_correctness: ScoredCriterion = Field(default_factory=ScoredCriterion)


class ModelScores(BaseModel):
    reasoning_correctness: ScoredCriterion = Field(default_factory=ScoredCriterion)
    tool_call_formation: ScoredCriterion = Field(default_factory=ScoredCriterion)
    code_correctness: ScoredCriterion = Field(default_factory=ScoredCriterion)
    instruction_following: ScoredCriterion = Field(default_factory=ScoredCriterion)
    hallucination_resistance: ScoredCriterion = Field(default_factory=ScoredCriterion)
    type_awareness: ScoredCriterion = Field(default_factory=ScoredCriterion)
    error_diagnosis: ScoredCriterion = Field(default_factory=ScoredCriterion)
    solution_completeness: ScoredCriterion = Field(default_factory=ScoredCriterion)
    code_style_consistency: ScoredCriterion = Field(default_factory=ScoredCriterion)
    api_knowledge_accuracy: ScoredCriterion = Field(default_factory=ScoredCriterion)
    edge_case_handling: ScoredCriterion = Field(default_factory=ScoredCriterion)
    architecture_understanding: ScoredCriterion = Field(default_factory=ScoredCriterion)
    import_correctness: ScoredCriterion = Field(default_factory=ScoredCriterion)
    test_understanding: ScoredCriterion = Field(default_factory=ScoredCriterion)
    debugging_strategy: ScoredCriterion = Field(default_factory=ScoredCriterion)
    natural_language_clarity: ScoredCriterion = Field(default_factory=ScoredCriterion)
    self_correction_ability: ScoredCriterion = Field(default_factory=ScoredCriterion)
    context_window_usage: ScoredCriterion = Field(default_factory=ScoredCriterion)
    output_structure: ScoredCriterion = Field(default_factory=ScoredCriterion)
    domain_knowledge: ScoredCriterion = Field(default_factory=ScoredCriterion)


class AgentEvaluation(BaseModel):
    scores: AgentScores = Field(default_factory=AgentScores)
    summary: str = ""


class ModelEvaluation(BaseModel):
    scores: ModelScores = Field(default_factory=ModelScores)
    summary: str = ""


class ScenarioScore(BaseModel):
    met: bool = False
    comment: str = ""


class ScenarioEvaluation(BaseModel):
    criteria: dict[str, ScenarioScore] = Field(default_factory=dict)
    total_score: int = 0
    max_score: int = 0


class RunEvaluation(BaseModel):
    agent_scores: AgentScores = Field(default_factory=AgentScores)
    agent_summary: str = ""
    model_scores: ModelScores = Field(default_factory=ModelScores)
    model_summary: str = ""
    task_scores: dict[str, ScenarioEvaluation] = Field(default_factory=dict)


class OverallSummary(BaseModel):
    summary: str = ""


class AnalysisResult(BaseModel):
    agents: dict[str, AgentEvaluation] = Field(default_factory=dict)
    models: dict[str, ModelEvaluation] = Field(default_factory=dict)
    task_scores: dict[str, dict[str, ScenarioEvaluation]] = Field(default_factory=dict)
    overall_summary: str = ""


# ---------------------------------------------------------------------------
# Data collection
# ---------------------------------------------------------------------------


def _read_scenario_meta(scenario_id: str) -> dict:
    tpl = TEMPLATE_DIR / scenario_id
    meta: dict = {"task": "", "scoring": []}
    task_file = tpl / "task.txt"
    if task_file.is_file():
        meta["task"] = task_file.read_text(encoding="utf-8").strip()
    scoring_file = tpl / "scoring.csv"
    if scoring_file.is_file():
        with scoring_file.open(encoding="utf-8") as f:
            for row in csv.DictReader(f):
                meta["scoring"].append(
                    {
                        "criterion": row.get("criterion", ""),
                        "score": int(row.get("score", "1")),
                    }
                )
    return meta


def _collect_run_data(run_dir: Path) -> dict | None:
    """Collect data for a single run directory."""
    from .run import unmake_model_safe

    run_name = run_dir.name
    parts = run_name.split("_", 1)
    agent_name = parts[0] if parts else run_name
    model_name = unmake_model_safe(parts[1]) if len(parts) > 1 else ""

    scenarios = _collect_run(run_dir, read_logs=True)
    if not scenarios:
        return None

    scenario_meta: dict[str, dict] = {}
    scenario_data = []
    for sid, info in sorted(scenarios.items()):
        if sid not in scenario_meta:
            scenario_meta[sid] = _read_scenario_meta(sid)
        meta = scenario_meta[sid]

        steps_summary = []
        for step in info.get("steps", []):
            output = step.get("output", "")
            if len(output) > LOG_TRUNCATE:
                output = output[:LOG_TRUNCATE] + f"\n... [truncated, {len(output)} chars total]"
            steps_summary.append(
                {
                    "name": step.get("name", ""),
                    "status": step.get("status", ""),
                    "elapsed": step.get("elapsed"),
                    "output": output,
                }
            )
        scenario_data.append(
            {
                "scenario_id": sid,
                "status": info["status"],
                "total_time": info["total_time"],
                "steps": steps_summary,
                "task": meta["task"],
                "scoring": meta["scoring"],
            }
        )

    return {
        "run_name": run_name,
        "agent": agent_name,
        "model": model_name,
        "scenarios": scenario_data,
    }


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = (
    "You are an expert evaluating LLM-powered coding agents. "
    "You analyze agent logs to assess both the agent (CLI tool quality) "
    "and the underlying model (LLM reasoning quality) separately.\n\n"
    "Score each criterion from 1 (worst) to 10 (best). "
    "Use null ONLY when the criterion is fundamentally inapplicable "
    "(e.g. error_recovery when there were zero errors, retry_strategy when no retries occurred). "
    "If the log is minimal but the task was completed successfully, infer scores from the outcome — "
    "a passing test suite implies good code quality, correct imports, etc.\n\n"
    "Be critical and differentiate — avoid giving all the same scores. "
    "Base scores on evidence: test results, timing, code output, error patterns.\n\n"
    "IMPORTANT: You MUST respond with ONLY a valid JSON object. "
    "No markdown, no explanations, no text outside the JSON."
)


def _build_criteria_text(criteria: list[tuple[str, str, str]], label: str) -> str:
    lines = [f"\n### {label} (score 1-10 each, null only if criterion is inapplicable):"]
    for key, name, desc in criteria:
        lines.append(f"- **{key}**: {name} — {desc}")
    return "\n".join(lines)


def _build_run_messages(run: dict) -> list[dict]:
    lines = [f"# Run: {run['run_name']}"]
    lines.append(f"Agent: {run['agent']}, Model: {run['model']}")
    for sc in run["scenarios"]:
        lines.append(f"\n## Scenario: {sc['scenario_id']} [{sc['status']}] ({sc['total_time']}s)")
        if sc.get("task"):
            lines.append(f"\n**Task:** {sc['task']}")
        if sc.get("scoring"):
            lines.append("\n**Scoring criteria (criterion -> max points):**")
            lines.extend(f"- {item['criterion']} ({item['score']} pts)" for item in sc["scoring"])
        for step in sc["steps"]:
            elapsed = f" ({step['elapsed']}s)" if step.get("elapsed") else ""
            lines.append(f"\n### {step['name']} [{step['status']}]{elapsed}")
            if step["output"]:
                lines.append(f"```\n{step['output']}\n```")

    # Build task_scores example
    task_example = {}
    for sc in run["scenarios"]:
        if sc.get("scoring"):
            task_example[sc["scenario_id"]] = {
                "criteria": {
                    item["criterion"]: {"met": True, "comment": "why"} for item in sc["scoring"]
                },
                "total_score": "sum of met",
                "max_score": sum(item["score"] for item in sc["scoring"]),
            }

    score_ex = {"score": "1-10 or null", "rationale": "why"}
    example = json.dumps(
        {
            "agent_scores": {c[0]: score_ex for c in AGENT_CRITERIA},
            "agent_summary": "2-3 sentences",
            "model_scores": {c[0]: score_ex for c in MODEL_CRITERIA},
            "model_summary": "2-3 sentences",
            "task_scores": task_example,
        },
        indent=2,
    )

    user = (
        "\n".join(lines)
        + "\n\n---\n\n# Evaluation Criteria\n"
        + _build_criteria_text(AGENT_CRITERIA, "Agent criteria")
        + "\n"
        + _build_criteria_text(MODEL_CRITERIA, "Model criteria")
        + f"\n\n# Required JSON format\n\nRespond with EXACTLY this structure:\n```json\n{example}\n```"
    )
    return [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ]


def _build_summary_messages(evals: dict[str, RunEvaluation]) -> list[dict]:
    lines = ["# Evaluation Results\n"]
    for run_name, ev in sorted(evals.items()):
        a_scores = [getattr(ev.agent_scores, c[0]).score for c in AGENT_CRITERIA]
        a_valid = [s for s in a_scores if s is not None]
        m_scores = [getattr(ev.model_scores, c[0]).score for c in MODEL_CRITERIA]
        m_valid = [s for s in m_scores if s is not None]
        a_avg = sum(a_valid) / len(a_valid) if a_valid else 0
        m_avg = sum(m_valid) / len(m_valid) if m_valid else 0
        lines.append(f"## {run_name}")
        lines.append(
            f"Agent avg: {a_avg:.1f}/10 ({len(a_valid)}/{len(a_scores)} assessed) — {ev.agent_summary}"
        )
        lines.append(
            f"Model avg: {m_avg:.1f}/10 ({len(m_valid)}/{len(m_scores)} assessed) — {ev.model_summary}"
        )
        lines.append("")

    user = (
        "\n".join(lines) + '\nRespond with JSON: {"summary": "3-5 sentence comparative analysis"}'
    )
    return [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ]


# ---------------------------------------------------------------------------
# LLM call — raw litellm only, no instructor (avoids double-call)
# ---------------------------------------------------------------------------


def _make_openai_client(api_key: str = "", base_url: str = ""):
    """Create OpenAI client. Works with any OpenAI-compatible API (ollama, etc).

    When api_key is empty, the SDK reads OPENAI_API_KEY from env.
    For local servers (ollama etc) that ignore auth, pass api_key="unused".
    """
    from openai import OpenAI

    kwargs = {}
    if api_key:
        kwargs["api_key"] = api_key
    # else: SDK reads OPENAI_API_KEY from env automatically
    if base_url:
        kwargs["base_url"] = base_url
        # Local servers (ollama, vllm) don't need a real key,
        # but the SDK requires one when no env var is set either
        if not api_key:
            import os

            if not os.environ.get("OPENAI_API_KEY"):
                kwargs["api_key"] = "unused"
    return OpenAI(**kwargs)


def _raw_completion(
    client,
    model: str,
    messages: list[dict],
) -> str:
    """Call OpenAI-compatible API and extract text content."""
    response = client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=0.3,
    )
    choice = response.choices[0].message

    if choice.content:
        return choice.content

    log.error(f"Empty LLM response: {response}")
    raise ValueError("LLM returned empty content")


def _parse_json_from_text(raw: str, response_model: type):
    """Extract and validate JSON from LLM text response."""
    text = raw.strip()

    # Try 1: direct JSON
    if text.startswith("{"):
        try:
            return response_model.model_validate_json(text)
        except Exception:
            pass

    # Try 2: markdown fence
    fence = re.search(r"```(?:json)?\s*\n?(.*?)```", text, re.DOTALL)
    if fence:
        try:
            return response_model.model_validate_json(fence.group(1).strip())
        except Exception:
            pass

    # Try 3: first { to last }
    first = text.find("{")
    last = text.rfind("}")
    if first != -1 and last > first:
        try:
            return response_model.model_validate_json(text[first : last + 1])
        except Exception:
            pass

    raise ValueError(f"Cannot extract JSON ({len(raw)} chars). Start: {raw[:100]!r}")


def _call_llm(
    client,
    model: str,
    messages: list[dict],
    response_model: type,
    max_attempts: int = 3,
    backoff: float = 2.0,
):
    """Call LLM with retry + backoff. Returns validated Pydantic model."""
    last_exc = None
    for attempt in range(1, max_attempts + 1):
        try:
            raw = _raw_completion(client, model, messages)
            log.debug(f"Response ({len(raw)} chars): {raw[:300]}")
            return _parse_json_from_text(raw, response_model)
        except Exception as e:
            last_exc = e
            err = str(e).lower()
            if any(k in err for k in ("rate", "429", "throttl", "quota")):
                wait = backoff**attempt
                log.warning(f"Rate limited, waiting {wait:.0f}s (attempt {attempt}/{max_attempts})")
                _time.sleep(wait)
            elif attempt < max_attempts:
                log.warning(f"Attempt {attempt} failed: {e}")
                _time.sleep(1)
            else:
                raise
    raise last_exc or RuntimeError("All attempts exhausted")


# ---------------------------------------------------------------------------
# HTML generation
# ---------------------------------------------------------------------------


def _score_color(score: int | None) -> str:
    if score is None:
        return "var(--muted)"
    if score >= 8:
        return "var(--ok)"
    if score >= 5:
        return "var(--warn)"
    return "var(--fail)"


def _score_bg(score: int | None) -> str:
    if score is None:
        return "transparent"
    if score >= 8:
        return "rgba(63,185,80,.15)"
    if score >= 5:
        return "rgba(210,153,34,.15)"
    return "rgba(248,81,73,.15)"


def _build_eval_table(
    names: list[str],
    criteria: list[tuple[str, str, str]],
    get_scored: Callable,
) -> str:
    """Build HTML table. get_scored(name, key) -> ScoredCriterion."""
    header = (
        "<tr><th>Criterion</th>"
        + "".join(f"<th>{escape_html(n)}</th>" for n in names)
        + "<th>Avg</th></tr>"
    )

    rows = []
    name_scores: dict[str, list[int]] = {n: [] for n in names}

    for key, name, desc in criteria:
        cells = [f'<td title="{escape_html(desc)}">{escape_html(name)}</td>']
        row_valid = []
        for n in names:
            sc = get_scored(n, key)
            s = sc.score
            color = _score_color(s)
            bg = _score_bg(s)
            tooltip = escape_html(sc.rationale) if sc.rationale else ""
            display = str(s) if s is not None else "—"
            cells.append(
                f'<td class="score-cell" style="color:{color};background:{bg}" '
                f'data-tip="{tooltip}">{display}</td>'
            )
            if s is not None:
                row_valid.append(s)
                name_scores[n].append(s)
        # Row average (only assessed)
        if row_valid:
            avg = sum(row_valid) / len(row_valid)
            color = _score_color(round(avg))
            cells.append(f'<td class="score-cell" style="color:{color}">{avg:.1f}</td>')
        else:
            cells.append('<td class="score-cell" style="color:var(--muted)">—</td>')
        rows.append("<tr>" + "".join(cells) + "</tr>")

    # Summary row: avg + confidence per name
    summary_cells = ['<td style="font-weight:700">Average</td>']
    all_avgs = []
    for n in names:
        scores = name_scores[n]
        total_criteria = len(criteria)
        assessed = len(scores)
        confidence = assessed / total_criteria if total_criteria else 0
        if scores:
            avg = sum(scores) / len(scores)
            all_avgs.append(avg)
            color = _score_color(round(avg))
            conf_pct = f"{confidence * 100:.0f}%"
            summary_cells.append(
                f'<td class="score-cell" style="color:{color};border-top:2px solid var(--border)">'
                f'{avg:.1f} <small style="color:var(--muted)">({conf_pct})</small></td>'
            )
        else:
            summary_cells.append(
                '<td class="score-cell" style="color:var(--muted);border-top:2px solid var(--border)">—</td>'
            )
    if all_avgs:
        total_avg = sum(all_avgs) / len(all_avgs)
        color = _score_color(round(total_avg))
        summary_cells.append(
            f'<td class="score-cell" style="color:{color};border-top:2px solid var(--border)">'
            f"{total_avg:.1f}</td>"
        )
    else:
        summary_cells.append(
            '<td class="score-cell" style="border-top:2px solid var(--border)">—</td>'
        )
    rows.append("<tr>" + "".join(summary_cells) + "</tr>")

    return (
        f'<div class="table-wrap"><table><thead>{header}</thead>'
        f"<tbody>{''.join(rows)}</tbody></table></div>"
    )


def _build_task_table(task_scores: dict[str, dict[str, ScenarioEvaluation]]) -> str:
    all_scenarios = sorted({sid for ts in task_scores.values() for sid in ts})
    run_names = sorted(task_scores.keys())
    if not all_scenarios or not run_names:
        return ""

    header = (
        "<tr><th>Agent / Model</th>"
        + "".join(f"<th>{escape_html(s)}</th>" for s in all_scenarios)
        + "<th>Total</th></tr>"
    )

    rows = []
    for rn in run_names:
        cells = [f'<td class="run-name">{escape_html(rn)}</td>']
        total_got, total_max = 0, 0
        for sid in all_scenarios:
            ev = task_scores.get(rn, {}).get(sid)
            if ev is None:
                cells.append('<td class="cell empty">&mdash;</td>')
                continue
            total_got += ev.total_score
            total_max += ev.max_score
            pct = (ev.total_score / ev.max_score * 100) if ev.max_score else 0
            color = "var(--ok)" if pct >= 80 else "var(--warn)" if pct >= 50 else "var(--fail)"
            tips = []
            for cname, cs in ev.criteria.items():
                icon = "+" if cs.met else "-"
                tips.append(f"{icon} {cname}: {cs.comment}")
            tooltip = escape_html("\n".join(tips))
            cells.append(
                f'<td class="score-cell" style="color:{color}" '
                f'data-tip="{tooltip}">{ev.total_score}/{ev.max_score}</td>'
            )
        if total_max:
            pct = total_got / total_max * 100
            color = "var(--ok)" if pct >= 80 else "var(--warn)" if pct >= 50 else "var(--fail)"
            cells.append(
                f'<td class="score-cell" style="color:{color};border-left:2px solid var(--border)">'
                f"{total_got}/{total_max} ({pct:.0f}%)</td>"
            )
        else:
            cells.append('<td class="cell empty">&mdash;</td>')
        rows.append("<tr>" + "".join(cells) + "</tr>")

    return (
        f'<div class="table-wrap"><table><thead>{header}</thead>'
        f"<tbody>{''.join(rows)}</tbody></table></div>"
    )


def _build_analysis_html(result: AnalysisResult, session_name: str) -> str:
    generated = datetime.now().isoformat(sep=" ", timespec="seconds")
    sections = []

    if result.agents:
        agent_names = sorted(result.agents.keys())
        table = _build_eval_table(
            agent_names,
            AGENT_CRITERIA,
            lambda name, key: getattr(result.agents[name].scores, key),
        )
        summaries = "".join(
            f"<p><strong>{escape_html(a)}:</strong> {escape_html(result.agents[a].summary)}</p>"
            for a in agent_names
            if result.agents[a].summary
        )
        sections.append(
            f'<h2>Agent Evaluation</h2>{table}<div style="margin-top:1rem">{summaries}</div>'
        )

    if result.models:
        model_names = sorted(result.models.keys())
        table = _build_eval_table(
            model_names,
            MODEL_CRITERIA,
            lambda name, key: getattr(result.models[name].scores, key),
        )
        summaries = "".join(
            f"<p><strong>{escape_html(m)}:</strong> {escape_html(result.models[m].summary)}</p>"
            for m in model_names
            if result.models[m].summary
        )
        sections.append(
            f'<h2>Model Evaluation</h2>{table}<div style="margin-top:1rem">{summaries}</div>'
        )

    if result.task_scores:
        task_html = _build_task_table(result.task_scores)
        if task_html:
            sections.append(f"<h2>Task Completion</h2>{task_html}")

    if result.overall_summary:
        sections.append(
            f"<h2>Overall Summary</h2>"
            f'<div class="detail-panel"><p>{escape_html(result.overall_summary)}</p></div>'
        )

    extra_css = """
    .score-cell { text-align: center; font-weight: 600; cursor: help; position: relative; }
    .score-cell[data-tip]:hover::after {
        content: attr(data-tip);
        position: absolute; left: 50%; top: 100%;
        transform: translateX(-50%); z-index: 10;
        background: var(--surface); border: 1px solid var(--border);
        border-radius: 6px; padding: .4rem .6rem;
        font-size: .8rem; font-weight: 400; color: var(--text);
        white-space: pre-line; width: max-content; max-width: 300px;
        box-shadow: 0 4px 12px rgba(0,0,0,.4);
        pointer-events: none;
    }
    table td, table th { white-space: nowrap; }
    table td:first-child { white-space: normal; min-width: 200px; }
    """

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Analysis: {escape_html(session_name)}</title>
<style>{_CSS}{extra_css}</style>
</head>
<body>
<h1>LLM Analysis: {escape_html(session_name)}</h1>
<p class="meta">Generated: {generated} &middot;
<a href="report.html">Summary report</a></p>
{"".join(sections)}
</body></html>"""


# ---------------------------------------------------------------------------
# Aggregation helpers
# ---------------------------------------------------------------------------


def _average_scored(items: list[ScoredCriterion]) -> ScoredCriterion:
    valid = [s for s in items if s.score is not None]
    if not valid:
        return ScoredCriterion(score=None, rationale="No data")
    avg = round(sum(s.score for s in valid if s.score is not None) / len(valid))
    best = min(valid, key=lambda s: abs((s.score or 0) - avg))
    return ScoredCriterion(score=avg, rationale=best.rationale)


def _aggregate_evaluations(
    runs: list[dict],
    run_evals: dict[str, RunEvaluation],
    group_key: str,
    scores_attr: str,
    summary_attr: str,
    scores_cls: type,
    eval_cls: type,
    criteria: list,
) -> dict:
    from collections import defaultdict

    groups: dict[str, list[RunEvaluation]] = defaultdict(list)
    for run in runs:
        key = run[group_key]
        if key and run["run_name"] in run_evals:
            groups[key].append(run_evals[run["run_name"]])

    result = {}
    for key, evals in groups.items():
        if len(evals) == 1:
            ev = evals[0]
            result[key] = eval_cls(
                scores=getattr(ev, scores_attr),
                summary=getattr(ev, summary_attr),
            )
        else:
            averaged = {}
            for crit_key, _, _ in criteria:
                items = [getattr(getattr(ev, scores_attr), crit_key) for ev in evals]
                averaged[crit_key] = _average_scored(items)
            result[key] = eval_cls(
                scores=scores_cls(**averaged),
                summary=" | ".join(getattr(ev, summary_attr) for ev in evals),
            )
    return result


# ---------------------------------------------------------------------------
# Incremental API: evaluate single run, cache result
# ---------------------------------------------------------------------------


def evaluate_run(
    run_dir: Path,
    model: str,
    api_key: str = "",
    base_url: str = "",
) -> RunEvaluation | None:
    """Evaluate a single run and cache result in <run_dir>/evaluation.json.

    Returns cached result if already exists. Call from _exec_task completion.
    """
    cache_file = run_dir / "evaluation.json"
    if cache_file.is_file():
        try:
            return RunEvaluation.model_validate_json(cache_file.read_text(encoding="utf-8"))
        except Exception:
            pass  # re-evaluate

    run_data = _collect_run_data(run_dir)
    if not run_data:
        return None

    client = _make_openai_client(api_key, base_url)
    messages = _build_run_messages(run_data)
    log.info(f"Evaluating {run_dir.name} ({sum(len(m['content']) for m in messages)} prompt chars)")

    ev = _call_llm(client, model, messages, RunEvaluation)
    cache_file.write_text(ev.model_dump_json(indent=2), encoding="utf-8")
    log.info(f"Cached evaluation: {cache_file}")
    return ev


# ---------------------------------------------------------------------------
# Report assembly (uses cached evaluations)
# ---------------------------------------------------------------------------


def assemble_report(
    session_dir: Path,
    model: str = "",
    api_key: str = "",
    base_url: str = "",
    on_progress: Callable[[str], None] | None = None,
) -> Path | None:
    """Assemble final analysis.html from cached per-run evaluations.

    If evaluations are missing, calls LLM for them.
    """
    _setup_file_logging(session_dir)

    def _progress(msg: str) -> None:
        log.info(msg)
        if on_progress:
            on_progress(msg)

    try:
        runs = []
        run_evals: dict[str, RunEvaluation] = {}

        for run_dir in sorted(session_dir.iterdir()):
            if not run_dir.is_dir() or run_dir.name.startswith(".") or run_dir.name == "reports":
                continue
            run_data = _collect_run_data(run_dir)
            if not run_data:
                continue
            runs.append(run_data)

            # Try cache first
            cache_file = run_dir / "evaluation.json"
            if cache_file.is_file():
                try:
                    ev = RunEvaluation.model_validate_json(cache_file.read_text(encoding="utf-8"))
                    run_evals[run_data["run_name"]] = ev
                    _progress(f"Cached: {run_data['run_name']}")
                    continue
                except Exception:
                    pass

            # No cache — evaluate now
            if not model:
                _progress(f"Skipped (no model): {run_data['run_name']}")
                continue
            _progress(f"Evaluating: {run_data['run_name']}...")
            ev = evaluate_run(run_dir, model, api_key, base_url)
            if ev:
                run_evals[run_data["run_name"]] = ev

        if not run_evals:
            _progress("No evaluations available")
            return None

        # Summary (only if multiple runs and model configured)
        overall_summary = ""
        if len(run_evals) > 1 and model:
            _progress("Generating summary...")
            client = _make_openai_client(api_key, base_url)
            msgs = _build_summary_messages(run_evals)
            try:
                summary = _call_llm(client, model, msgs, OverallSummary)
                overall_summary = summary.summary
            except Exception as e:
                log.warning(f"Summary generation failed: {e}")
                overall_summary = ""
        elif len(run_evals) == 1:
            ev = next(iter(run_evals.values()))
            overall_summary = f"Agent: {ev.agent_summary} Model: {ev.model_summary}"

        # Aggregate
        agents = _aggregate_evaluations(
            runs,
            run_evals,
            "agent",
            "agent_scores",
            "agent_summary",
            AgentScores,
            AgentEvaluation,
            AGENT_CRITERIA,
        )
        models = _aggregate_evaluations(
            runs,
            run_evals,
            "model",
            "model_scores",
            "model_summary",
            ModelScores,
            ModelEvaluation,
            MODEL_CRITERIA,
        )
        task_scores = {
            r["run_name"]: run_evals[r["run_name"]].task_scores
            for r in runs
            if r["run_name"] in run_evals and run_evals[r["run_name"]].task_scores
        }

        result = AnalysisResult(
            agents=agents,
            models=models,
            task_scores=task_scores,
            overall_summary=overall_summary,
        )

        _progress("Writing HTML...")
        html = _build_analysis_html(result, session_name=session_dir.name)
        out_path = session_dir / "analysis.html"
        out_path.write_text(html, encoding="utf-8")

        raw_path = session_dir / "analysis.json"
        raw_path.write_text(result.model_dump_json(indent=2), encoding="utf-8")

        _progress("Done")
        return out_path

    except Exception:
        log.error(f"Assembly failed:\n{traceback.format_exc()}")
        raise


def _setup_file_logging(session_dir: Path) -> None:
    log_path = session_dir / "analysis.log"
    # Avoid duplicate handlers
    for h in log.handlers[:]:
        if isinstance(h, logging.FileHandler):
            log.removeHandler(h)
    handler = logging.FileHandler(log_path, mode="a", encoding="utf-8")
    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s %(levelname)s %(message)s",
            datefmt="%H:%M:%S",
        )
    )
    log.addHandler(handler)
    log.setLevel(logging.DEBUG)


# ---------------------------------------------------------------------------
# Legacy API (kept for backward compat with app.py)
# ---------------------------------------------------------------------------


def generate_analysis(
    session_dir: Path,
    model: str,
    api_key: str = "",
    base_url: str = "",
    on_progress: Callable[[str], None] | None = None,
) -> Path | None:
    """Full analysis: evaluate all runs + assemble report."""
    return assemble_report(
        session_dir,
        model=model,
        api_key=api_key,
        base_url=base_url,
        on_progress=on_progress,
    )
