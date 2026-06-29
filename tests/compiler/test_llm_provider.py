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
