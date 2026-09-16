import * as path from 'path';
import * as vscode from 'vscode';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

// Async version of execFile
const execFileAsync = promisify(execFile);

/**
 * Formats the error into a readable string
 * @param error Error to format
 * @returns Formatted error string
 */
function formatError(error: unknown): string {
  const details = error instanceof Error ? error.message : String(error);
  const standardError =
    typeof error === 'object' && error !== null && 'stderr' in error
      ? String(error.stderr)
      : '';
  return standardError ? `${details}\n${standardError}` : details;
}

/**
 * Preps a string for use in a terminal by escaping single quotes
 * @param value Value to prep
 * @returns Prepped string
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

/**
 * Creates a command to launch a ssh session in a terminal
 * @param remoteHost The remote host to connect to
 * @param folderPath The folder path to navigate to on the remote host
 * @returns The command string to launch the SSH session
 */
function createRemoteLaunchCmd(remoteHost: string, folderPath: string): string {
  const remoteCommand =
    `cd -- ${shellQuote(folderPath)} && ` + `exec "\${SHELL:-/bin/zsh}" -l`;
  return `exec ssh -tt -o ClearAllForwardings=yes ${shellQuote(remoteHost)} ${shellQuote(remoteCommand)}`;
}

/**
 * Grab the terminal type from config
 * @returns The terminal type, either 'terminal' or 'iterm'
 */
function getTermType(): 'terminal' | 'iterm' {
  const config = vscode.workspace.getConfiguration('externalTerminalHere');
  return config.get('app', 'terminal');
}

/**
 * Runs a command within the chosen external terminal
 * @param command Command to run
 */
async function runAppleScript(command: string): Promise<void> {
  const termType = getTermType();

  // Determine which AppleScript to run based on the terminal type
  const script =
    termType === 'iterm'
      ? `
on run argv
    tell application "iTerm"
        activate
        set shellCommand to "/bin/zsh -lc " & quoted form of (item 1 of argv)
        create window with default profile command shellCommand
    end tell
end run
`
      : `
on run argv
    tell application "Terminal"
        activate
        do script "/bin/zsh -lc " & quoted form of (item 1 of argv)
    end tell
end run
`;

  const args = ['-e', script, command];
  await execFileAsync('osascript', args);
}

/**
 * Get the remote host from a VS Code URI
 * @param uri URI provided from the vscode editor or workspace
 * @returns The remote host if available, otherwise undefined
 */
function getRemoteHost(uri: vscode.Uri): string | void {
  // Check if we're using a remote SSH connection
  const prefix = 'ssh-remote+';
  if (uri.scheme !== 'vscode-remote' || !uri.authority.startsWith(prefix))
    return undefined;

  // Get the actual connection string
  const authority = decodeURIComponent(uri.authority.slice(prefix.length));
  const regex = /^[0-9a-f]+$/i;
  if (regex.test(authority) && authority.length % 2 == 0) {
    try {
      const serializedConn = Buffer.from(authority, 'hex').toString('utf8');
      const conn: unknown = JSON.parse(serializedConn);
      // Check if the parsed connection object has a valid hostName property
      if (
        typeof conn === 'object' &&
        conn !== null &&
        'hostName' in conn &&
        typeof conn.hostName === 'string' &&
        conn.hostName
      ) {
        // Try to resolve the user used, if any
        const user =
          ('user' in conn && typeof conn.user === 'string' && conn.user) ||
          ('userName' in conn &&
            typeof conn.userName === 'string' &&
            conn.userName) ||
          ('username' in conn &&
            typeof conn.username === 'string' &&
            conn.username);
        return user ? `${user}@${conn.hostName}` : conn.hostName;
      }
    } catch {}
  }

  return authority;
}

/**
 * Checks if a path is within the given workspace folder.
 * @param uri The URI of the file or folder to check.
 * @param folder The workspace folder to check against.
 * @returns True if the URI is within the workspace folder, false otherwise.
 */
function isWithinWorkspace(uri: vscode.Uri, folder: vscode.WorkspaceFolder) {
  // If uri doesn't match folder scheme/authority, it's not within it
  if (
    uri.scheme !== folder.uri.scheme ||
    uri.authority !== folder.uri.authority
  )
    return false;

  // Check if the uri's path starts with the folder's path
  return uri.path.startsWith(folder.uri.path);
}

/**
 * Obtains the target folder and it's path
 * @returns Folder uri and it's path, or undefined if could not be grabbed
 */
function getTarget(): { uri: vscode.Uri; folderPath: string } | void {
  // Get the path of the currently active file
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  // Get all workspace folders
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

  // Prefer the active editor's folder, if it belongs to the open workspace.
  if (activeUri) {
    const workspace = workspaceFolders.find((folder) =>
      isWithinWorkspace(activeUri, folder),
    );

    if (workspace) {
      return {
        uri: activeUri,
        folderPath: path.posix.dirname(activeUri.path),
      };
    }
  }

  // Otherwise use the first folder in the workspace.
  const workspace = workspaceFolders[0];
  if (workspace) {
    return {
      uri: workspace.uri,
      folderPath: workspace.uri.path,
    };
  }

  return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  // Actual console output
  const output = vscode.window.createOutputChannel('External Terminal Here');
  // Command that shows the output logs
  const showLogs = vscode.commands.registerCommand(
    'externalTerminalHere.showLogs',
    () => output.show(),
  );

  // Main command itself
  const disposable = vscode.commands.registerCommand(
    'externalTerminalHere.open',
    async () => {
      // Get the target folder and its path
      const target = getTarget();
      if (!target) {
        vscode.window.showErrorMessage(
          'No valid target found for opening the external terminal.',
        );
        void vscode.window.showErrorMessage(
          'External Terminal Here: Open a folder or workspace first.',
        );
        return;
      }

      // Now resolve the remote host if any
      const remoteHost = getRemoteHost(target.uri);
      output.appendLine(
        `Opening target: scheme=${target.uri.scheme}, authority=${target.uri.authority || '(none)'}, path=${target.folderPath}`,
      );

      const term = getTermType();
      try {
        if (remoteHost) {
          // Open term remotely
          const command = createRemoteLaunchCmd(remoteHost, target.folderPath);
          output.appendLine(
            `Opening external terminal (${term}) remotely to ${remoteHost} @ ${target.folderPath}`,
          );
          await runAppleScript(command);
          return;
        } else if (target.uri.scheme === 'file') {
          // Open term locally
          output.appendLine(
            `Opening external terminal (${term}) locally at ${target.folderPath}`,
          );
          await execFileAsync('open', ['-a', term, target.folderPath]);
          return;
        } else {
          vscode.window.showErrorMessage(
            'External Terminal Here: Unsupported URI scheme for opening an external terminal.',
          );
        }
      } catch (error) {
        const detail = formatError(error);
        output.appendLine(`Failed to open external terminal: ${detail}`);
      }

      // If made it here - show the output with logs
      output.show(true);
      return;
    },
  );

  // Make sure all items are cleaned up
  context.subscriptions.push(disposable, showLogs, output);
}

export function deactivate(): void {
  // Nothing to clean up.
}
