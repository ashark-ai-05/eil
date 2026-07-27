"""Connector tests against mocked HTTP — the live APIs are exercised via
httpx.MockTransport so mapping and pagination logic is verified without org
access. The normalizer contract tests (test_ingest.py) cover the rest."""

from __future__ import annotations

import json

import httpx

from eil.connectors.bitbucket import BitbucketSearchClient
from eil.connectors.confluence import ConfluenceClient, cql_ts
from eil.connectors.jira import JiraClient
from eil.ingest.confluence import normalize as normalize_page
from eil.ingest.jira import normalize as normalize_issue


def _mock(client, handler) -> None:
    client.http = httpx.Client(
        base_url=client.base_url, transport=httpx.MockTransport(handler), timeout=5
    )


def test_cql_ts_format():
    assert cql_ts("2026-06-02T14:30:00+00:00") == "2026-06-02 14:30"


def test_confluence_mapping_feeds_normalizer():
    api_page = {
        "id": "777",
        "title": "Parked Payments Runbook",
        "space": {"name": "Payments Space"},
        "ancestors": [{"title": "Runbooks"}],
        "version": {"when": "2026-06-03T10:00:00+00:00", "by": {"displayName": "asha"}},
        "_links": {"webui": "/pages/777"},
        "body": {"storage": {"value": "<h2>Steps</h2><p>Check PAY-981 first.</p>"}},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert 'lastmodified >= "2026-06-01 00:00"' in request.url.params["cql"]
        return httpx.Response(200, json={"results": [api_page], "size": 1})

    client = ConfluenceClient(base_url="https://confluence.example.com", token="pat")
    _mock(client, handler)
    pages = list(client.updated_since("2026-06-01T00:00:00+00:00"))
    assert len(pages) == 1
    doc = normalize_page(pages[0])
    assert doc.id == "confluence:page:777"
    assert doc.hierarchy == ["Payments Space", "Runbooks"]
    assert "## Steps" in doc.body
    assert "jira:issue:PAY-981" in doc.links
    assert doc.url == "https://confluence.example.com/pages/777"


def test_jira_pagination_and_mapping():
    def make_issue(n: int) -> dict:
        return {
            "key": f"PAY-{n}",
            "fields": {
                "summary": f"issue {n}",
                "status": {"name": "Open"},
                "issuetype": {"name": "Bug"},
                "project": {"key": "PAY"},
                "reporter": {"displayName": "krunal"},
                "updated": f"2026-06-0{n}T00:00:00+00:00",
                "description": "d",
                "comment": {"comments": [{"author": {"displayName": "a"}, "body": "c"}]},
            },
        }

    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        start = int(request.url.params["startAt"])
        calls.append(start)
        batch = [make_issue(1)] if start == 0 else [make_issue(2)]
        return httpx.Response(200, json={"issues": batch, "total": 2, "startAt": start})

    client = JiraClient(base_url="https://jira.example.com", token="pat")
    # page size is 50; force two pages by patching module constant via total=2 & len batch 1
    _mock(client, handler)
    issues = list(client.updated_since(None))
    assert [i["key"] for i in issues] == ["PAY-1", "PAY-2"]
    assert calls == [0, 1]
    doc = normalize_issue(issues[0])
    assert doc.id == "jira:issue:PAY-1"
    assert doc.url == "https://jira.example.com/browse/PAY-1"


def test_bitbucket_search_maps_hits_and_enforces_query_limit():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["entities"] == {"code": {}}
        return httpx.Response(
            200,
            json={
                "code": {
                    "count": 1,
                    "values": [
                        {
                            "repository": {"slug": "payments-svc", "project": {"key": "PAY"}},
                            "file": "src/retry/scheduler.py",
                            "hitContexts": [[{"line": 42, "text": "def handle_retry():"}]],
                        }
                    ],
                }
            },
        )

    client = BitbucketSearchClient(base_url="https://bitbucket.example.com", token="pat")
    _mock(client, handler)
    result = client.search_code("handle_retry")
    assert result["count"] == 1
    assert result["results"][0]["repo"] == "PAY/payments-svc"
    assert result["results"][0]["lines"][0]["line"] == 42

    too_long = client.search_code("x" * 300)
    assert "error" in too_long and too_long["results"] == []
