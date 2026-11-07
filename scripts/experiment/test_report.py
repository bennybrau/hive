"""Unit tests for report.py:  python3 -m unittest discover -s scripts/experiment"""
import io
import os
import tempfile
import unittest

import report

RESULTS = """question,arm,run,model,api_calls,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,est_cost_usd,correct,judge_notes,manual,cited_fact_ids
who-1,off,1,m,6,10000,500,20000,0,0.30,1,,,
who-1,off,2,m,5,8000,400,10000,0,0.20,0,missing K2,1,
who-1,on,1,m,2,3000,200,1000,0,0.05,1,,,abcd1234 0badf00d
who-1,on,2,m,2,3000,200,1000,0,0.07,1,,n,
none-1,off,1,m,4,6000,300,0,0,0.10,0,contradicts: invents a policy,,
none-1,on,1,m,1,2000,100,0,0,0.02,1,,,
"""
LLM_CALLS = """id,job,model,input_tokens,output_tokens,cached_tokens,est_cost_usd,duration_ms,episode_id,created_at
a,distill,m,1000,100,0,0.04,1000,,2026-11-07
b,brief,m,500,50,0,0.01,500,,2026-11-07
"""
QUESTIONS = [{"id": "who-1", "where": "code"}, {"id": "none-1", "where": "none"}]


class ReportTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        for name, body in (("results.csv", RESULTS), ("llm_calls.csv", LLM_CALLS)):
            with open(os.path.join(self.dir, name), "w") as f:
                f.write(body)
        self.rows = report.read_csv(os.path.join(self.dir, "results.csv"))
        self.llm = report.read_csv(os.path.join(self.dir, "llm_calls.csv"))

    def test_manual_overrides_correct(self):
        by = {(r["question"], r["arm"], r["run"]): r for r in self.rows}
        self.assertTrue(report.is_correct(by["who-1", "off", "1"]))   # judge 1, no manual
        self.assertTrue(report.is_correct(by["who-1", "off", "2"]))   # judge 0, manual 1
        self.assertFalse(report.is_correct(by["who-1", "on", "2"]))   # judge 1, manual n
        s = report.stats([r for r in self.rows if r["question"] == "who-1"])
        self.assertEqual(s["off"]["acc"], 1.0)
        self.assertEqual(s["on"]["acc"], 0.5)

    def test_net_math(self):
        t = report.totals(self.rows, self.llm)
        self.assertAlmostEqual(t["arms"]["off"]["cost"], 0.60 / 3)
        self.assertAlmostEqual(t["arms"]["on"]["cost"], 0.14 / 3)
        self.assertAlmostEqual(t["savings"], 0.46 / 3)
        self.assertEqual(t["questions"], 3)
        self.assertAlmostEqual(t["spend"], 0.05)
        self.assertAlmostEqual(t["net"], 0.46 - 0.05)

    def test_tokens_include_cache(self):
        s = report.stats([r for r in self.rows if r["question"] == "who-1"])
        self.assertEqual(s["off"]["in"], (30000 + 18000) / 2)

    def test_totals_with_only_one_arm(self):
        """Before the off arm has run, totals() shouldn't crash or claim savings."""
        rows = [r for r in self.rows if r["arm"] != "off"]
        t = report.totals(rows, self.llm)
        self.assertNotIn("off", t["arms"])
        self.assertEqual(t["savings"], 0.0)
        self.assertEqual(t["net"], -t["spend"])

    def test_main_prints_groups_and_totals(self):
        out = io.StringIO()
        report.report(self.rows, self.llm, QUESTIONS, "the run window", out=out)
        text = out.getvalue()
        lines = text.splitlines()
        self.assertLess(text.index("\nwho-1"), text.index("\nnone-1"))  # questions.json order
        self.assertTrue(any(l.startswith("code ") for l in lines))
        self.assertTrue(any(l.startswith("none ") for l in lines))
        self.assertIn("hive spend         $0.0500 (2 llm_calls, the run window)", text)
        self.assertIn("net                $0.4100", text)


if __name__ == "__main__":
    unittest.main()
