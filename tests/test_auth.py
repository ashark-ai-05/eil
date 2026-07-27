from eil.connectors.auth import make_client


def test_bearer_pat_is_default(monkeypatch):
    monkeypatch.delenv("EIL_JIRA_USER", raising=False)
    client = make_client("JIRA", "https://jira.example.com", "pat-123")
    assert client.headers["Authorization"] == "Bearer pat-123"


def test_basic_auth_when_user_set(monkeypatch):
    monkeypatch.setenv("EIL_JIRA_USER", "krunal")
    client = make_client("JIRA", "https://jira.example.com", "pat-123")
    assert "Authorization" not in client.headers  # httpx applies basic auth per-request
    assert client.auth is not None


def test_env_fallback(monkeypatch):
    monkeypatch.setenv("EIL_BAMBOO_URL", "https://bamboo.example.com/")
    monkeypatch.setenv("EIL_BAMBOO_TOKEN", "t")
    monkeypatch.delenv("EIL_BAMBOO_USER", raising=False)
    client = make_client("BAMBOO")
    assert str(client.base_url) == "https://bamboo.example.com"
