"""
title: Layman Monitor
author: layman
description: Captures user prompts and AI responses and forwards them to Layman for monitoring.
version: 0.6.0
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
            content = last_user.get("content", "")
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

    def _extract_web_search(self, body: dict) -> tuple[list[str], list[dict]]:
        """Extract web search queries and sources from the outlet body.

        Queries come from tool_calls in assistant messages; sources come from
        body['sources'] (populated by Open WebUI's search pipeline).
        Returns (queries, sources) where each source has url/hostname/title/content.
        """
        queries: list[str] = []
        messages = body.get("messages", [])

        # Pull queries from assistant tool_calls (tool-based search mode)
        for msg in messages:
            if msg.get("role") != "assistant":
                continue
            for tc in msg.get("tool_calls", []) or []:
                fn = tc.get("function", {})
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

        # Normalize sources from body['sources']
        sources: list[dict] = []
        seen_urls: set[str] = set()
        for s in body.get("sources", []) or []:
            url = (
                s.get("url")
                or s.get("source")
                or (s.get("metadata") or {}).get("source", "")
            )
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            try:
                hostname = urlparse(url).hostname or url
            except Exception:
                hostname = url
            title = (
                s.get("name")
                or s.get("title")
                or (s.get("metadata") or {}).get("title", "")
                or hostname
            )
            raw_content = s.get("content") or s.get("document") or ""
            content = str(raw_content)[:500] if raw_content else None
            sources.append({
                "url": url,
                "hostname": hostname,
                "title": str(title),
                "content": content,
            })

        return queries, sources

    async def outlet(self, body: dict, __user__: dict = {}, __metadata__: dict = {}) -> dict:
        """Capture the assistant's response after the model returns.

        Open WebUI passes outlet a messages-array body (not OpenAI choices format):
          { "model": "...", "messages": [{role, content, ...}, ...], "chat_id": "..." }
        chat_id may only be available in __metadata__ (same as inlet).
        """
        if not self.valves.enabled:
            return body

        chat_id = body.get("chat_id", "") or __metadata__.get("chat_id", "")

        # Find the last assistant message in the conversation
        messages = body.get("messages", [])
        last_assistant = next(
            (m for m in reversed(messages) if m.get("role") == "assistant"), None
        )

        if last_assistant:
            content = last_assistant.get("content", "")
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
                    # Plain-string responses: reasoning models embed thinking as HTML/tags
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

        # Emit web search event when the response used web sources
        queries, sources = self._extract_web_search(body)
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
