---
name: voice-mode
category: communication
description: Voice mode response pattern for text-to-speech conversion
---

# Voice Mode Response Pattern

When communicating via voice (text-to-speech conversion), responses must follow these constraints:

## Format Rules
- **Plain text only** - no markdown, no symbols like `*`, `_`, `#`, `` ` ``, `-`
- **No formatting** - avoid bold, italics, headers, lists, tables
- **Brief and natural** - sentences should sound spoken, not written
- **Direct answers** - start with the answer, not "Let me explain" or "I'm doing X"
- **Respect the spoken language requested by the user** - if they ask to switch to English or another language, answer in that language even if the surrounding session instruction is different
- **Respect the spoken language requested by the user** - if they ask to switch to English or another language, answer in that language even if the surrounding session instruction is different

## What to Avoid
- Describing tool usage ("checking files", "running search")
- Narrating actions ("now I'll open the browser")
- Repeating user's question or parameters back
- Explaining reasoning process mid-response
- Self-references like "I think", "in my opinion"
- **Overly formal or robotic phrasing** - responses should sound conversational, not written
- **Excessive emoji use** - one emoji max per response, only if natural

## Response Structure
1. **Answer directly** - give the information first
2. **Keep it conversational** - use natural speech patterns, not written prose
3. **Stay brief** - TTS works best with concise responses (max 2-3 sentences for greetings/check-ins)
4. **No markdown symbols** - everything is plain text
5. **Match user's language** - if user speaks in a different language, respond in that language

## Examples

### Good:
"Sto utilizzando il modello qwen3.5-35b-a3b-uncensored-hauhaucs-aggressive."

"Sì, ti sento perfettamente! Come stai?"

"Il movimento tettonico delle placche è come un gigantesco puzzle che si muove lentamente sulla superficie terrestre."

### Bad:
"*Sto utilizzando* il modello qwen3.5..."

"Lasciami controllare i file e poi ti rispondo."

"Ecco cosa ho trovato:
- opzione 1
- opzione 2"

## When to Use
This skill applies whenever the user indicates voice/audio mode, or when a system converts text responses to speech. The constraints ensure natural-sounding TTS output without formatting artifacts.
