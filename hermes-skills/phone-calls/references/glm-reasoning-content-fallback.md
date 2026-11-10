# glm-5.1 content/reasoning_content Fallback

## Problema

glm-5.1 (Z.AI) può restituire il testo della risposta in `reasoning_content` invece di `content`, anche quando `thinking` è disabilitato (`extra_body={"thinking": {"type": "disabled"}}`). Risultato: `content=""` mentre `reasoning_content` contiene il testo reale → voce muta.

## Soluzione: `_delta_text()` helper

### Streaming (chunk-by-chunk)

```python
def _delta_text(chunk) -> str:
    """Estrae il token di testo da un chunk streaming.
    Gestisce glm-5.1 che a volte mette il testo in reasoning_content."""
    if not chunk.choices:
        return ""
    delta = chunk.choices[0].delta
    # 1. Contenuto normale
    text = getattr(delta, "content", None) or ""
    if text:
        return text
    # 2. Fallback: reasoning_content (glm-5.1 / modelli "thinking")
    rc = getattr(delta, "reasoning_content", None) or ""
    if rc:
        return rc
    return ""
```

**Uso** — sostituisce TUTTI i `delta.content` diretti:
```python
# ❌ PRIMA (rotto con glm-5.1)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        full_response += chunk.choices[0].delta.content

# ✅ DOPO
for chunk in stream:
    t = _delta_text(chunk)
    if t:
        full_response += t
```

### Non-streaming (risposta completa)

```python
msg = response.choices[0].message
text = msg.content or getattr(msg, "reasoning_content", None) or ""
```

## Punti nel phone server dove applicare

1. `llm_respond()` — streaming principale (righe ~840+)
2. `_native_tool_call()` — Strategia 1, streaming post-tool
3. `_text_tool_call()` — Strategia 1.5, streaming iniziale
4. `_text_tool_call()` — Strategia 1.5, streaming post-tool
5. Risposte non-streaming — `msg.content or getattr(msg, "reasoning_content", None)`

## Verifica

```bash
# Test che il testo torni (non muto):
curl -s --max-time 30 -X POST http://127.0.0.1:8780/utterance \
  -H "Content-Type: application/json" \
  -d '{"session_id":"test","text":"Ciao, chi sei?","direction":"INCOMING"}'
# Deve mostrare chunks di testo, non silenzio
```

## Nota

Questo pattern vale per QUALSIASI modello "thinking" (o1, DeepSeek-R1, glm-5.x). La funzione helper `_delta_text()` è generica e non specifica per glm.
