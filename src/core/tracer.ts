import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Execution Trace System
 * Logs inputs, contexts, AI outputs, and tool results for debugging.
 */
export class Tracer {
  private logFilePath: string;

  constructor(workspaceRoot: string) {
    const logDir = path.join(workspaceRoot, '.gorom-moshla', 'traces');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.logFilePath = path.join(logDir, `trace_${timestamp}.jsonl`);
  }

  public logStep(stepData: any) {
    const entry = {
      timestamp: new Date().toISOString(),
      ...stepData
    };
    fs.appendFileSync(this.logFilePath, JSON.stringify(entry) + '\n');
  }

  public logContextSnapshot(context: any) {
    this.logStep({ type: 'CONTEXT_SNAPSHOT', context });
  }

  public logAIOutput(output: any) {
    this.logStep({ type: 'AI_OUTPUT', output });
  }

  public logToolExecution(tool: string, args: any, result: any) {
    this.logStep({ type: 'TOOL_EXECUTION', tool, args, result });
  }
}
