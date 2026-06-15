import * as vscode from 'vscode';

export class SecurityGuard {

  // Commands that are always blocked — no confirmation, instant deny
  private static readonly HARD_BLOCK: RegExp[] = [
    /rm\s+-rf\s+[/~]/,           // rm -rf / or ~/
    /rm\s+-rf\s+\*/,              // rm -rf *
    /curl\s+.*\|\s*(bash|sh)/,    // curl pipe to shell
    /wget\s+.*\|\s*(bash|sh)/,    // wget pipe to shell
    />\s*[/]dev[/]sd/,              // write to block device
    /mkfs/,                       // format disk
    /dd\s+if=.*of=[/]dev[/]/,       // dd to device
    /:(){ :|:& };:/,              // fork bomb
    /chmod\s+-R\s+777\s+[/]/,      // chmod 777 /
  ];

  // Commands that need a one-time user confirmation (risky but sometimes legitimate)
  private static readonly SOFT_WARN: RegExp[] = [
    /sudo\s+/,
    /rm\s+-rf/,                   // rm -rf without / (still ask)
    /DROP\s+TABLE/i,
    /DELETE\s+FROM/i,
    /format\s+[a-z]:/i,           // Windows format drive
  ];

  // Safe dev commands — always allow without any prompt
  private static readonly SAFE_PATTERNS: RegExp[] = [
    /^npm\s+/,
    /^npx\s+/,
    /^yarn\s+/,
    /^pnpm\s+/,
    /^node\s+/,
    /^ts-node\s+/,
    /^tsc\s*/,
    /^git\s+/,
    /^python\s+/,
    /^python3\s+/,
    /^pip\s+/,
    /^pip3\s+/,
    /^cargo\s+/,
    /^rustc\s+/,
    /^go\s+/,
    /^mvn\s+/,
    /^gradle\s+/,
    /^dotnet\s+/,
    /^mkdir\s+/,
    /^touch\s+/,
    /^echo\s+/,
    /^cat\s+/,
    /^ls\s*/,
    /^dir\s*/,
    /^pwd\s*/,
    /^cd\s+/,
    /^cp\s+/,
    /^mv\s+/,
    /^code\s+/,
  ];

  public static async validateTerminalCommand(command: string): Promise<boolean> {
    const trimmed = command.trim();

    // 1. Hard block — never run these
    for (const pattern of this.HARD_BLOCK) {
      if (pattern.test(trimmed)) {
        vscode.window.showErrorMessage(`🛡️ Gorom Moshla blocked dangerous command: ${trimmed}`);
        return false;
      }
    }

    // 2. Safe allow — common dev commands, no prompt needed
    for (const pattern of this.SAFE_PATTERNS) {
      if (pattern.test(trimmed)) {
        return true;
      }
    }

    // 3. Soft warn — risky but not always dangerous, ask once
    for (const pattern of this.SOFT_WARN) {
      if (pattern.test(trimmed)) {
        const selection = await vscode.window.showWarningMessage(
          `⚠️ Gorom Moshla wants to run a potentially risky command:\n\n${trimmed}`,
          'Allow',
          'Block'
        );
        return selection === 'Allow';
      }
    }

    // 4. Unknown command — ask for confirmation
    const selection = await vscode.window.showInformationMessage(
      `🌶️ Gorom Moshla wants to run:\n\n${trimmed}`,
      'Allow',
      'Block'
    );
    return selection === 'Allow';
  }

  public static async validateWriteOperation(filePath: string): Promise<boolean> {
    // Only ask for sensitive files like .env
    if (filePath.endsWith('.env') || filePath.endsWith('.env.local')) {
      const selection = await vscode.window.showWarningMessage(
        `⚠️ Gorom Moshla wants to modify: ${filePath}`,
        'Allow',
        'Block'
      );
      return selection === 'Allow';
    }
    return true;
  }
}
