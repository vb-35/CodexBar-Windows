# CodexBar for Windows

<img src="assets/icon.png" width="128" alt="CodexBar icon">

An unofficial Windows system-tray port of [CodexBar](https://github.com/steipete/CodexBar) for viewing Codex usage limits.

## Features

- Codex usage windows, reset times, account switching, and local session history.
- Optional remote history over SSH without installing a helper or downloading session files.

## Privacy and credentials

CodexBar has no telemetry. Codex requests are sent directly to OpenAI and ChatGPT endpoints.

- Existing Codex credentials are read from `~/.codex/auth.json`.
- Managed Codex accounts are copied to `~/.codexbar/codex-accounts/` so the Codex CLI can use them.
- Removing a managed account deletes its directory under `~/.codexbar/codex-accounts/`.
- Remote history uses the system `ssh` client, your existing SSH config/keys, and Python 3 on the remote host. The bundled calculator is piped to Python over SSH and returns only aggregate JSON; it is not stored remotely.

Configure an SSH alias or `user@host` and the remote Codex home in Settings. Leave the SSH target blank to disable remote history.

Do not use the application on a shared Windows account unless you accept that local credential-storage model.

## Development

Requires Node.js 22 or newer and npm.

```powershell
npm ci
npm test
npm run dev
```

Build the Windows installer with:

```powershell
npm run build
npm run package
```

Installer output is written to `out/`.

## License

MIT. Derived from [CodexBar](https://github.com/steipete/CodexBar) by Peter Steinberger; see [LICENSE](LICENSE).
