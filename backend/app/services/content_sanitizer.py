"""Server-side content sanitization for generated HTML and Markdown artifacts.

Artifact bodies are model-generated, so they are untrusted. This module is the
*server-side* half of the artifact security policy (the browser half lives in
``frontend/src/components/ArtifactViewer.tsx`` and uses DOMPurify plus a strict
CSP). Sanitizing on the server guarantees that artifacts are safe *at rest* and
on *retrieval*, independent of which consumer renders them (UI, API, export,
future clients).

Two entry points:

* :func:`sanitize_html` -- allow-list sanitizer built on bleach + tinycss2.
  Drops disallowed tags (``script``, ``iframe``, ``object``, ``embed``, ``form``,
  ``meta``, ``base`` ...), inline event handlers (``on*``), unsafe URIs
  (``javascript:``, ``vbscript:``, ``data:``, ``file:``) and unsafe CSS values,
  while preserving the structural markup reports rely on: headings, tables,
  lists, links, images, code blocks and common inline formatting.

* :func:`sanitize_markdown` -- code-aware Markdown scrubber. Neutralizes
  dangerous link/image destinations and embedded raw HTML while leaving Markdown
  *source samples* inside fenced code blocks and inline code spans untouched
  (these are a first-class artifact feature, e.g. security write-ups that quote
  attack payloads).

Both are deliberately idempotent: re-sanitizing already-clean content is a
no-op, so the write-time and read-time passes compose cleanly.

The policy intentionally matches what the browser enforces. DOMPurify (as
configured in ``ArtifactViewer``) strips ``data:`` URIs, inline handlers and
active elements; the server mirrors that rather than trying to be more
permissive, so the stored artifact equals what the user actually sees.
"""
from __future__ import annotations

import re

import bleach
from bleach.css_sanitizer import CSSSanitizer

__all__ = ["sanitize_html", "sanitize_markdown", "sanitize_artifact"]


ALLOWED_TAGS: frozenset[str] = frozenset(
    """
    a abbr article aside b blockquote br caption cite code col colgroup data dd
    del details dfn div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6
    header hr i img ins kbd li main mark nav ol p pre q s samp section small
    span strong sub summary sup table tbody td tfoot th thead time tr u ul var
    wbr
    """.split()
)

_GLOBAL_ATTRS = ["id", "class", "lang", "dir", "title", "style"]

ALLOWED_ATTRIBUTES: dict[str, list[str]] = {
    "*": _GLOBAL_ATTRS,
    "a": ["href", "title", "target", "rel"],
    "img": ["src", "alt", "width", "height", "loading", "srcset", "sizes"],
    "td": ["colspan", "rowspan"],
    "th": ["colspan", "rowspan", "scope"],
    "ol": ["start", "reversed"],
    "time": ["datetime"],
}

ALLOWED_PROTOCOLS: tuple[str, ...] = ("http", "https", "mailto", "tel")

ALLOWED_CSS_PROPERTIES: tuple[str, ...] = (
    "color", "background-color", "font-family", "font-size", "font-style",
    "font-weight", "line-height", "text-align", "text-decoration",
    "text-transform", "letter-spacing", "word-break", "overflow-wrap",
    "white-space", "vertical-align", "visibility", "display", "float",
    "list-style", "list-style-type", "border-collapse",
    "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
    "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
    "border", "border-top", "border-right", "border-bottom", "border-left",
    "border-radius", "width", "height", "max-width", "max-height",
)

_CSS_SANITIZER = CSSSanitizer(allowed_css_properties=list(ALLOWED_CSS_PROPERTIES))


def sanitize_html(html: str) -> str:
    """Return an allow-listed, script-free version of an HTML fragment."""
    if not html:
        return ""
    return bleach.clean(
        html,
        tags=set(ALLOWED_TAGS),
        attributes=ALLOWED_ATTRIBUTES,
        protocols=list(ALLOWED_PROTOCOLS),
        css_sanitizer=_CSS_SANITIZER,
        strip=True,
        strip_comments=True,
    )


_SAFE_MD_SCHEMES = frozenset({"http", "https", "mailto", "tel"})

_MD_FENCE_RE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
_MD_INLINE_CODE_RE = re.compile(r"(`+)(.*?)\1", re.DOTALL)

_MD_REF_DEF_RE = re.compile(
    r"^(?P<head>\s{0,3}\[[^\]\n]+\]:\s*)(?P<scheme>[a-zA-Z][a-zA-Z0-9+.\-]*):",
    re.MULTILINE,
)
_MD_DEST_SCHEME_RE = re.compile(
    r"(?P<head>!?\[[^\]\n]*\]\(\s*)(?P<scheme>[a-zA-Z][a-zA-Z0-9+.\-]*):",
)

_RAW_TAG_RE = re.compile(r"</?[a-zA-Z][^<>]*>")
_DROP_ELEMENT_RE = re.compile(
    r"<(script|iframe|object|embed|style)\b[^>]*>.*?</\1\s*>",
    re.IGNORECASE | re.DOTALL,
)
_EVENT_HANDLER_RE = re.compile(
    r"\son[a-zA-Z]+\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)",
    re.IGNORECASE,
)
_URI_ATTR_RE = re.compile(
    r"(?P<attr>\b(?:href|src|xlink:href|formaction|action|poster|background|"
    r"srcset|data)\s*=\s*)(?P<quote>[\"']?)(?P<val>[^\"'\s>]*)",
    re.IGNORECASE,
)


def _strip_unsafe_scheme(head: str, scheme: str) -> str:
    if scheme.lower() in _SAFE_MD_SCHEMES:
        return f"{head}{scheme}:"
    return head


def _scrub_raw_tag(tag: str) -> str:
    tag = _EVENT_HANDLER_RE.sub("", tag)

    def _uri(match: re.Match[str]) -> str:
        value = match.group("val")
        scheme_match = re.match(r"[a-zA-Z][a-zA-Z0-9+.\-]*:", value)
        if scheme_match:
            scheme = scheme_match.group(0)[:-1]
            if scheme.lower() not in _SAFE_MD_SCHEMES:
                value = value[len(scheme) + 1 :]
        return f"{match.group('attr')}{match.group('quote')}{value}"

    return _URI_ATTR_RE.sub(_uri, tag)


def sanitize_markdown(text: str) -> str:
    """Neutralize dangerous destinations/raw HTML in a Markdown document.

    Fenced code blocks and inline code spans are preserved verbatim so quoted
    payloads remain readable inside samples.
    """
    if not text:
        return ""

    lines = text.splitlines(keepends=True)
    in_fence = False
    fence_marker = ""
    out: list[str] = []

    for line in lines:
        fence_match = _MD_FENCE_RE.match(line)
        if fence_match:
            marker = fence_match.group(1)[0]
            if not in_fence:
                in_fence = True
                fence_marker = marker
            elif marker == fence_marker:
                in_fence = False
                fence_marker = ""
            out.append(line)
            continue

        if in_fence:
            out.append(line)
            continue

        out.append(_sanitize_markdown_line(line))

    return "".join(out)


def _sanitize_markdown_line(line: str) -> str:
    """Sanitize a single Markdown line, protecting inline code spans."""
    protected: list[str] = []

    def _stash(match: re.Match[str]) -> str:
        protected.append(match.group(0))
        return f"\x00{len(protected) - 1}\x00"

    masked = _MD_INLINE_CODE_RE.sub(_stash, line)

    masked = _DROP_ELEMENT_RE.sub("", masked)
    masked = _MD_REF_DEF_RE.sub(
        lambda m: _strip_unsafe_scheme(m.group("head"), m.group("scheme")), masked
    )
    masked = _MD_DEST_SCHEME_RE.sub(
        lambda m: _strip_unsafe_scheme(m.group("head"), m.group("scheme")), masked
    )
    masked = _RAW_TAG_RE.sub(lambda m: _scrub_raw_tag(m.group(0)), masked)

    for index, original in enumerate(protected):
        masked = masked.replace(f"\x00{index}\x00", original)
    return masked


def sanitize_artifact(kind: str | None, content: str) -> str:
    """Sanitize artifact ``content`` according to its ``kind``.

    ``html`` artifacts go through the strict HTML allow-list; every other kind
    (``markdown``, ``text``, ``md`` ...) is treated as Markdown.
    """
    if (kind or "").lower() == "html":
        return sanitize_html(content)
    return sanitize_markdown(content)
