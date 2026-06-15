# Gorom Moshla

**The Deterministic AI Execution Engine for VS Code.**

Gorom Moshla is a next-generation AI coding assistant that executes your commands safely, deterministically, and with full rollback capabilities.

## Features

- **Multi-layer Code Intelligence:** Understands your codebase through Repo Indexing, Native LSP definitions, and AST summarization.
- **Deterministic Orchestrator:** Uses a strict state-machine execution kernel to prevent AI hallucinations and infinite loops.
- **Rollback System:** Automatically snapshots files before any AI edits, allowing instant recovery if anything goes wrong.
- **Native VS Code Diff Viewer:** Never blindly applies code. Reviews patches via `vscode.diff` before execution.
- **Real-time Streaming:** Smooth, buffer-controlled streaming directly into the natively-styled Sidebar Chat.

## Setup

1. Open the Gorom Moshla sidebar icon in the VS Code Activity Bar.
2. In VS Code Settings (`Preferences: Open Settings (UI)`), search for `Gorom Moshla`.
3. Set your preferred `aiProvider` (e.g. `groq`, `gemini`, `openrouter`, `huggingface`).
4. Enter your `apiKey`.
5. Start chatting!
