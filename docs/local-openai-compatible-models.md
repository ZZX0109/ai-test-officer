# Local OpenAI-compatible models

AI Test Officer can use a local model through the same bounded Planner and Judge path as a hosted provider. Local results remain a separate model profile and must be evaluated independently; they are never treated as equivalent to GPT results.

## Ollama

1. Start Ollama and pull a model that can reliably return JSON.
2. In Credential Center choose **Ollama preset**.
3. Keep the base URL at `http://127.0.0.1:11434/v1`, set the installed model ID, and use any non-empty local placeholder API key.
4. Test the profile before enabling adaptive or explicit LLM mode.

## vLLM

Start its OpenAI-compatible server, then use the **vLLM preset** with `http://127.0.0.1:8000/v1`. The model field must match the served model ID.

Local endpoints are allowed only in explicit local development. Production workers must place the model endpoint on an approved execution network and add its final host to the egress allowlist. Benchmark repetitions always remain independent and may not reuse plan cache or execution output.
