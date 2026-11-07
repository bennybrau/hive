#!/usr/bin/env python3
"""Print the M5 experiment's comparison from a results directory written by run.sh.

    python3 scripts/experiment/report.py DIR [--since TIMESTAMP] [--questions FILE]

Per question and per `where` group: runs, mean tokens (input incl. cache / output), mean cost and accuracy for each
arm. `manual` (1/0, y/n), when filled in, overrides the judge's `correct`. Totals: savings per question (mean off
cost - mean on cost), the Hive's spend (DIR/llm_calls.csv, or with --since every llm_calls row since that time,
e.g. to include the backfill), and net = savings x questions - Hive spend, where questions = the on-arm runs (the
questions the Hive actually answered, whose sessions it distilled). --since reads Postgres via `docker compose`.
"""
import argparse
import csv
import io
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ARMS = ("off", "on")
TRUE, FALSE = {"1", "y", "yes", "true"}, {"0", "n", "no", "false"}


def flag(v):
    v = (v or "").strip().lower()
    return True if v in TRUE else False if v in FALSE else None


def is_correct(row):
    """The manual verdict when there is one, else the judge's."""
    m = flag(row.get("manual"))
    return m if m is not None else bool(flag(row.get("correct")))


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def tokens_in(row):
    return num(row["input_tokens"]) + num(row.get("cache_read_tokens")) + num(row.get("cache_write_tokens"))


def stats(rows):
    """Per-arm means over a set of runs: {arm: {n, in, out, cost, acc}} (arms with no runs are absent)."""
    out = {}
    for arm in ARMS:
        rs = [r for r in rows if r["arm"] == arm]
        if rs:
            n = len(rs)
            out[arm] = {
                "n": n,
                "in": sum(tokens_in(r) for r in rs) / n,
                "out": sum(num(r["output_tokens"]) for r in rs) / n,
                "cost": sum(num(r["est_cost_usd"]) for r in rs) / n,
                "acc": sum(is_correct(r) for r in rs) / n,
            }
    return out


def hive_spend(llm_rows):
    return sum(num(r["est_cost_usd"]) for r in llm_rows)


def totals(rows, llm_rows):
    s = stats(rows)
    savings = s["off"]["cost"] - s["on"]["cost"] if "off" in s and "on" in s else 0.0
    questions = s.get("on", {}).get("n", 0)
    spend = hive_spend(llm_rows)
    return {"arms": s, "savings": savings, "questions": questions, "spend": spend, "net": savings * questions - spend}


def read_csv(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def llm_calls_since(since):
    lit = "'" + since.replace("'", "''") + "'"
    sql = f"copy (select * from llm_calls where created_at >= {lit} order by created_at) to stdout with csv header"
    out = subprocess.run(
        ["docker", "compose", "exec", "-T", "postgres", "psql", "-U", "hive", "-d", "hive", "-v", "ON_ERROR_STOP=1", "-qc", sql],
        cwd=os.path.dirname(os.path.dirname(HERE)), check=True, capture_output=True, text=True,
    ).stdout
    return list(csv.DictReader(io.StringIO(out)))


def line(label, s):
    cells = []
    for arm in ARMS:
        a = s.get(arm)
        cells.append(f"{a['n']:>2} {a['in']:>9.0f} {a['out']:>6.0f} ${a['cost']:>7.4f} {a['acc']:>4.0%}" if a else f"{'-':>35}")
    d = f"${s['off']['cost'] - s['on']['cost']:>8.4f}" if "off" in s and "on" in s else ""
    return f"{label:<16} {cells[0]}  | {cells[1]}  | {d}"


def report(rows, llm_rows, questions, spend_label, out=sys.stdout):
    order = {q["id"]: i for i, q in enumerate(questions)}
    where = {q["id"]: q["where"] for q in questions}
    head = f"{'n':>2} {'tokens in':>9} {'out':>6} {'cost':>8} {'acc':>4}"
    print(f"{'':<16} {'off':<{len(head)}}  | {'on':<{len(head)}}  | saved/q", file=out)
    print(f"{'':<16} {head}  | {head}  |", file=out)
    print("per question", file=out)
    for qid in sorted({r["question"] for r in rows}, key=lambda q: (order.get(q, len(order)), q)):
        print(line(qid, stats([r for r in rows if r["question"] == qid])), file=out)
    print("per where", file=out)
    for w in sorted({where.get(r["question"], "?") for r in rows}):
        print(line(w, stats([r for r in rows if where.get(r["question"], "?") == w])), file=out)
    t = totals(rows, llm_rows)
    print(line("all", t["arms"]), file=out)
    print(f"\nsavings/question   ${t['savings']:.4f}", file=out)
    print(f"questions          {t['questions']} (on-arm runs)", file=out)
    print(f"hive spend         ${t['spend']:.4f} ({len(llm_rows)} llm_calls, {spend_label})", file=out)
    print(f"net                ${t['net']:.4f} = savings x questions - hive spend", file=out)
    return t


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("dir")
    p.add_argument("--since", help="count every llm_calls row since this time (psql) instead of DIR/llm_calls.csv")
    p.add_argument("--questions", default=os.path.join(HERE, "questions.json"))
    a = p.parse_args(argv)
    rows = read_csv(os.path.join(a.dir, "results.csv"))
    with open(a.questions) as f:
        questions = json.load(f)["questions"]
    if a.since:
        llm_rows, label = llm_calls_since(a.since), f"since {a.since}"
    else:
        llm_rows, label = read_csv(os.path.join(a.dir, "llm_calls.csv")), "the run window"
    report(rows, llm_rows, questions, label)


if __name__ == "__main__":
    main()
