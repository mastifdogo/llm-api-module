"""LLM backends. Each backend takes a system prompt, a user prompt and a JSON schema,
and returns the parsed JSON object the model produced."""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Protocol

from .config import Config


class LLMError(RuntimeError):
    pass


class Backend(Protocol):
    def complete_json(self, system: str, user: str, schema: dict) -> dict: ...


# Models that accept the server-side refusal fallback (re-runs a declined request on another model).
_FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"}


class AnthropicBackend:
    def __init__(self, cfg: Config):
        try:
            import anthropic
        except ImportError as e:  # pragma: no cover - depends on install extras
            raise LLMError("the anthropic backend needs `pip install 'txcat[anthropic]'`") from e
        self._anthropic = anthropic
        kwargs = {"timeout": cfg.timeout}
        if cfg.anthropic_api_key:
            kwargs["api_key"] = cfg.anthropic_api_key
        self.client = anthropic.Anthropic(**kwargs)
        self.model = cfg.resolved_model

    def complete_json(self, system: str, user: str, schema: dict) -> dict:
        params = dict(
            model=self.model,
            max_tokens=16000,
            system=system,
            messages=[{"role": "user", "content": user}],
            # Categorization is a classification task; low effort keeps it fast and cheap.
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
        )
        a = self._anthropic
        try:
            if self.model in _FALLBACK_MODELS:
                response = self.client.beta.messages.create(
                    betas=["server-side-fallback-2026-07-01"], fallbacks="default", **params
                )
            else:
                response = self.client.messages.create(**params)
        except a.AuthenticationError as e:
            raise LLMError("Anthropic API key is missing or invalid") from e
        except a.RateLimitError as e:
            raise LLMError("Anthropic rate limit hit; try again shortly") from e
        except a.APIStatusError as e:
            raise LLMError(f"Anthropic API error {e.status_code}: {e.message}") from e
        except a.APIConnectionError as e:
            raise LLMError(f"could not reach the Anthropic API: {e}") from e

        if response.stop_reason == "refusal":
            raise LLMError("the model declined to categorize this batch")
        if response.stop_reason == "max_tokens":
            raise LLMError("response was truncated; lower batch_size")
        text = next((b.text for b in response.content if b.type == "text"), "")
        try:
            return json.loads(text)
        except json.JSONDecodeError as e:
            raise LLMError(f"model returned invalid JSON: {text[:200]!r}") from e


class OllamaBackend:
    """Local models via Ollama (>= 0.5, which supports JSON-schema constrained output)."""

    def __init__(self, cfg: Config):
        self.url = cfg.ollama_url.rstrip("/") + "/api/chat"
        self.model = cfg.resolved_model
        self.timeout = cfg.timeout

    def complete_json(self, system: str, user: str, schema: dict) -> dict:
        body = json.dumps(
            {
                "model": self.model,
                "stream": False,
                "format": schema,
                "options": {"temperature": 0},
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            }
        ).encode()
        req = urllib.request.Request(self.url, data=body, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = json.load(resp)
        except urllib.error.HTTPError as e:
            raise LLMError(f"Ollama error {e.code}: {e.read().decode(errors='replace')[:200]}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            raise LLMError(f"could not reach Ollama at {self.url}: {e}") from e
        text = data.get("message", {}).get("content", "")
        try:
            return json.loads(text)
        except json.JSONDecodeError as e:
            raise LLMError(f"model returned invalid JSON: {text[:200]!r}") from e


def make_backend(cfg: Config) -> Backend:
    if cfg.provider == "anthropic":
        return AnthropicBackend(cfg)
    if cfg.provider == "ollama":
        return OllamaBackend(cfg)
    raise ValueError(f"unknown provider {cfg.provider!r} (expected 'anthropic' or 'ollama')")
