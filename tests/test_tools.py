"""Registry sanity — the portability contract another MCP host relies on."""

from eil.tools import REGISTRY, call_tool


def test_registry_exposes_the_five_tools():
    assert sorted(REGISTRY) == ["expand", "fetch_logs", "get_doc", "search_code", "search_docs"]


def test_specs_are_discovery_ready():
    for spec in REGISTRY.values():
        assert spec.description and len(spec.description) > 30
        assert spec.parameters["type"] == "object"
        for required in spec.parameters["required"]:
            assert required in spec.parameters["properties"]


def test_unknown_tool_returns_error_and_catalog():
    result = call_tool("nope", {})
    assert "unknown tool" in result["error"]
    assert "search_docs" in result["tools"]


def test_env_gated_tools_fail_closed_without_db(monkeypatch):
    for var in ("EIL_BITBUCKET_URL", "EIL_BITBUCKET_TOKEN", "EIL_ELK_URL", "EIL_ELK_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    # env check happens before any DB connection — works with no Postgres at all
    assert "not configured" in call_tool("search_code", {"query": "x"})["error"]
    assert "not configured" in call_tool("fetch_logs", {"query": "x"})["error"]
