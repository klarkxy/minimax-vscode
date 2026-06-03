---
name: minimax-cli
description: Multimodal MiniMax Token Plan capabilities via the official `mmx` CLI — text chat, image, video, music, speech synthesis, vision, and web search. Use this skill whenever the user wants to generate images / video / audio, transcribe, or perform web search with the same Token Plan API key already configured for MiniMax Copilot.
---

# minimax-cli (mmx)

A single CLI that exposes the full MiniMax Token Plan surface (text,
image, video, music, speech, vision, web search). Generated files
land in the current directory's `minimax-output/` folder.

The CLI is installed with `npm install -g mmx-cli`. The user's API
key is configured with `mmx auth login --api-key <key>` and the
quota can be inspected with `mmx quota`.

## When to use this skill

Use `mmx` whenever the user asks for any of the following and the
answer involves generating media, running web search, or
transcribing audio:

- "Generate an image / picture / poster of …"
- "Make a video of …"
- "Compose a song about …"
- "Read this text aloud" / "speak this with voice X"
- "What's in this image?" (use `mmx vision describe`)
- "Search the web for …" (use `mmx search query`)
- "How much quota do I have left?" (use `mmx quota`)

Prefer the dedicated subcommand over `mmx text chat` when the user
explicitly wants a non-text modality — the subcommands carry
modality-specific flags (aspect ratio, voice id, duration, etc.) that
the generic chat does not.

## Quick reference

| Modality | Command |
| --- | --- |
| Text chat | `mmx text chat --prompt "..."` |
| Image generation | `mmx image generate --prompt "..." --aspect 16:9` |
| Video generation (async) | `mmx video generate --prompt "..."` |
| Music generation | `mmx music generate --prompt "..." [--lyrics "..."]` |
| Speech synthesis (TTS) | `mmx speech synthesize --text "..." --voice <id>` |
| Vision (image → text) | `mmx vision describe --image <path-or-url>` |
| Web search | `mmx search query --q "..."` |
| Quota / plan | `mmx quota` |
| Auth status | `mmx auth status` |

Run `mmx <subcommand> --help` for the full flag list. Generated files
are written to `./minimax-output/`.

## Operational notes

- The CLI must be installed (`npm install -g mmx-cli`) and the user
  must be logged in (`mmx auth login --api-key <key>`) before any of
  the subcommands will work. If the user has not done so, walk them
  through the install steps and then retry the call.
- `mmx video generate` returns a task id; use the follow-up task
  query / download command from `--help` to wait for the result.
- Generated media is local — show the user the file path or open it
  in the editor rather than dumping base64.
- If a subcommand fails with `401 Unauthorized`, the key is
  mismatched against the configured region. Set `region` explicitly:

  ```bash
  mmx config set --key region --value cn       # mainland China key
  mmx config set --key region --value global   # international key
  ```
