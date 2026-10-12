"""Content sanitizer tests: HTML allow-list, Markdown scrubbing, idempotence.

Pure unit tests — no database or network. They pin the artifact security policy
(see ``app/services/content_sanitizer.py`` and the README "Security &
Sanitization" section) so a regression that re-permits active content fails CI.
"""
from __future__ import annotations

import pytest

from app.services.content_sanitizer import (
    sanitize_artifact,
    sanitize_html,
    sanitize_markdown,
)

# --------------------------------------------------------------------------- #
# HTML
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "payload",
    [
        "<script>alert(1)</script>",
        "<iframe src='https://evil.example'></iframe>",
        "<object data='x'></object>",
        "<embed src='x'>",
        "<meta http-equiv='refresh' content='0;url=https://evil'>",
        "<base href='https://evil/'>",
        "<svg onload='alert(1)'></svg>",
    ],
)
def test_html_active_elements_are_removed(payload):
    cleaned = sanitize_html(f"<p>before</p>{payload}<p>after</p>")
    lowered = cleaned.lower()
    for token in ("<script", "<iframe", "<object", "<embed", "<meta", "<base", "<svg", "onload"):
        assert token not in lowered
    assert "before" in cleaned and "after" in cleaned


@pytest.mark.parametrize(
    "handler",
    ["onerror", "onload", "onclick", "onmouseover", "onkeydown"],
)
def test_html_event_handlers_are_stripped(handler):
    cleaned = sanitize_html(f'<img src="x.png" {handler}="alert(1)" alt="a">')
    assert handler not in cleaned.lower()
    assert 'src="x.png"' in cleaned
    assert 'alt="a"' in cleaned


@pytest.mark.parametrize(
    "href",
    ["javascript:alert(1)", "vbscript:msgbox(1)", "data:text/html;base64,PHNjcmlwdD4=", "file:///etc/passwd"],
)
def test_html_unsafe_uris_are_dropped(href):
    cleaned = sanitize_html(f'<a href="{href}">link</a>')
    assert "href" not in cleaned.lower()
    assert "link" in cleaned


@pytest.mark.parametrize(
    "href",
    ["https://example.com/a?b=1#c", "http://example.com", "/relative/path", "./sibling", "#anchor", "mailto:a@b.com", "tel:+123"],
)
def test_html_safe_uris_are_kept(href):
    cleaned = sanitize_html(f'<a href="{href}">link</a>')
    assert f'href="{href}"' in cleaned


def test_html_data_image_src_is_dropped_to_match_client_policy():
    cleaned = sanitize_html('<img src="data:image/png;base64,iVBORw0KGgo=" alt="inline">')
    assert "data:" not in cleaned
    assert 'alt="inline"' in cleaned


def test_html_preserves_report_structure():
    html = (
        "<h1>Title</h1><h2>Sub</h2>"
        "<p>Body with <strong>bold</strong> and <em>italic</em>.</p>"
        "<ul><li>one</li><li>two</li></ul>"
        "<table><thead><tr><th scope='col'>H</th></tr></thead>"
        "<tbody><tr><td colspan='2'>cell</td></tr></tbody></table>"
        "<blockquote>quote</blockquote><pre><code>x = 1</code></pre>"
    )
    cleaned = sanitize_html(html)
    for token in ("<h1>", "<h2>", "<strong>", "<em>", "<ul>", "<li>", "<table>", "<th", "<td", "<blockquote>", "<pre>", "<code>"):
        assert token in cleaned


def test_html_css_sanitizer_drops_unsafe_url_but_keeps_safe_properties():
    cleaned = sanitize_html(
        '<span style="color:red;background-image:url(javascript:alert(1))">hi</span>'
    )
    assert "color:red" in cleaned
    assert "url(" not in cleaned
    assert "javascript" not in cleaned.lower()


def test_html_escaped_code_sample_survives_untouched():
    cleaned = sanitize_html("<pre>&lt;script&gt;alert(1)&lt;/script&gt;</pre>")
    assert "&lt;script&gt;" in cleaned
    assert "<script" not in cleaned.lower()


def test_html_comments_are_removed():
    assert "secret" not in sanitize_html("<p>a<!-- secret -->b</p>")


def test_html_empty_input_returns_empty_string():
    assert sanitize_html("") == ""


# --------------------------------------------------------------------------- #
# Markdown
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "scheme",
    ["javascript", "JaVaScRiPt", "vbscript", "data", "file"],
)
def test_markdown_unsafe_link_schemes_are_neutralized(scheme):
    cleaned = sanitize_markdown(f"[click]({scheme}:alert(1))")
    assert f"{scheme.lower()}:" not in cleaned.lower()
    assert cleaned.startswith("[click](")


@pytest.mark.parametrize(
    "dest",
    ["https://example.com", "http://example.com", "mailto:a@b.com", "tel:+123", "./page", "/root", "#anchor"],
)
def test_markdown_safe_destinations_are_kept(dest):
    src = f"[ok]({dest})"
    assert sanitize_markdown(src) == src


def test_markdown_unsafe_image_scheme_is_neutralized():
    cleaned = sanitize_markdown("![bad](data:text/html;base64,PHNjcmlwdD4=)")
    assert "data:" not in cleaned.lower()


def test_markdown_reference_definition_scheme_is_neutralized():
    cleaned = sanitize_markdown("[a][r]\n\n[r]: javascript:alert(1)")
    assert "javascript:" not in cleaned.lower()
    assert "[a][r]" in cleaned


def test_markdown_safe_reference_definition_is_kept():
    src = "[a][r]\n\n[r]: https://example.com"
    assert sanitize_markdown(src) == src


def test_markdown_raw_html_event_handler_is_removed():
    cleaned = sanitize_markdown('<img src="x.png" onerror=alert(1)>')
    assert "onerror" not in cleaned.lower()
    assert 'src="x.png"' in cleaned


def test_markdown_raw_html_script_block_removed():
    cleaned = sanitize_markdown("<script>alert(1)</script>after")
    assert "<script" not in cleaned.lower()
    assert "after" in cleaned


def test_markdown_fenced_code_sample_is_preserved_verbatim():
    src = '```html\n<img src=x onerror="alert(1)">\n[x](javascript:no)\n```'
    assert sanitize_markdown(src) == src


def test_markdown_tilde_fence_sample_is_preserved():
    src = "~~~\n[x](javascript:no)\n~~~"
    assert sanitize_markdown(src) == src


def test_markdown_inline_code_sample_is_preserved():
    src = "Use `<img src=x onerror=alert(1)>` and `[x](javascript:1)` in docs."
    assert sanitize_markdown(src) == src


def test_markdown_prose_mentioning_attributes_is_untouched():
    src = "Set the onerror= attribute on an img tag when testing."
    assert sanitize_markdown(src) == src


def test_markdown_normal_document_is_unchanged():
    src = "# Heading\n\nSee [docs](https://example.com) and `code`.\n\n- one\n- two"
    assert sanitize_markdown(src) == src


def test_markdown_empty_input_returns_empty_string():
    assert sanitize_markdown("") == ""


# --------------------------------------------------------------------------- #
# Dispatch + idempotence
# --------------------------------------------------------------------------- #


def test_sanitize_artifact_dispatches_on_kind():
    assert sanitize_artifact("html", "<b>x</b><script>1</script>") == "<b>x</b>1"
    assert sanitize_artifact("markdown", "[x](javascript:1)") == "[x](1)"
    assert sanitize_artifact("text", "[x](javascript:1)") == "[x](1)"
    assert sanitize_artifact(None, "[x](javascript:1)") == "[x](1)"


HTML_IDEMPOTENCE = [
    '<p>a</p><script>x</script>',
    '<img src="x.png" onerror="a" alt="b">',
    '<a href="javascript:1">x</a>',
    '<span style="color:red;background-image:url(javascript:1)">y</span>',
    '<table><tr><td>c</td></tr></table>',
]

MARKDOWN_IDEMPOTENCE = [
    "[x](javascript:alert(1))",
    '<img src="x.png" onerror=alert(1)>',
    "<script>1</script>after",
    "```\n[x](javascript:1)\n```",
    "Use `[x](javascript:1)` inline.",
    "# Title\n\n[ok](https://example.com)",
]


@pytest.mark.parametrize("payload", HTML_IDEMPOTENCE)
def test_sanitize_html_is_idempotent(payload):
    once = sanitize_html(payload)
    assert sanitize_html(once) == once


@pytest.mark.parametrize("payload", MARKDOWN_IDEMPOTENCE)
def test_sanitize_markdown_is_idempotent(payload):
    once = sanitize_markdown(payload)
    assert sanitize_markdown(once) == once