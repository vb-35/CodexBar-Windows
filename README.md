# CodexBar for Windows

<img src="assets/icon.png" width="128" alt="CodexBar icon">

An unofficial Windows system-tray simpler port of [CodexBar](https://github.com/steipete/CodexBar) for viewing Codex usage limits.

## Features

- Codex usage windows, reset times, account switching, and local session history.
- Claude subscription usage windows, including Sonnet and Opus limits, with separate account switching and local token/cost history.
- Add, import, select, re-authenticate, remove, and make CLI accounts for both providers. Both have tray account menus and dashboard shortcuts.
- Compact account initials in the header; hover to see the account email.
- Start subscription clocks for one account or all accounts, skipping clocks that are already running.
- Optional Codex and Claude remote history over SSH without installing a helper or downloading session files.

The clock button beside Refresh checks all saved accounts and starts idle clocks one at a time. The clock button in the bottom account actions starts the selected account; Settings also has a button on each account. Each activation sends `Reply OK.` through an isolated interactive CLI using GPT-6-Luna with low reasoning or Claude Haiku 5.5 with low effort. This uses a small amount of subscription usage and requires an installed, authenticated CLI. The system login stays unchanged, and failures are reported per account.

## Linux clock starter

`scripts/linux/install-clocks.sh` installs a headless version of the clock button on an Ubuntu machine. Every day at 07:00 and 12:30 (machine local time) it checks the default Codex (`~/.codex/auth.json`) and Claude Code (`~/.claude/.credentials.json`) subscription login of root and every regular user, and starts idle clocks the same way the tray app does.

```sh
git clone <this repository> && cd CodexBar-Windows
sudo bash scripts/linux/install-clocks.sh            # pins the latest CLI versions
sudo bash scripts/linux/install-clocks.sh --claude-version <version> --codex-version <version>   # or pin explicitly
```

The installer needs Node.js 22 or newer installed system-wide, and it installs `build-essential` if node-pty has to be compiled. It installs to `/opt/codexbar-clocks` and enables `codexbar-clocks.timer`. Use `node /opt/codexbar-clocks/dist/main/linux-clocks.js --dry-run [--user <name>]` to list the logins it would use, and `journalctl -u codexbar-clocks.service` to see results.

- **Users' logins stay as they are.** Each user is handled by a worker running as that user, so root never reads or writes their files. The worker copies the login into a private temporary profile and runs the CLI with a throwaway `HOME`. Tokens the CLI renews are written back only when the user's login file is unchanged since the copy, so a switch or re-login during the run always wins.
- **Pinned CLIs.** The script uses its own copies in `/opt/codexbar-clocks/cli`, with self-updates disabled, so user installs and CLI updates cannot change its behavior. Re-run the installer to move to newer versions.
- **Opt-out.** A user can create `~/.codexbar-no-clock` to be skipped.
- **Uninstall.** Run `sudo systemctl disable --now codexbar-clocks.timer`, remove `/etc/systemd/system/codexbar-clocks.*` and `/opt/codexbar-clocks`, then run `sudo systemctl daemon-reload`.

## Privacy and credentials

CodexBar has no telemetry. Codex requests are sent directly to OpenAI endpoints.
Claude requests are sent directly to Anthropic endpoints. Sign in using **Add Account** (requires Claude Code),
or import a Claude Code `.credentials.json` through the Claude tab or Settings → Claude Accounts.

- Existing Codex credentials are read from `~/.codex/auth.json`.
- Managed Codex accounts are copied to `~/.codexbar/codex-accounts/` so the Codex CLI can use them.
- Removing a managed account deletes its directory under `~/.codexbar/codex-accounts/`.
- Account tabs only change the account viewed in CodexBar. Cached usage appears immediately while fresh data loads in the background.
- **Make Codex CLI Account** closes and reopens a running Codex Desktop after confirmation. Settings → Codex Accounts also offers separate, disabled-by-default options to stop native Windows Codex backends in VS Code and T3 Code while leaving the apps open. This interrupts active Codex work. Reload the VS Code window (**Developer: Reload Window**) or restart the T3 Code Codex session afterward if it does not reconnect; CodexBar cannot recreate the host's private backend connection. If a backend keeps respawning, the switch is canceled. WSL and remote backends are not stopped. Clients with a separate Codex home, credential store, or T3 Code managed sign-in keep their own login.
- Existing Claude Code credentials are read from `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR`).
- Managed Claude credentials are stored in `~/.codexbar/claude-accounts/`. CodexBar renews these private copies; Claude Code owns renewal of the ambient system login. Removing an account deletes only its managed directory.
- **Make Claude Code CLI Account** replaces the local CLI credentials and account metadata, preserves unrelated CLI settings, and saves the previous login as a managed account. With remote history configured, it also copies those credentials and account metadata to the remote Claude home over SSH. Restart running local and remote Claude Code sessions afterward. An SSH failure is reported while keeping the successful local switch.
- Claude history reads `projects/**/*.jsonl` in the selected account's CLI directory, including subagent transcripts. Repeated streaming messages and fork copies are counted once. History belongs to that directory and may include other logins; selecting a private account does not attach the ambient directory's history to it.
- Claude costs are standard API-equivalent estimates using bundled [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) verified on October 8, 2026, including cache reads and five-minute/one-hour cache writes. They are not subscription charges. Unknown model prices are shown as unavailable or partially unpriced.
- When remote history is configured, **Make CLI Account** also updates that provider's remote login. Codex selects file-based storage and replaces `auth.json`; Claude replaces `.credentials.json` and updates `oauthAccount` in `.claude.json` while preserving unrelated settings. For the default `~/.claude` home, the profile is `~/.claude.json`; custom homes keep it inside that directory. Original remote auth and config/profile files are preserved once with `.codexbar-backup` suffixes. Claude writes credentials and backups with owner-only permissions and attempts to restore both files if replacement fails.
- Remote history uses the system `ssh` client, your existing SSH config/keys, and Python 3 on the remote host. The bundled calculator is piped to Python over SSH and returns only aggregate JSON; it is not stored remotely.

Configure an SSH alias or `user@host` and the remote Codex and Claude homes in Settings (defaults: `~/.codex` and `~/.claude`). Remote Claude history uses the remote transcript directory and reports connection failures without hiding local totals. Leave the SSH target blank to disable remote history.

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
