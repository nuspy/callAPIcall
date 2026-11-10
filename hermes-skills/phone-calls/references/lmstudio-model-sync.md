# LM Studio model sync for Hermes

Use this when Hermes must follow the model list exposed by a local LM Studio instance.

Authoritative probe:
- GET http://127.0.0.1:1234/v1/models
- No API key required on localhost in the common LM Studio setup used in this workspace.

Observed model IDs in this session:
- gemma-4-e2b-it
- gemma-4-19b-a4b-it-instruct-heretic-uncensored-i1
- gemma-3-12b-it-vl-polaris-glm-4.7-flash-var-thinking-instruct-heretic-uncensored-i1
- gemma-4-12b-obliterated
- gemma-4-e4b-uncensored-hauhaucs-aggressive
- cinematika-7b-v0.1
- gemma-4-31b-it-heretic
- qwen3-coder-next
- qwen3.6-35b-a3b-uncensored-hauhaucs-aggressive
- nemotron-cascade-2-30b-a3b-i1
- mirothinker-1.7-mini-i1
- nvidia/nemotron-3-nano
- qwen/qwen3.5-35b-a3b
- text-embedding-nomic-embed-text-v1.5

Workflow:
1. Query /v1/models.
2. Diff the returned IDs against the lmstudio.models section in ~/.hermes/config.yaml.
3. Remove stale IDs, add missing IDs, and keep the default model set to a returned ID.
4. If Hermes should track the currently active LM Studio model, update model.default to the current server-side ID.

Pitfall:
- Do not assume the GUI-selected model is the one Hermes should use unless it appears in /v1/models and matches the config default.
