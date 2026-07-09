import base64
from abc import ABC, abstractmethod
import requests
from openai import OpenAI


class LLMProvider(ABC):
    @abstractmethod
    def generate(self, system: str, prompt: str) -> str: ...


class DeepSeekProvider(LLMProvider):
    def __init__(self, api_key: str, model: str = "deepseek-chat"):
        self.client = OpenAI(
            api_key=api_key,
            base_url="https://api.deepseek.com",
        )
        self.model = model

    def generate(self, system: str, prompt: str) -> str:
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
        )
        return response.choices[0].message.content or ""


class GeminiProvider(LLMProvider):
    def __init__(self, api_key: str, model: str = "gemini-3.1-flash-lite"):
        self.api_key = api_key
        self.model = model
        self.base_url = "https://generativelanguage.googleapis.com/v1beta"

    def generate(self, system: str, prompt: str) -> str:
        return self._call(system, [{"text": prompt}])

    def generate_multimodal(self, system: str, prompt: str, pdf_bytes: bytes) -> str:
        parts = [
            {"text": prompt},
            {
                "inline_data": {
                    "mime_type": "application/pdf",
                    "data": base64.b64encode(pdf_bytes).decode("ascii"),
                }
            },
        ]
        return self._call(system, parts)

    def _call(self, system: str, parts: list[dict]) -> str:
        url = f"{self.base_url}/models/{self.model}:generateContent"
        headers = {"x-goog-api-key": self.api_key, "Content-Type": "application/json"}
        body = {
            "system_instruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": parts}],
        }
        response = requests.post(url, headers=headers, json=body, timeout=120)
        response.raise_for_status()
        data = response.json()
        return data["candidates"][0]["content"]["parts"][0]["text"]
