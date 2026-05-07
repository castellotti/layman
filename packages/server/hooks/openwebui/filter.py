"""
title: Layman Monitor
author: layman
description: Captures user prompts and AI responses and forwards them to Layman for monitoring.
version: 0.7.0
license: MIT
"""

import html as _html
import json
import re
import aiohttp
from pydantic import BaseModel
from urllib.parse import urlparse

# Patterns that reasoning models embed in their text output.
# Each pattern captures the raw thinking text in group 1.
_REASONING_PATTERNS = [
    # <details type="reasoning" ...><summary>...</summary> ... </details>
    re.compile(
        r'<details[^>]*\btype=["\']?reasoning["\']?[^>]*>\s*<summary>[^<]*</summary>(.*?)</details>',
        re.DOTALL | re.IGNORECASE,
    ),
    # <think>...</think>  (DeepSeek-R1 and similar)
    re.compile(r'<think>(.*?)</think>', re.DOTALL | re.IGNORECASE),
    # <thinking>...</thinking>
    re.compile(r'<thinking>(.*?)</thinking>', re.DOTALL | re.IGNORECASE),
]


def _extract_reasoning(text: str) -> tuple[str | None, str]:
    """Strip reasoning/thinking blocks from *text*, returning (thinking, response).

    *thinking* is the concatenated inner text of all matched blocks (HTML-unescaped),
    or None if no blocks were found.  *response* is the remaining text, stripped.
    """
    collected: list[str] = []

    def _pull(m: re.Match) -> str:
        inner = _html.unescape(m.group(1)).strip()
        if inner:
            collected.append(inner)
        return ""

    cleaned = text
    for pattern in _REASONING_PATTERNS:
        cleaned = pattern.sub(_pull, cleaned)

    cleaned = cleaned.strip()
    return ("\n\n".join(collected) if collected else None), cleaned


def _normalize_source(s: dict, seen_urls: set) -> dict | None:
    """Normalize a source dict from any Open WebUI source format into {url, hostname, title, content}."""
    # Open WebUI stores sources in multiple formats depending on version / pipeline:
    #   per-message: {"name": "title", "url": "...", "content": "..."}
    #   RAG/metadata: {"source": {"url": "...", "name": "..."}, "document": ["..."], "metadata": [{"source": "..."}]}
    url = (
        s.get("url")
        or s.get("source")
        or (s.get("source") if isinstance(s.get("source"), str) else None)
        or (s.get("source", {}).get("url") if isinstance(s.get("source"), dict) else None)
        or (s.get("metadata") or [{}])[0].get("source", "")
    )
    if not url or url in seen_urls:
        return None
    seen_urls.add(url)
    try:
        hostname = urlparse(url).hostname or url
    except Exception:
        hostname = url
    title = (
        s.get("name")
        or s.get("title")
        or (s.get("source", {}).get("name") if isinstance(s.get("source"), dict) else None)
        or (s.get("metadata") or [{}])[0].get("title", "")
        or hostname
    )
    # document may be a list of strings (RAG format) or a plain string
    doc = s.get("document") or s.get("content") or ""
    if isinstance(doc, list):
        doc = " ".join(str(d) for d in doc if d)
    raw_content = str(doc)[:500] if doc else None
    return {"url": url, "hostname": hostname, "title": str(title), "content": raw_content}


class Filter:
    class Valves(BaseModel):
        layman_url: str = "__LAYMAN_URL__"
        enabled: bool = True

    def __init__(self):
        self.valves = self.Valves()

    async def inlet(self, body: dict, __user__: dict = {}, __metadata__: dict = {}) -> dict:
        """Capture the user's message before it reaches the model.

        chat_id is not in the inlet body — Open WebUI only puts it in __metadata__.
        """
        if not self.valves.enabled:
            return body

        chat_id = body.get("chat_id", "") or __metadata__.get("chat_id", "")
        messages = body.get("messages", [])
        last_user = next(
            (m for m in reversed(messages) if m.get("role") == "user"), None
        )
        if last_user:
            content = last_user.get("content") or ""
            if isinstance(content, list):
                # Multi-modal: extract text parts
                content = " ".join(
                    p.get("text", "") for p in content if p.get("type") == "text"
                )
            await self._post({
                "event": "UserPromptSubmit",
                "chat_id": chat_id,
                "user_id": __user__.get("id", ""),
                "user_name": __user__.get("name", ""),
                "prompt": content,
                "model": body.get("model", ""),
            })

        return body

    def _extract_web_search(
        self, body: dict, last_assistant: dict, metadata: dict
    ) -> tuple[list[str], list[dict]]:
        """Extract web search queries and sources.

        Open WebUI's outlet body stores data differently from what the OpenAI API exposes:
          - Queries: in the assistant message's 'output' list as {type:'function_call', name:'...', arguments:'...'}
          - Sources: on the assistant message as message['sources'], and in __metadata__['sources']
            (NOT at body['sources'] — that field is typically absent in the outlet body)
        """
        queries: list[str] = []
        seen_urls: set[str] = set()
        sources: list[dict] = []

        # --- Queries from the assistant message's output items ---
        # Open WebUI serializes tool calls into the 'output' list as function_call items.
        for item in (last_assistant.get("output") or []):
            if item.get("type") != "function_call":
                continue
            name = item.get("name", "").lower()
            if "search" not in name:
                continue
            args_raw = item.get("arguments") or {}
            try:
                args = json.loads(args_raw) if isinstance(args_raw, str) else args_raw
            except Exception:
                continue
            q = args.get("query") or args.get("q") or args.get("search_query", "")
            if q and q not in queries:
                queries.append(str(q))

        # Fallback: tool_calls on messages (older / OpenAI-native format)
        if not queries:
            for msg in (body.get("messages") or []):
                if msg.get("role") != "assistant":
                    continue
                for tc in (msg.get("tool_calls") or []):
                    fn = tc.get("function") or {}
                    name = fn.get("name", "").lower()
                    if "search" not in name:
                        continue
                    try:
                        args = json.loads(fn.get("arguments", "{}"))
                    except Exception:
                        continue
                    q = args.get("query") or args.get("q") or args.get("search_query", "")
                    if q and q not in queries:
                        queries.append(str(q))

        # --- Sources: per-message first, then metadata, then body fallback ---
        for raw in (last_assistant.get("sources") or []):
            normalized = _normalize_source(raw, seen_urls)
            if normalized:
                sources.append(normalized)

        for raw in (metadata.get("sources") or []):
            normalized = _normalize_source(raw, seen_urls)
            if normalized:
                sources.append(normalized)

        # Final fallback: body-level sources (present in some older / pipeline versions)
        for raw in (body.get("sources") or []):
            normalized = _normalize_source(raw, seen_urls)
            if normalized:
                sources.append(normalized)

        return queries, sources

    async def outlet(self, body: dict, __user__: dict = {}, __metadata__: dict = {}) -> dict:
        """Capture the assistant's response after the model returns.

        Open WebUI passes outlet a messages-array body:
          { "model": "...", "messages": [{role, content, output, sources, ...}, ...], "chat_id": "..." }

        The last assistant message carries:
          - content: serialized HTML (reasoning in <details type="reasoning">, tool calls in
            <details type="tool_calls">).  May be None — always coerce with `or ""`.
          - output: raw output item list [{type:'function_call',...}, {type:'reasoning',...}, ...]
          - sources: retrieved web sources [{url, name, content, ...}]

        chat_id may only be available in __metadata__ (same as inlet).
        """
        if not self.valves.enabled:
            return body

        chat_id = body.get("chat_id", "") or __metadata__.get("chat_id", "")

        # Find the last assistant message — content may be None, coerce to "".
        messages = body.get("messages") or []
        last_assistant = next(
            (m for m in reversed(messages) if m.get("role") == "assistant"), None
        )

        if last_assistant:
            # Use `or ""` rather than `.get(..., "")` because the key may exist with value None
            content = last_assistant.get("content") or ""
            text_parts = []
            thinking_parts = []
            if isinstance(content, list):
                for p in content:
                    if not isinstance(p, dict):
                        continue
                    if p.get("type") == "thinking":
                        t = p.get("thinking", "")
                        if t:
                            thinking_parts.append(t)
                    elif p.get("type") == "text":
                        t = p.get("text", "")
                        if t:
                            # Some list-format models still embed reasoning HTML in text blocks
                            extracted, remainder = _extract_reasoning(t)
                            if extracted:
                                thinking_parts.append(extracted)
                            if remainder:
                                text_parts.append(remainder)
            else:
                if content:
                    # Plain-string / serialized-HTML responses: extract <details type="reasoning">
                    # and <think>/<thinking> blocks as thinking; leave the rest as the response.
                    extracted, remainder = _extract_reasoning(content)
                    if extracted:
                        thinking_parts.append(extracted)
                    if remainder:
                        text_parts.append(remainder)

            response_text = "\n\n".join(text_parts)
            thinking_text = "\n\n".join(thinking_parts)
            if response_text or thinking_text:
                payload: dict = {
                    "event": "AgentResponse",
                    "chat_id": chat_id,
                    "user_id": __user__.get("id", ""),
                    "user_name": __user__.get("name", ""),
                    "response": response_text,
                    "model": body.get("model", ""),
                }
                if thinking_text:
                    payload["thinking"] = thinking_text
                await self._post(payload)

            # Emit web search event when the response used web sources or issued search queries.
            queries, sources = self._extract_web_search(body, last_assistant, __metadata__)
            if sources or queries:
                search_payload: dict = {
                    "event": "WebSearch",
                    "chat_id": chat_id,
                    "user_id": __user__.get("id", ""),
                    "user_name": __user__.get("name", ""),
                    "model": body.get("model", ""),
                    "sources": sources,
                }
                if queries:
                    search_payload["queries"] = queries
                await self._post(search_payload)

        return body

    async def _post(self, payload: dict) -> None:
        try:
            async with aiohttp.ClientSession() as session:
                await session.post(
                    f"{self.valves.layman_url}/hooks/openwebui",
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=5),
                )
        except Exception:
            pass
