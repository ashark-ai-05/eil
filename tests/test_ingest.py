import json
from pathlib import Path

from eil.ingest.confluence import normalize as normalize_page
from eil.ingest.jira import normalize as normalize_issue

FIXTURES = Path(__file__).parent / "fixtures"


def test_confluence_normalize_extracts_links_and_breadcrumb():
    doc = normalize_page(json.loads((FIXTURES / "confluence_page.json").read_text()))
    assert doc.id == "confluence:page:12345"
    assert doc.hierarchy == ["Payments Space", "Runbooks"]
    assert "jira:issue:PAY-981" in doc.links
    assert "obsidian:note:payments/parked-payments-runbook" in doc.links


def test_jira_normalize_builds_body_and_links():
    doc = normalize_issue(json.loads((FIXTURES / "jira_issue.json").read_text()))
    assert doc.id == "jira:issue:PAY-981"
    assert doc.title.startswith("PAY-981:")
    assert "## Comment — krunal" in doc.body
    assert "jira:issue:PAY-990" in doc.links
    assert "jira:issue:PAY-981" not in doc.links  # never self-links


def test_hash_gate_is_content_addressed():
    raw = json.loads((FIXTURES / "confluence_page.json").read_text())
    assert normalize_page(raw).content_hash == normalize_page(raw).content_hash
    raw["body"] += " edited"
    assert normalize_page(raw).content_hash != normalize_page(json.loads((FIXTURES / "confluence_page.json").read_text())).content_hash
