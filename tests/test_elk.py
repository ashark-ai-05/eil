import httpx

from eil.connectors.elk import ElkClient


def test_fetch_logs_builds_query_and_caps_output():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/logs-payments-*/_search"
        import json

        body = json.loads(request.content)
        assert body["query"]["bool"]["must"][0]["query_string"]["query"] == 'RETRY_EXHAUSTED AND service:"retry-scheduler"'
        assert body["query"]["bool"]["filter"][0]["range"]["@timestamp"]["gte"] == "now-30m"
        return httpx.Response(
            200,
            json={
                "hits": {
                    "total": {"value": 2},
                    "hits": [
                        {"_source": {"@timestamp": "2026-07-27T00:00:00Z", "level": "ERROR",
                                     "service": "retry-scheduler", "message": "x" * 1000}},
                        {"_source": {"@timestamp": "2026-07-26T23:59:00Z", "log.level": "WARN",
                                     "message": "parked payment"}},
                    ],
                }
            },
        )

    client = ElkClient(base_url="https://elk.example.com", token="pat")
    client.http = httpx.Client(
        base_url=client.base_url, transport=httpx.MockTransport(handler), timeout=5
    )
    out = client.fetch_logs('RETRY_EXHAUSTED AND service:"retry-scheduler"',
                            index="logs-payments-*", minutes=30)
    assert out["total"] == 2
    assert len(out["results"][0]["message"]) == 400  # context-bomb cap
    assert out["results"][1]["level"] == "WARN"  # log.level fallback


def test_limit_hard_capped():
    def handler(request: httpx.Request) -> httpx.Response:
        import json

        assert json.loads(request.content)["size"] == 50  # MAX_HITS
        return httpx.Response(200, json={"hits": {"total": {"value": 0}, "hits": []}})

    client = ElkClient(base_url="https://elk.example.com", token="pat")
    client.http = httpx.Client(
        base_url=client.base_url, transport=httpx.MockTransport(handler), timeout=5
    )
    client.fetch_logs("q", limit=500)
