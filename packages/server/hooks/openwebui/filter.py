"""
title: Layman Monitor
author: layman
description: Captures user prompts and AI responses and forwards them to Layman for monitoring.
version: 0.4.2
license: MIT
"""

import aiohttp
from pydantic import BaseModel


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

    async def outlet(self, body: dict, __user__: dict = {}) -> dict:
        """Capture the assistant's response after the model returns.

        Open WebUI passes outlet a messages-array body (not OpenAI choices format):
          { "model": "...", "messages": [{role, content, ...}, ...], "chat_id": "..." }
        """
        if not self.valves.enabled:
            return body

        # Find the last assistant message in the conversation
        messages = body.get("messages", [])
        last_assistant = next(
            (m for m in reversed(messages) if m.get("role") == "assistant"), None
        )

        if last_assistant:
            content = last_assistant.get("content", "")
            if isinstance(content, list):
                # Thinking blocks or multi-modal: extract text/thinking parts
                content = " ".join(
                    p.get("text", "") for p in content
                    if isinstance(p, dict) and p.get("type") in ("text", "thinking")
                )
            if content:
                await self._post({
                    "event": "AgentResponse",
                    "chat_id": body.get("chat_id", ""),
                    "user_id": __user__.get("id", ""),
                    "user_name": __user__.get("name", ""),
                    "response": content,
                    "model": body.get("model", ""),
                })

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
