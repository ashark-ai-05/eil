from eil.router import Route, classify


def test_ticket_key_routes_to_entity():
    d = classify("what is the status of PAY-981?")
    assert d.route == Route.ENTITY
    assert d.match == "PAY-981"


def test_path_routes_to_code():
    d = classify("where is src/retry/scheduler.py used")
    assert d.route == Route.PATH
    assert d.match == "src/retry/scheduler.py"


def test_quoted_phrase_is_exact():
    assert classify('find "idempotency key is required"').route == Route.EXACT


def test_error_string_is_exact():
    d = classify("seeing NullPointerException in retry handler")
    assert d.route == Route.EXACT
    assert d.match == "NullPointerException"


def test_identifier_is_symbol():
    assert classify("handleRetry").route == Route.SYMBOL
    assert classify("parked_payment_alert").route == Route.SYMBOL


def test_natural_language_falls_through_to_docs():
    assert classify("how do payment retries work").route == Route.DOCS
    assert classify("retry").route == Route.DOCS  # plain lowercase word: not identifier-shaped
