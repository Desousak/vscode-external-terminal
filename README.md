# Remote Shell Here

Open a terminal in the current VS Code folder. Also supports opening and connecting to remote SSH workspaces.

## Requirements

- macOS
- Visual Studio Code 1.85 or later

## Usage

Run **Remote Shell: Open Here** from the Command Palette, or use `Cmd+Alt+\``.

## Settings

**`remoteShellHere.app`** selects the terminal application:

- `terminal` (default)
- `iterm`

**`remoteShellHere.sshCommand`** configures the command to run on the remote host.

Useful for starting or attaching to a tmux session. E.g.

```json
"remoteShellHere.sshCommand": "tmux new-session -A -s vscode"
```