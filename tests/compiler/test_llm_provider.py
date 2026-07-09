import base64
from unittest.mock import MagicMock, patch
from compiler.llm_provider import DeepSeekProvider, LLMProvider


def test_deepseek_provider_is_llm_provider():
    provider = DeepSeekProvider(api_key="fake-key")
    assert isinstance(provider, LLMProvider)


def test_deepseek_generate_returns_content():
    mock_choice = MagicMock()
    mock_choice.message.content = "Generated wiki content"
    mock_completion = MagicMock()
    mock_completion.choices = [mock_choice]

    with patch("compiler.llm_provider.OpenAI") as mock_openai_cls:
        mock_client = MagicMock()
        mock_client.chat.completions.create.return_value = mock_completion
        mock_openai_cls.return_value = mock_client

        provider = DeepSeekProvider(api_key="fake-key")
        result = provider.generate(system="You are a helper.", prompt="Write something.")

    assert result == "Generated wiki content"
    mock_client.chat.completions.create.assert_called_once_with(
        model="deepseek-chat",
        messages=[
            {"role": "system", "content": "You are a helper."},
            {"role": "user", "content": "Write something."},
        ],
    )


def test_deepseek_uses_custom_model():
    with patch("compiler.llm_provider.OpenAI"):
        provider = DeepSeekProvider(api_key="fake-key", model="deepseek-reasoner")
        assert provider.model == "deepseek-reasoner"


def _mock_gemini_response(text):
    mock_resp = MagicMock()
    mock_resp.json.return_value = {
        "candidates": [{"content": {"parts": [{"text": text}]}}]
    }
    mock_resp.raise_for_status.return_value = None
    return mock_resp


def test_gemini_provider_is_llm_provider():
    from compiler.llm_provider import GeminiProvider
    provider = GeminiProvider(api_key="fake-key")
    assert isinstance(provider, LLMProvider)


def test_gemini_generate_returns_text():
    from compiler.llm_provider import GeminiProvider
    with patch(
        "compiler.llm_provider.requests.post",
        return_value=_mock_gemini_response("Generated text"),
    ) as mock_post:
        provider = GeminiProvider(api_key="fake-key")
        result = provider.generate(system="You are a helper.", prompt="Write something.")

    assert result == "Generated text"
    call = mock_post.call_args
    assert "gemini-3.1-flash-lite:generateContent" in call.args[0]
    body = call.kwargs["json"]
    assert body["system_instruction"]["parts"][0]["text"] == "You are a helper."
    assert body["contents"][0]["parts"][0]["text"] == "Write something."


def test_gemini_generate_multimodal_includes_inline_pdf():
    from compiler.llm_provider import GeminiProvider
    pdf_bytes = b"%PDF-fake-bytes"
    with patch(
        "compiler.llm_provider.requests.post",
        return_value=_mock_gemini_response("Chapter content"),
    ) as mock_post:
        provider = GeminiProvider(api_key="fake-key")
        result = provider.generate_multimodal(
            system="Sys", prompt="Describe this chapter.", pdf_bytes=pdf_bytes
        )

    assert result == "Chapter content"
    body = mock_post.call_args.kwargs["json"]
    parts = body["contents"][0]["parts"]
    assert parts[0]["text"] == "Describe this chapter."
    assert parts[1]["inline_data"]["mime_type"] == "application/pdf"
    assert parts[1]["inline_data"]["data"] == base64.b64encode(pdf_bytes).decode("ascii")


def test_gemini_uses_custom_model():
    from compiler.llm_provider import GeminiProvider
    provider = GeminiProvider(api_key="fake-key", model="gemini-custom")
    assert provider.model == "gemini-custom"


def test_gemini_generate_sends_api_key_in_header_not_url():
    from compiler.llm_provider import GeminiProvider
    with patch(
        "compiler.llm_provider.requests.post",
        return_value=_mock_gemini_response("text"),
    ) as mock_post:
        provider = GeminiProvider(api_key="secret-key-123")
        provider.generate(system="s", prompt="p")

    call = mock_post.call_args
    assert "secret-key-123" not in call.args[0]
    assert call.kwargs["headers"]["x-goog-api-key"] == "secret-key-123"


def test_gemini_generate_raises_on_http_error():
    from compiler.llm_provider import GeminiProvider
    mock_resp = MagicMock()
    mock_resp.raise_for_status.side_effect = Exception("500 error")
    with patch("compiler.llm_provider.requests.post", return_value=mock_resp):
        provider = GeminiProvider(api_key="fake-key")
        try:
            provider.generate(system="s", prompt="p")
            assert False, "expected an exception to propagate"
        except Exception as e:
            assert "500 error" in str(e)
