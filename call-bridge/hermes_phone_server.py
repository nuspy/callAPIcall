"""Hermes Phone Call Server — il cervello dell'agente telefonico callAPIcall.

Server HTTP su 0.0.0.0:8780 che riceve le richieste dall'orchestrator
e genera risposte in streaming SSE usando il modello LLM via OpenAI-compatible API.

USO:
    pip install flask openai
    python hermes_phone_server.py --host 0.0.0.0 --port 8780

CONFIGURAZIONE LLM:
    Modifica LLM_API_KEY, LLM_BASE_URL, LLM_MODEL sotto.
    Oppure imposta env vars: LLM_API_KEY, LLM_BASE_URL, LLM_MODEL.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import time
from collections.abc import Iterator

from flask import Flask, Response, jsonify, request

log = logging.getLogger("hermes-phone")

# ---------------------------------------------------------------------------
# Sessioni attive
# ---------------------------------------------------------------------------
SESSIONS: dict[str, dict] = {}

# ---------------------------------------------------------------------------
# LLM Streaming via OpenAI-compatible API
# ---------------------------------------------------------------------------
from openai import OpenAI

def _resolve_hermes_config() -> dict:
    """Legge ~/.hermes/config.yaml e risolve il provider/modello corrente.
    
    Ritorna dict con: model, base_url, api_key, provider
    """
    import yaml
    from pathlib import Path
    
    config_path = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))) / "config.yaml"
    env_path = config_path.parent / ".env"
    
    # Carica .env per le API key
    env_keys = {}
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env_keys[k.strip()] = v.strip()
    
    if not config_path.exists():
        log.warning("config.yaml non trovato, uso fallback Z.AI glm-5.1")
        return {"model": "glm-5.1", "base_url": "https://api.z.ai/api/coding/paas/v4",
                "api_key": env_keys.get("GLM_API_KEY", ""), "provider": "zai"}
    
    with open(config_path) as f:
        cfg = yaml.safe_load(f) or {}
    
    model_name = cfg.get("model", {}).get("default", "glm-5.1")
    provider_name = cfg.get("model", {}).get("provider", "zai")
    
    # Controlla se il modello è nei provider LM Studio
    providers = cfg.get("providers", {})
    fallbacks = cfg.get("fallback_providers", [])
    
    # Cerca il modello nei provider configurati
    resolved = None
    
    # 1. Controlla providers section (es. providers.lmstudio.models.*)
    for prov_key, prov_cfg in providers.items():
        if isinstance(prov_cfg, dict) and "models" in prov_cfg:
            if model_name in prov_cfg["models"]:
                resolved = {
                    "model": model_name,
                    "base_url": prov_cfg.get("base_url", ""),
                    "api_key": prov_cfg.get("api_key", ""),
                    "provider": prov_key,
                }
                break
    
    # 2. Controlla fallback_providers
    if not resolved:
        for fb in fallbacks:
            if fb.get("model") == model_name:
                resolved = {
                    "model": model_name,
                    "base_url": fb.get("base_url", ""),
                    "api_key": fb.get("api_key", ""),
                    "provider": fb.get("provider", "unknown"),
                }
                break
    
    # 3. Fallback: usa il provider default dal config model section
    if not resolved:
        model_section = cfg.get("model", {})
        base_url = model_section.get("base_url", "")
        
        # Risolvi API key dal provider
        api_key = ""
        if "zai" in provider_name or "z.ai" in provider_name:
            api_key = env_keys.get("GLM_API_KEY", "")
        elif "lmstudio" in provider_name:
            api_key = "lm-studio"
        
        resolved = {
            "model": model_name,
            "base_url": base_url,
            "api_key": api_key,
            "provider": provider_name,
        }
    
    return resolved

_llm_cfg = _resolve_hermes_config()
LLM_MODEL = _llm_cfg["model"]
LLM_BASE_URL = _llm_cfg["base_url"]
LLM_API_KEY = _llm_cfg["api_key"]
LLM_PROVIDER = _llm_cfg["provider"]

# Override via env vars se forniti
LLM_MODEL = os.environ.get("LLM_MODEL", LLM_MODEL)
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", LLM_BASE_URL)
LLM_API_KEY = os.environ.get("LLM_API_KEY", LLM_API_KEY)

client = OpenAI(
    api_key=LLM_API_KEY,
    base_url=LLM_BASE_URL,
)


def _get_active_client() -> tuple[OpenAI, str]:
    """Risolve dinamicamente il modello attivo dal config Hermes.
    
    Così se l'utente cambia modello (es. da qwen3.5 a glm-5.1),
    il phone server segue automaticamente senza restart.
    Ritorna (client_openai, model_name).
    """
    # Env override: se impostato, usa quello
    env_model = os.environ.get("LLM_MODEL")
    env_url = os.environ.get("LLM_BASE_URL")
    env_key = os.environ.get("LLM_API_KEY")
    if env_model and env_url:
        c = OpenAI(api_key=env_key or "dummy", base_url=env_url)
        return c, env_model
    
    # Risolvi dal config fresco
    try:
        cfg = _resolve_hermes_config()
        model = cfg["model"]
        base_url = cfg["base_url"]
        api_key = cfg["api_key"]
        
        # Se è cambiato rispetto al default, crea nuovo client
        if model != LLM_MODEL or base_url != LLM_BASE_URL:
            log.info("🔄 Modello cambiato: %s → %s (provider: %s)", 
                     LLM_MODEL, model, cfg.get("provider", "?"))
            c = OpenAI(api_key=api_key, base_url=base_url)
            return c, model
    except Exception as e:
        log.warning("Config refresh fallito (%s), uso default", e)
    
    return client, LLM_MODEL

# Helper per estrarre testo da chunk streaming — gestisce glm-5.1 che
# a volte mette il testo in reasoning_content invece di content.
def _delta_text(chunk) -> str:
    """Estrae il token di testo da un chunk streaming OpenAI-compatible."""
    if not chunk.choices:
        return ""
    delta = chunk.choices[0].delta
    token = getattr(delta, "content", None) or ""
    if not token:
        token = getattr(delta, "reasoning_content", None) or ""
    return token

# Persona di base per l'agente telefonico
BASE_SYSTEM_PROMPT = (
    "Sei un assistente telefonico intelligente, preciso e ben informato. "
    "Rispondi in modo breve e naturale, come in una conversazione telefonica. "
    "Usa frasi brevi con punteggiatura per aiutare il TTS. "
    "Non usare markdown, liste puntate o formattazione. "
    "Parla come una persona al telefono. "
    "Quando ti vengono forniti risultati di ricerca web, usali per dare risposte "
    "accurate e aggiornate — cita i fatti concreti che trovi. "
    "Pensa passo per passo prima di rispondere a domande complesse. "
    "Se i dati di ricerca non bastano, dillo chiaramente."
)

LANG_SYSTEM_PROMPTS = {
    "it": "Rispondi in italiano.",
    "en": "Respond in English.",
    "hu": "Válaszolj magyarul.",
    "de": "Antworte auf Deutsch.",
    "fr": "Réponds en français.",
    "es": "Responde en español.",
    "pt": "Responde em português.",
    "ja": "日本語で答えてください。",
    "cmn": "请用中文回答。",
    "hi": "हिंदी में उत्तर दें।",
}

# Mappa lingua → voce Kokoro + lang code per il TTS.
# Quando l'LLM rileva un cambio lingua nella conversazione, il phone server
# emette un evento SSE {"voice_change": {"voice": ..., "lang": ...}} prima
# dei chunk di testo, così l'orchestratore cambia voce TTS a runtime.
LANG_VOICE_MAP = {
    "it":    {"voice": "im_nicola",    "lang": "it"},
    "en":    {"voice": "af_heart",     "lang": "en-us"},
    "en-us": {"voice": "af_heart",     "lang": "en-us"},
    "en-gb": {"voice": "bf_emma",      "lang": "en-gb"},
    "fr":    {"voice": "ff_siwis",     "lang": "fr-fr"},
    "es":    {"voice": "ef_dora",      "lang": "es"},
    "pt":    {"voice": "pf_dora",      "lang": "pt-br"},
    "pt-br": {"voice": "pf_dora",      "lang": "pt-br"},
    "ja":    {"voice": "jf_alpha",     "lang": "ja"},
    "cmn":   {"voice": "zf_xiaoxiao",  "lang": "cmn"},
    "hi":    {"voice": "hf_alpha",     "lang": "hi"},
}

# Lingue Kokoro supportate (per rilevamento)
KOKORO_LANGS = {"it", "en", "en-us", "en-gb", "fr", "es", "pt", "pt-br", "ja", "cmn", "hi"}

# Prompt per l'LLM: istruzione di rilevare la lingua dell'utente e rispondere nella stessa lingua
LANG_DETECT_INSTRUCTION = (
    "IMPORTANT: Rileva la lingua in cui l'utente parla e rispondi NELLA STESSA lingua. "
    "Se l'utente cambia lingua durante la conversazione, adattati immediatamente. "
    "Rispondi SEMPRE nella lingua dell'ultimo messaggio dell'utente."
)


def _detect_language(text: str) -> str | None:
    """Euristiche semplici per rilevare la lingua del testo dell'utente.
    
    Ritorna un codice lingua Kokoro (it, en, fr, es, pt, ja, cmn, hi) o None.
    Per lingue non supportate da Kokoro (hu, de, ecc.) ritorna None — non si cambia voce.
    """
    import re
    t = text.lower().strip()
    
    # Caratteri CJK → giapponese o cinese
    cjk = len(re.findall(r'[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]', t))
    hiragana_katakana = len(re.findall(r'[\u3040-\u309f\u30a0-\u30ff]', t))
    devanagari = len(re.findall(r'[\u0900-\u097f]', t))
    
    if devanagari >= 2:
        return "hi"
    if hiragana_katakana >= 2:
        return "ja"
    if cjk >= 2 and hiragana_katakana == 0:
        return "cmn"
    
    # Parole comuni per rilevamento lingue latine
    words = set(re.findall(r'\b[a-zà-ÿ]+\b', t))
    if not words:
        return None
    
    # Score per ogni lingua
    scores = {
        "it": len(words & {"ciao", "come", "stai", "grazie", "bene", "sono", "una", "che",
                           "non", "perché", "anche", "quando", "dove", "cosa", "questo",
                           "buongiorno", "buonasera", "allora", "però", "ancora", "molto",
                           "ho", "hai", "abbiamo", "voglio", "puoi", "devo", "siamo"}),
        "en": len(words & {"hello", "hi", "hey", "how", "are", "you", "the", "is", "what",
                           "thank", "thanks", "please", "good", "morning", "yes", "no",
                           "can", "want", "need", "know", "think", "that", "this", "with",
                           "have", "don't", "do", "does", "will", "would", "should"}),
        "fr": len(words & {"bonjour", "salut", "merci", "oui", "non", "comment", "ça",
                           "bien", "avec", "pour", "dans", "une", "que", "qui", "est",
                           "pas", "vous", "je", "suis", "avoir", "faire"}),
        "es": len(words & {"hola", "gracias", "sí", "cómo", "estás", "bien", "por",
                           "qué", "donde", "cuando", "puedo", "quiero", "necesito",
                           "buenos", "días", "noche", "tengo", "eres", "esto"}),
        "pt": len(words & {"olá", "obrigado", "obrigada", "como", "está", "bem", "sim",
                           "não", "por", "que", "onde", "quando", "posso", "quero",
                           "bom", "dia", "noite", "tenho", "você", "isso"}),
    }
    
    if not any(scores.values()):
        return None
    
    detected = max(scores, key=scores.get)  # type: ignore[arg-type]
    if scores[detected] >= 2:
        return detected
    return None


def _web_search(query: str, max_results: int = 5) -> list[dict]:
    """Cerca sul web usando DuckDuckGo (libreria ddgs). Ritorna lista di {title, snippet, url}.
    
    Silenziosa: se fallisce, ritorna lista vuota (il LLM risponde senza contesto).
    Timeout: 8 secondi per non bloccare la conversazione.
    """
    try:
        from ddgs import DDGS
        results = []
        with DDGS(timeout=8) as ddgs:
            for r in ddgs.text(query, region="wt-wt", max_results=max_results):
                results.append({
                    "title": r.get("title", ""),
                    "snippet": r.get("body", ""),
                    "url": r.get("href", ""),
                })
        log.info("Web search '%s': %d risultati", query[:60], len(results))
        return results
    except ImportError:
        # Fallback alla vecchia libreria se ddgs non è installata
        try:
            from duckduckgo_search import DDGS as _DDGS
            import warnings
            warnings.filterwarnings('ignore', message='.*renamed.*')
            results = []
            with _DDGS(timeout=8) as ddgs:
                for r in ddgs.text(query, region="wt-wt", max_results=max_results):
                    results.append({
                        "title": r.get("title", ""),
                        "snippet": r.get("body", ""),
                        "url": r.get("href", ""),
                    })
            log.info("Web search (fallback) '%s': %d risultati", query[:60], len(results))
            return results
        except Exception as e:
            log.warning("Web search fallita (entrambe le librerie): %s", e)
            return []
    except Exception as e:
        log.warning("Web search fallita: %s", e)
        return []


def _extract_page(url: str, max_chars: int = 1500) -> str:
    """Estrae testo pulito da una pagina web. Timeout 6s, silenziosa se fallisce."""
    try:
        import urllib.request
        import re
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=6) as resp:
            html = resp.read(max_chars * 4).decode("utf-8", errors="ignore")
        # Strip HTML tags
        text = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL|re.IGNORECASE)
        text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL|re.IGNORECASE)
        text = re.sub(r'<[^>]+>', ' ', text)
        text = re.sub(r'\s+', ' ', text).strip()
        return text[:max_chars]
    except Exception:
        return ""


def _get_exchange_rate(from_currency: str, to_currency: str) -> tuple[float | None, str]:
    """Ottiene tasso di cambio in tempo reale da API gratuita.
    
    Ritorna (rate, source_url) o (None, "") se fallisce.
    """
    try:
        import urllib.request
        import json
        url = f'https://open.er-api.com/v6/latest/{from_currency}'
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            rate = data["rates"].get(to_currency)
            if rate:
                return rate, f"{data.get('time_last_update_utc', 'recently')}"
    except Exception as e:
        log.warning("Exchange API fallita: %s", e)
    return None, ""


def _get_crypto_price(symbol: str = "bitcoin") -> tuple[float | None, str]:
    """Ottiene prezzo crypto da CoinGecko.
    
    Ritorna (price_usd, source_url) o (None, "") se fallisce.
    """
    try:
        import urllib.request
        import json
        url = f'https://api.coingecko.com/api/v3/simple/price?ids={symbol}&vs_currencies=usd'
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            if symbol in data and "usd" in data[symbol]:
                return data[symbol]["usd"], "CoinGecko API"
    except Exception as e:
        log.warning("Crypto API fallita: %s", e)
    return None, ""


def _needs_search(text: str) -> bool:
    """Decide se cercare. Approccio aggressivo: cerca per quasi tutto tranne saluti puri.
    
    NON cerca solo per: saluti brevi (< 3 parole senza contenuto informativo).
    """
    t = text.lower().strip()
    words = t.split()
    
    # Solo saluti puri → non cercare
    greetings = {"ciao", "hello", "hi", "hey", "salve", "buongiorno", "buonasera", 
                 "hola", "bonjour", "good morning", "good evening", "thanks", "grazie",
                 "ok", "si", "yes", "no", "bene", "good", "fine", "perfetto"}
    if len(words) <= 3 and all(w in greetings for w in words):
        return False
    
    # Tutto il resto → cerca
    return True


# ---------------------------------------------------------------------------
# Tool definitions per tool-calling (OpenAI-compatible)
# ---------------------------------------------------------------------------
TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Cerca informazioni sul web in tempo reale. Usa SEMPRE questo tool per domande su fatti attuali, persone, eventi, prezzi, notizie, sport, meteo, o qualsiasi informazione che potrebbe essere cambiata di recente.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Termini di ricerca ottimizzati per trovare la risposta"
                    }
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_exchange_rate",
            "description": "Ottiene il tasso di cambio in tempo reale tra due valute. Usa questo per domande su conversioni di valuta.",
            "parameters": {
                "type": "object",
                "properties": {
                    "from_currency": {
                        "type": "string",
                        "description": "Codice valuta di partenza (es. EUR, USD, HUF)"
                    },
                    "to_currency": {
                        "type": "string",
                        "description": "Codice valuta di arrivo (es. EUR, USD, HUF)"
                    }
                },
                "required": ["from_currency", "to_currency"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_crypto_price",
            "description": "Ottiene il prezzo attuale di una criptovaluta. Usa questo per domande su Bitcoin, Ethereum, ecc.",
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {
                        "type": "string",
                        "description": "Nome della criptovaluta (es. bitcoin, ethereum)"
                    }
                },
                "required": ["symbol"]
            }
        }
    },
]


def _execute_tool(name: str, args: dict) -> str:
    """Esegue un tool e ritorna il risultato come stringa JSON."""
    if name == "web_search":
        results = _web_search(args.get("query", ""), max_results=5)
        if not results:
            return json.dumps({"error": "Nessun risultato trovato"}, ensure_ascii=False)
        # Compatta i risultati per non sprecare token
        compact = []
        for r in results[:5]:
            compact.append(f"- {r['title']}: {r['snippet'][:200]}")
        return json.dumps({"results": compact, "count": len(compact)}, ensure_ascii=False)

    elif name == "get_exchange_rate":
        rate, source = _get_exchange_rate(
            args.get("from_currency", "EUR"),
            args.get("to_currency", "USD")
        )
        if rate:
            return json.dumps({"rate": rate, "from": args.get("from_currency"), 
                               "to": args.get("to_currency"), "source": source}, ensure_ascii=False)
        return json.dumps({"error": "Tasso non disponibile"}, ensure_ascii=False)

    elif name == "get_crypto_price":
        price, source = _get_crypto_price(args.get("symbol", "bitcoin"))
        if price:
            return json.dumps({"price_usd": price, "symbol": args.get("symbol"),
                               "source": source}, ensure_ascii=False)
        return json.dumps({"error": "Prezzo non disponibile"}, ensure_ascii=False)

    return json.dumps({"error": f"Tool sconosciuto: {name}"}, ensure_ascii=False)


def _try_tool_calling(session_id: str, text: str, direction: str, 
                      session_lang: str, messages: list, 
                      new_voice_info: dict | None) -> tuple[str, str]:
    """Approccio con tool-calling: il modello decide quando usare i tools.
    
    Ritorna (full_response, tool_log) per logging.
    Se il modello non supporta tool-calling, ritorna ("", "no_tool_support").
    """
    tool_log = ""
    active_client, active_model = _get_active_client()
    
    # glm-5.1: disabilita thinking
    extra = {}
    if "glm" in active_model.lower():
        extra["extra_body"] = {"thinking": {"type": "disabled"}}

    # Prima chiamata: il modello decide se usare i tools
    try:
        response = active_client.chat.completions.create(
            model=active_model,
            messages=messages,
            tools=TOOL_DEFINITIONS,
            tool_choice="auto",
            max_tokens=500,
            temperature=0.7,
            **extra,
        )
    except Exception as e:
        # Il modello potrebbe non supportare tool-calling (es. LM Studio vecchio)
        log.warning("Tool-calling non supportato (%s), fallback a injection", e)
        return "", "no_tool_support"

    msg = response.choices[0].message
    
    # Se non ci sono tool_calls, il modello ha risposto direttamente
    if not msg.tool_calls:
        text = msg.content or getattr(msg, "reasoning_content", None) or ""
        return text, "direct_response"

    # Esegui i tool calls
    messages.append(msg)
    for tc in msg.tool_calls:
        tool_name = tc.function.name
        try:
            tool_args = json.loads(tc.function.arguments)
        except json.JSONDecodeError:
            tool_args = {}
        
        log.info("🔧 Tool call: %s(%s)", tool_name, json.dumps(tool_args, ensure_ascii=False)[:100])
        tool_log += f"  {tool_name}({json.dumps(tool_args, ensure_ascii=False)[:80]})\n"
        
        result = _execute_tool(tool_name, tool_args)
        log.info("📋 Tool result: %s", result[:200])
        tool_log += f"    → {result[:150]}\n"
        
        messages.append({
            "role": "tool",
            "tool_call_id": tc.id,
            "content": result,
        })

    # Seconda chiamata: il modello risponde usando i risultati dei tools
    try:
        response2 = active_client.chat.completions.create(
            model=active_model,
            messages=messages,
            max_tokens=300,
            temperature=0.7,
            **extra,
        )
        final = response2.choices[0].message
        text = final.content or getattr(final, "reasoning_content", None) or ""
        return text, tool_log
    except Exception as e:
        log.error("Seconda chiamata LLM fallita: %s", e)
        return f"[Errore nella generazione della risposta]", tool_log


def _parse_tool_request(text: str) -> list[tuple[str, dict]] | None:
    """Parsea [TOOL_REQUEST]...[END_TOOL_REQUEST] dal testo generato dal modello.
    
    Il modello qwen3.5 su LM Studio non supporta tool-calling nativo ma genera
    testo con formato: [TOOL_REQUEST]{"name":"web_search","arguments":{"query":"..."}}[END_TOOL_REQUEST]
    
    Ritorna lista di (tool_name, tool_args) o None se non trovato.
    """
    import re
    pattern = r'\[TOOL_REQUEST\]\s*(\{.*?\})\s*\[END_TOOL_REQUEST\]'
    matches = re.findall(pattern, text, re.DOTALL)
    if not matches:
        return None
    
    tools = []
    for m in matches:
        try:
            data = json.loads(m)
            name = data.get("name", "")
            args = data.get("arguments", {})
            if name:
                tools.append((name, args))
        except json.JSONDecodeError:
            continue
    return tools if tools else None


def _try_text_tool_calling(session_id: str, text: str, direction: str,
                           session_lang: str, messages: list,
                           new_voice_info: dict | None) -> tuple[str, str]:
    """STRATEGIA 1.5: Streaming → intercetta [TOOL_REQUEST] nel testo.
    
    Per modelli (es. qwen3.5 su LM Studio) che non supportano tool-calling
    nativo ma generano testo con [TOOL_REQUEST]...[END_TOOL_REQUEST].
    
    Ritorna (full_response, tool_log).
    Se non trova tool requests, ritorna ("", "no_text_tools").
    """
    active_client, active_model = _get_active_client()
    extra = {}
    if "glm" in active_model.lower():
        extra["extra_body"] = {"thinking": {"type": "disabled"}}

    # Chiamata streaming: raccogli tutto il testo
    full_text = ""
    try:
        stream = active_client.chat.completions.create(
            model=active_model,
            messages=messages,
            tools=TOOL_DEFINITIONS,
            tool_choice="auto",
            stream=True,
            max_tokens=500,
            temperature=0.7,
            **extra,
        )
        for chunk in stream:
            t = _delta_text(chunk)
            if t:
                full_text += t
    except Exception as e:
        # Se fallisce con tools, riprova senza
        try:
            stream = active_client.chat.completions.create(
                model=active_model,
                messages=messages,
                stream=True,
                max_tokens=500,
                temperature=0.7,
                **extra,
            )
            for chunk in stream:
                t = _delta_text(chunk)
                if t:
                    full_text += t
        except Exception as e2:
            log.error("Streaming fallito: %s", e2)
            return "", "no_text_tools"

    # Cerca [TOOL_REQUEST] nel testo
    tool_requests = _parse_tool_request(full_text)
    if not tool_requests:
        # Nessun tool request — restituisci il testo pulito
        clean = full_text.replace("[TOOL_REQUEST]", "").replace("[END_TOOL_REQUEST]", "")
        return clean.strip(), "no_text_tools"

    tool_log = ""
    # Esegui i tool requests
    tool_results = []
    for tool_name, tool_args in tool_requests:
        log.info("🔧 Text tool: %s(%s)", tool_name, json.dumps(tool_args, ensure_ascii=False)[:100])
        tool_log += f"  {tool_name}({json.dumps(tool_args, ensure_ascii=False)[:80]})\n"
        
        result = _execute_tool(tool_name, tool_args)
        log.info("📋 Tool result: %s", result[:200])
        tool_log += f"    → {result[:150]}\n"
        tool_results.append(result)

    # Seconda chiamata con i risultati dei tools come contesto
    context_msg = "Ecco i risultati della ricerca:\n\n"
    for i, result in enumerate(tool_results, 1):
        context_msg += f"--- Risultato {i} ---\n{result}\n\n"
    context_msg += (
        "Ora rispondi alla domanda dell'utente usando ESCLUSIVAMENTE questi dati. "
        "Sii breve, naturale, come al telefono. Non dire 'secondo i risultati della ricerca' — "
        "rispondi direttamente con i fatti."
    )

    # Nuovo messaggio con contesto
    messages_with_ctx = list(messages)
    messages_with_ctx.append({"role": "assistant", "content": f"[Ho cercato informazioni su: {text}]"})
    messages_with_ctx.append({"role": "user", "content": context_msg})

    # Chiamata finale per la risposta
    full_response = ""
    try:
        stream2 = active_client.chat.completions.create(
            model=active_model,
            messages=messages_with_ctx,
            stream=True,
            max_tokens=300,
            temperature=0.7,
            **extra,
        )
        for chunk in stream2:
            t = _delta_text(chunk)
            if t:
                full_response += t
    except Exception as e:
        log.error("Seconda chiamata streaming fallita: %s", e)
        return "[Errore nella generazione]", tool_log

    return full_response, tool_log


def llm_respond(session_id: str, text: str, direction: str) -> Iterator[str]:
    """Chiama il LLM con tool-calling e yielda ogni token.
    
    FLUSSO:
    1. Prova tool-calling (il modello chiama web_search/exchange/crypto se serve)
    2. Se tool-calling non supportato → fallback a injection nel system prompt
    3. Se il modello non chiama tools → usa pre-search injection forzata
    
    Se il testo dell'utente è in una lingua diversa dalla sessione corrente,
    emette un evento SSE {"voice_change": {"voice": ..., "lang": ...}} prima
    dei chunk di testo, così l'orchestratore cambia voce TTS a runtime.
    """
    session = SESSIONS.get(session_id, {})
    session_lang = session.get("lang", "it")
    
    # Rileva la lingua del testo dell'utente
    detected_lang = _detect_language(text)
    
    # Se la lingua rilevata è diversa da quella della sessione ed è supportata da Kokoro
    new_voice_info = None
    if detected_lang and detected_lang != session_lang and detected_lang in LANG_VOICE_MAP:
        new_voice_info = LANG_VOICE_MAP[detected_lang]
        if session_id in SESSIONS:
            SESSIONS[session_id]["lang"] = detected_lang
        session_lang = detected_lang
        log.info("🌐 Lingua cambiata: %s → voce %s (session=%s)", 
                 detected_lang, new_voice_info["voice"], session_id)
    
    # System prompt
    lang_prompt = LANG_SYSTEM_PROMPTS.get(session_lang, f"Respond in {session_lang}.")
    system_prompt = BASE_SYSTEM_PROMPT + " " + LANG_DETECT_INSTRUCTION + " " + lang_prompt

    history = session.get("history", [])
    messages = [{"role": "system", "content": system_prompt}]
    for msg in history[-20:]:
        messages.append({"role": msg["role"], "content": msg["content"]})
    messages.append({"role": "user", "content": text})

    log.info("LLM request: session=%s, text='%s', lang=%s, history=%d msgs",
             session_id, text[:80], session_lang, len(history))

    # Se serve cambio voce, emetti l'evento PRIMA dei chunk
    if new_voice_info:
        yield json.dumps({"voice_change": new_voice_info})

    # ---------------------------------------------------------------
    # STRATEGIA 1: Tool-calling nativo (OpenAI-compatible)
    # ---------------------------------------------------------------
    full_response, tool_log = _try_tool_calling(
        session_id, text, direction, session_lang, 
        list(messages), new_voice_info
    )

    if full_response and tool_log not in ("no_tool_support",):
        if tool_log == "direct_response":
            # Il modello ha risposto senza usare tools — ok
            log.info("📤 Direct response (no tools needed): '%s' (%d chars)", 
                     full_response[:80], len(full_response))
        else:
            log.info("✅ Tool-calling riuscito:%s", tool_log)
        yield full_response
        if session_id in SESSIONS:
            SESSIONS[session_id].setdefault("history", []).extend([
                {"role": "user", "content": text},
                {"role": "assistant", "content": full_response},
            ])
        return

    # ---------------------------------------------------------------
    # STRATEGIA 1.5: Text-based tool calling ([TOOL_REQUEST])
    # Per qwen3.5 su LM Studio che genera [TOOL_REQUEST] nel testo
    # ---------------------------------------------------------------
    full_response, tool_log = _try_text_tool_calling(
        session_id, text, direction, session_lang,
        list(messages), new_voice_info
    )

    if full_response and tool_log != "no_text_tools":
        log.info("✅ Text tool-calling riuscito:%s", tool_log)
        yield full_response
        if session_id in SESSIONS:
            SESSIONS[session_id].setdefault("history", []).extend([
                {"role": "user", "content": text},
                {"role": "assistant", "content": full_response},
            ])
        return

    # ---------------------------------------------------------------
    # STRATEGIA 2: Pre-search injection forzata (fallback)
    # Il modello non supporta tool-calling → iniettiamo i risultati
    # ---------------------------------------------------------------
    log.info("⚠️ Fallback a pre-search injection")
    search_context = ""
    if _needs_search(text):
        search_results = _web_search(text)
        
        t_lower = text.lower()
        exchange_rate, exchange_source = None, ""
        crypto_price, crypto_source = None, ""
        
        if any(k in t_lower for k in ["euro", "forint", "huf", "tasso", "cambio"]):
            rate, source = _get_exchange_rate("EUR", "HUF")
            exchange_rate, exchange_source = rate, source
        if any(k in t_lower for k in ["bitcoin", "btc", "cripto", "crypto"]):
            price, source = _get_crypto_price("bitcoin")
            crypto_price, crypto_source = price, source
        
        if search_results or exchange_rate or crypto_price:
            search_context = "\n\n=== RISULTATI RICERCA WEB IN TEMPO REALE ===\n"
            if exchange_rate:
                search_context += f"• Tasso EUR/HUF: {exchange_rate:.2f} ({exchange_source})\n"
            if crypto_price:
                search_context += f"• Bitcoin: ${crypto_price:,.2f} USD ({crypto_source})\n"
            for i, r in enumerate(search_results, 1):
                search_context += f"[{i}] {r['title']}\n    {r['snippet']}\n"
            if search_results and search_results[0].get("url"):
                page_text = _extract_page(search_results[0]["url"])
                if page_text and len(page_text) > 100:
                    search_context += f"\n--- PAGINA ---\n{page_text}\n--- FINE ---\n"
            search_context += "\n=== FINE RISULTATI ===\n"
            search_context += "REGOLA OBBLIGATORIA: Usa ESCLUSIVAMENTE i dati qui sopra per rispondere. Non inventare numeri o fatti."

    final_system = system_prompt + search_context
    messages[0] = {"role": "system", "content": final_system}

    full_response = ""
    try:
        fb_client, fb_model = _get_active_client()
        extra = {}
        if "glm" in fb_model.lower():
            extra["extra_body"] = {"thinking": {"type": "disabled"}}

        stream = fb_client.chat.completions.create(
            model=fb_model,
            messages=messages,
            stream=True,
            max_tokens=300,
            temperature=0.7,
            **extra,
        )
        for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            # glm-5.1 (Z.AI) puo' mettere il testo in reasoning_content invece di content
            # anche con thinking=disabled. Fallback: se content è vuoto, usa reasoning_content.
            token = getattr(delta, "content", None) or ""
            if not token:
                token = getattr(delta, "reasoning_content", None) or ""
            if token:
                full_response += token
                yield token
    except Exception as e:
        log.error("LLM error: %s", e)
        yield f"[Errore: {e}]"

    # Aggiorna storico
    if session_id in SESSIONS:
        SESSIONS[session_id].setdefault("history", []).extend([
            {"role": "user", "content": text},
            {"role": "assistant", "content": full_response},
        ])


# Punto di hook — default al LLM
RESPOND_FN = llm_respond


# ---------------------------------------------------------------------------
# Server Flask
# ---------------------------------------------------------------------------
def create_app() -> Flask:
    app = Flask(__name__)

    @app.get("/health")
    def health():
        _, active_model = _get_active_client()
        return jsonify({"status": "ok", "sessions": len(SESSIONS),
                        "model": active_model, "default_model": LLM_MODEL})

    @app.post("/incoming-call")
    def incoming_call():
        body = request.get_json(silent=True) or {}
        sid = body.get("session_id")
        if not sid:
            return jsonify({"error": "session_id missing"}), 400
        SESSIONS[sid] = {
            "direction": "INCOMING",
            "number": body.get("number", ""),
            "voice": body.get("voice", ""),
            "lang": body.get("lang", "it"),
            "started_at": time.time(),
            "history": [],
        }
        log.info("📞 INCOMING session=%s from=%s lang=%s voice=%s",
                 sid, body.get("number"), body.get("lang"), body.get("voice"))
        return jsonify({"status": "ready"})

    @app.post("/outgoing-call")
    def outgoing_call():
        body = request.get_json(silent=True) or {}
        sid = body.get("session_id")
        if not sid:
            return jsonify({"error": "session_id missing"}), 400
        SESSIONS[sid] = {
            "direction": "OUTGOING",
            "number": body.get("number", ""),
            "voice": body.get("voice", ""),
            "lang": body.get("lang", "it"),
            "started_at": time.time(),
            "history": [],
        }
        log.info("📞 OUTGOING session=%s to=%s lang=%s voice=%s",
                 sid, body.get("number"), body.get("lang"), body.get("voice"))
        return jsonify({"status": "ready"})

    @app.post("/utterance")
    def utterance():
        body = request.get_json(silent=True) or {}
        sid = body.get("session_id", "")
        text = (body.get("text") or "").strip()
        direction = body.get("direction", "")
        if not text:
            return jsonify({"error": "text empty"}), 400
        if sid not in SESSIONS:
            log.warning("utterance per session sconosciuta: %s — creo al volo", sid)
            SESSIONS[sid] = {"direction": direction, "history": [], "lang": "it"}

        log.info("💬 utterance session=%s direction=%s: '%s'",
                 sid, direction, text[:100])

        def stream() -> Iterator[bytes]:
            full = ""
            try:
                for chunk in RESPOND_FN(sid, text, direction):
                    # Se il chunk è un JSON con metadati (voice_change, ecc.),
                    # inoltralo come evento SSE speciale — NON è testo parlato.
                    if chunk.startswith("{") and chunk.endswith("}"):
                        try:
                            meta = json.loads(chunk)
                            if "voice_change" in meta:
                                yield _sse(meta)
                                log.info("🔊 voice_change emesso: %s", meta["voice_change"])
                                continue
                        except json.JSONDecodeError:
                            pass  # non era JSON, tratta come testo normale
                    
                    full += chunk
                    yield _sse({"chunk": chunk})
            except Exception as e:
                log.error("RESPOND_FN error: %s", e)
                yield _sse({"error": str(e)})
            yield _sse({"done": True})
            log.info("📤 response session=%s: '%s' (%d chars)",
                     sid, full[:80], len(full))

        return Response(stream(), mimetype="text/event-stream")

    @app.post("/call-ended")
    def call_ended():
        body = request.get_json(silent=True) or {}
        sid = body.get("session_id", "")
        sess = SESSIONS.pop(sid, None)
        turns = len(sess.get("history", [])) // 2 if sess else 0
        log.info("📴 call-ended session=%s (%d turni)", sid, turns)
        return jsonify({"status": "ok"})

    @app.get("/sessions")
    def sessions():
        return jsonify({
            k: {"lang": v.get("lang", ""), "turns": len(v.get("history", [])) // 2,
                "direction": v.get("direction", ""), "number": v.get("number", "")}
            for k, v in SESSIONS.items()
        })

    return app


def _sse(payload: dict) -> bytes:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)-18s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )
    parser = argparse.ArgumentParser(
        description="Hermes Phone Call Server — il cervello di callAPIcall"
    )
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8780)
    args = parser.parse_args()

    app = create_app()
    log.info("📞 Hermes Phone Server in ascolto su http://%s:%d", args.host, args.port)
    log.info("🧠 Modello: %s @ %s", LLM_MODEL, LLM_BASE_URL)
    log.info("🔌 Endpoint: /health /incoming-call /outgoing-call /utterance /call-ended /sessions")
    app.run(host=args.host, port=args.port, threaded=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
