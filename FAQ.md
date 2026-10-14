# FAQ

Plain-English answers. For the actual legal terms, read [LICENSE.md](LICENSE.md). This page is a summary, not a substitute; if the two ever disagree, the license wins.

### Can I use this?

Yes, for personal and noncommercial purposes: learning, research, running it on your own machine, hobby projects. That's what the [PolyForm Noncommercial License 1.0.0](LICENSE.md) grants.

### Can I use it at work, build a product on it, or resell it?

No. The license covers noncommercial use only. Business use, commercial products, paid services and resale are not granted here. Nothing in this repository grants different terms.

### Is it free? Who pays for the AI?

Wire itself is free to use under the license. The AI it calls is yours:
- **Ollama models** run locally and cost nothing.
- **`claude`, `codex`, `agy`** run under your own logins and plans.
- **Gemini or Groq** use your own API keys, if you add them.

Any charges from those providers are yours, and so is following their terms of service.

### Whose API keys does it use?

Yours, and only if you add them. Wire ships with no credentials, and it never passes one vendor's key to another vendor's tool.

### Is it safe to run? What does it do on my machine?

- Every shell command is shown to you exactly as it will run, and waits for your `y`.
- Without a terminal, shell commands are refused.
- Files are written only inside your projects' allowed folders, never through links.
- The optional gateway listens on `127.0.0.1` only.

[SECURITY.md](SECURITY.md) has the full threat model. Even so, the software comes with **no warranty of any kind**, and you use it at your own risk. Read the code before relying on it.

### Is any of this financial, legal or professional advice?

No. Wire passes your requests to AI models. Their answers can be wrong, and nothing Wire or a model produces is advice of any kind.

### Does it send my data anywhere?

Only where you send it:
- requests to the AI providers you chose;
- `fetch`, `weather` and live search;
- the release check in `wire version`.

There is no telemetry. Memory, documents and logs stay in local files.

### Is this maintained? Will pull requests be reviewed?

It's a personal project shared publicly. Issues are welcome, but fixes and reviews aren't guaranteed; see [CONTRIBUTING.md](CONTRIBUTING.md).

### I cloned TheWire before 1.1.0 and `wire update` fails.

Clone it again once. Starting with 1.1.0, the public repository holds clean release snapshots, one commit per release, so an older clone can't fast-forward. Later releases update normally.

### I found a security issue. What do I do?

Don't open a public issue. Use GitHub's private vulnerability reporting on this repository.

### Why "TheWire" here but "Wire" in the code?

"TheWire" is the repository's public name. The software calls itself Wire, and the command is `wire`.
