from eil.connectors.htmlmd import html_to_markdown


def test_headings_and_paragraphs():
    md = html_to_markdown("<h2>Retry schedule</h2><p>Backoff starts at <b>30s</b>.</p>")
    assert "## Retry schedule" in md
    assert "Backoff starts at **30s**." in md


def test_lists_nested_and_ordered():
    md = html_to_markdown("<ol><li>first</li><li>second</li></ol><ul><li>bullet</li></ul>")
    assert "1. first" in md
    assert "2. second" in md
    assert "- bullet" in md


def test_code_and_pre_preserved():
    md = html_to_markdown("<p>use <code>retry_key</code></p><pre>def f():\n    pass</pre>")
    assert "`retry_key`" in md
    assert "```\ndef f():\n    pass\n```" in md


def test_links_and_table_rows():
    md = html_to_markdown('<a href="https://x.example/y">runbook</a>')
    assert "[runbook](https://x.example/y)" in md
    md = html_to_markdown("<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>")
    assert "| a | b |" in md
    assert "| 1 | 2 |" in md


def test_script_dropped_and_whitespace_collapsed():
    md = html_to_markdown("<p>keep</p><script>alert(1)</script><p>this   too</p>")
    assert "alert" not in md
    assert "this too" in md


def test_deterministic():
    html = "<h1>T</h1><p>body <em>x</em></p>"
    assert html_to_markdown(html) == html_to_markdown(html)
