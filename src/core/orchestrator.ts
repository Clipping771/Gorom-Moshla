import { GlobalState, createInitialState, Phase } from './state';
import { globalEventBus } from './eventBus';
import { Tracer } from './tracer';
import { ProviderFactory, ConversationMessage } from '../ai/providerFactory';
import { StreamController } from '../ai/streamController';
import { CursorTracker } from '../context/cursorTracker';
import { RepoIndexContext } from '../context/repoIndex';
import { LSPHooks } from '../context/lspHooks';
import { ASTParserStub } from '../context/astParser';
import { MergeStrategy } from '../context/mergeStrategy';
import { ContextChunk } from '../context/ranker';
import { TokenBudgetManager } from '../context/budget';
import { RollbackSystem } from './rollback';
import { EditFileTool } from '../tools/editFile';
import { TerminalTool } from '../tools/terminal';
import { ReadFileTool } from '../tools/readFile';
import { ListDirTool } from '../tools/listDir';
import { GrepSearchTool } from '../tools/grepSearch';
import * as vscode from 'vscode';

export class Orchestrator {
  private state: GlobalState;
  private tracer: Tracer;
  private workspaceRoot: string;
  private conversationHistory: ConversationMessage[] = [];
  private _abortController: AbortController | null = null;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.state = createInitialState();
    this.tracer = new Tracer(workspaceRoot);
  }

  public updateWorkspaceRoot(root: string) {
    this.workspaceRoot = root;
  }

  public clearHistory() {
    this.conversationHistory = [];
  }

  /** Abort the current run immediately */
  public stop() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
    this.state.phase = 'DONE';
    globalEventBus.emit('onStatePhaseChange', { oldPhase: this.state.phase, newPhase: 'DONE' });
    globalEventBus.emit('onAIResponse', { rawOutput: '⏹ Stopped.' });
  }

  private transitionTo(newPhase: Phase) {
    globalEventBus.emit('onStatePhaseChange', { oldPhase: this.state.phase, newPhase });
    this.state.phase = newPhase;
  }

  public async run(userInput: string, attachments?: { type: string, data: string, name: string }[], mode: string = 'vibe') {
    // Reset state and create a fresh abort controller for this run
    this.state = createInitialState();
    this._abortController = new AbortController();
    const signal = this._abortController.signal;

    const checkAbort = () => {
      if (signal.aborted) throw new Error('Stopped by user.');
    };

    try {
      this.tracer.logStep({ type: 'USER_INPUT', input: userInput });
      globalEventBus.emit('onUserInput', { input: userInput });

      checkAbort();
      this.transitionTo('COLLECTING_CONTEXT');
      globalEventBus.emit('onThinkingPhase', { phase: 'Collecting context', detail: 'Scanning workspace...' });
      await this.collectContextPhase();

      checkAbort();
      this.transitionTo('PLANNING');
      globalEventBus.emit('onThinkingPhase', { phase: 'Planning approach', detail: 'Generating response...' });
      await this.planningPhase(userInput, signal, attachments, mode);

      if (this.state.phase === 'DONE') return;

      checkAbort();
      if (this.state.executionQueue.length > 0 || this.state.plan?.intent === 'plan') {
        this.transitionTo('WAITING_FOR_APPROVAL');
        globalEventBus.emit('onWaitingForApproval', {});
      } else {
        this.transitionTo('EXECUTING');
        await this.executionPhase(signal);
        await this.autoLoop(signal);
        this.transitionTo('DONE');
      }
    } catch (error: any) {
      const msg: string = error.message || String(error);
      if (msg === 'Stopped by user.' || signal.aborted) {
        // User pressed stop — already handled
        return;
      }
      this.state.lastError = msg;
      this.transitionTo('ERROR');
      this.tracer.logStep({ type: 'ERROR', error: msg });
      globalEventBus.emit('onAIResponse', { rawOutput: `❌ ${msg}` });
    } finally {
      this._abortController = null;
    }
  }

  private async collectContextPhase() {
    const chunks: ContextChunk[] = [];
    const contextEntries: Array<{ type: string; name: string; detail?: string }> = [];
    let fileCount = 0;
    let folderCount = 0;

    const cursorCtx = CursorTracker.getCursorContext();
    if (cursorCtx) {
      chunks.push({
        type: 'immediate',
        source: cursorCtx.activeFile,
        content: `Active File: ${cursorCtx.activeFile}\nLine: ${cursorCtx.activeLine}\nWord: ${cursorCtx.currentWord}\nSelection:\n${cursorCtx.selectedText}`
      });
      const fileName = cursorCtx.activeFile.split(/[\\/]/).pop() || cursorCtx.activeFile;
      contextEntries.push({ type: 'file', name: fileName, detail: `#L${cursorCtx.activeLine}` });
      fileCount++;

      if (cursorCtx.currentWord && vscode.window.activeTextEditor) {
        const uri = vscode.window.activeTextEditor.document.uri;
        const position = vscode.window.activeTextEditor.selection.active;
        try {
          const definitions = await LSPHooks.getDefinitions(uri, position);
          if (definitions.length > 0) {
            chunks.push({
              type: 'semantic',
              source: 'LSP Definition',
              content: `Definition of ${cursorCtx.currentWord} at ${definitions[0].uri.fsPath}`
            });
            const defName = definitions[0].uri.fsPath.split(/[\\/]/).pop() || 'definition';
            contextEntries.push({ type: 'definition', name: defName, detail: cursorCtx.currentWord });
            fileCount++;
            const astSummary = ASTParserStub.summarizeFileStructure(definitions[0].uri.fsPath);
            if (astSummary) {
              chunks.push({ type: 'ast', source: definitions[0].uri.fsPath, content: `AST:\n${astSummary}` });
            }
          }
        } catch { /* LSP is optional */ }
      }
    }

    const repoTree = await RepoIndexContext.getFileTreeContext();
    chunks.push({ type: 'repo', source: 'Workspace', content: repoTree });
    // Count files and folders from repo tree
    const treeLines = repoTree.split('\n');
    treeLines.forEach(line => {
      if (line.includes('[DIR]')) folderCount++;
      else if (line.includes('[FILE]')) fileCount++;
    });
    contextEntries.push({ type: 'workspace', name: 'Workspace tree', detail: `${treeLines.length} entries` });

    // Emit context exploration data for the UI
    globalEventBus.emit('onContextExploring', { files: fileCount, folders: folderCount, entries: contextEntries });

    const budgetManager = new TokenBudgetManager(8000);
    const mergeStrategy = new MergeStrategy(budgetManager);
    this.state.mergedContext = mergeStrategy.merge(chunks);
    this.tracer.logContextSnapshot(this.state.mergedContext);
  }

  private async planningPhase(userInput: string, signal: AbortSignal, attachments?: { type: string, data: string, name: string }[], mode: string = 'vibe') {
    try {
      const provider = ProviderFactory.getProvider();

      if (signal?.aborted) throw new Error('Stopped by user.');

      const streamController = new StreamController(50);
      streamController.startStream();

      this.state.plan = await provider.generatePlan(
        userInput,
        this.state.mergedContext,
        streamController,
        this.conversationHistory,
        signal,
        attachments,
        mode
      );

      streamController.endStream();

      if (signal?.aborted) throw new Error('Stopped by user.');

      const plan = this.state.plan!;
      if (plan.thoughts) {
        globalEventBus.emit('onThoughts', { thoughts: plan.thoughts });
      }
      this.state.executionQueue = plan.steps.map(step => ({
        step,
        status: 'PENDING'
      }));

      this.tracer.logAIOutput(plan);

      // Notify UI about the plan before executing
      if (plan.steps.length > 0 || plan.intent === 'plan') {
        globalEventBus.emit('onPlanReady', {
          title: plan.title || (plan.intent === 'plan' ? 'Review Plan' : 'Working…'),
          steps: plan.steps.map((s, i) => ({
            index: i,
            tool: s.tool,
            description: s.description || s.args.path || (s.args as any).command || s.tool,
            status: 'pending'
          }))
        });

        const planMarkdown = `# ${plan.title || 'Implementation Plan'}\n\n` +
          (plan.intent === 'plan'
            ? `${plan.plan_details || plan.final_response}`
            : `## Steps\n\n${plan.steps.map((s, i) => {
              const desc = s.description || s.tool;
              const target = s.args.path || (s.args as any).command || (s.args as any).query || '';
              return `${i + 1}. **${desc}**\n   > \`${s.tool}\` ➔ *${target}*`;
            }).join('\n\n')}\n`);

        if (this.workspaceRoot) {
          const planPath = vscode.Uri.file(`${this.workspaceRoot}/implementation_plan.md`);
          await vscode.workspace.fs.writeFile(planPath, new TextEncoder().encode(planMarkdown));
          vscode.commands.executeCommand('markdown.showPreview', planPath);
        }
      }

    } catch (error: any) {
      const msg: string = error.message || String(error);
      this.tracer.logStep({ type: 'PLANNING_FAILED', reason: msg });

      // Classify the error for a clear user-facing message
      let userMsg = msg;
      if (msg.includes('401') || msg.includes('403') || msg.includes('Unauthorized') || msg.includes('Invalid API')) {
        userMsg = `❌ Invalid API key. Please check your key in ⚙ Settings and try again.\n\nDetails: ${msg}`;
      } else if (msg.includes('API Key not set')) {
        userMsg = `❌ No API key set. Click ⚙ and paste your key.`;
      } else if (msg.includes('429') || msg.includes('Rate limited')) {
        userMsg = `⏳ ${msg}`;
      } else if (msg.includes('Stopped by user')) {
        throw error; // re-throw stop signal
      }

      this.state.plan = null;
      this.state.executionQueue = [];
      globalEventBus.emit('onAIResponse', { rawOutput: userMsg });
      this.transitionTo('DONE');
    }
  }

  public async approvePlan() {
    if (this.state.phase !== 'WAITING_FOR_APPROVAL') return;

    this._abortController = new AbortController();
    const signal = this._abortController.signal;

    try {
      if (this.state.plan && this.state.plan.intent === 'plan' && this.state.executionQueue.length === 0) {
        this.transitionTo('PLANNING');
        globalEventBus.emit('onAIResponse', { rawOutput: '🔄 *Plan approved. Generating execution steps…*' });

        const originalRequest = this.conversationHistory.find(m => m.role === 'user');
        const execPrompt = `The user has APPROVED the plan. Now execute it fully.
Original request: "${originalRequest?.content || 'Build the project'}"
Plan that was approved:
${this.state.plan.plan_details || this.state.plan.final_response}

IMPORTANT: You MUST now use "create" intent with FULL steps array containing createFile, editFile, and runTerminal steps.
Do NOT use "plan" intent again. Generate ALL the files needed to complete this task.
Do NOT use "explain" intent. The user wants code, not explanations.`;

        await this.planningPhase(execPrompt, signal);
        if ((this.state.phase as string) === 'DONE' || (this.state.phase as string) === 'ERROR') return;
      }

      this.transitionTo('EXECUTING');
      await this.executionPhase(signal);
      await this.autoLoop(signal);
      this.transitionTo('DONE');
    } finally {
      this._abortController = null;
    }
  }



  private async autoLoop(signal: AbortSignal) {
    let loops = 0;
    const config = vscode.workspace.getConfiguration('goromMoshla');
    const MAX_LOOPS = config.get<number>('maxLoops') ?? 100;
    while (loops < MAX_LOOPS) {
      if (signal?.aborted) break;
      loops++;
      if (this.state.plan?.intent === 'explain') break;
      const hadReadOrSearchSteps = this.state.executionQueue.some(
        q => q.step.tool === 'readFile' || q.step.tool === 'listDir' || q.step.tool === 'grepSearch' || q.step.tool === 'runTerminal'
      );
      if (!hadReadOrSearchSteps) break;

      this.transitionTo('PLANNING');
      globalEventBus.emit('onAIResponse', { rawOutput: `\n\n🔄 *Analyzing results, debugging errors, and planning next steps (${loops}/${MAX_LOOPS})…*` });
      await this.planningPhase("Analyze the executed tools, terminal output, and gathered context carefully. If there were any failing commands, bugs, or errors, you MUST explain the issue, debug it, and try a different approach to fix it. Do not repeat failing commands. If the task is progressing well, output the next tool steps needed (editFile, createFile, runTerminal). If the task is completely finished, use the 'explain' intent with a summary.", signal);

      if (this.state.phase === 'DONE' || this.state.phase === 'ERROR') break;
      if (this.state.executionQueue.length > 0) {
        this.transitionTo('EXECUTING');
        await this.executionPhase(signal);
      } else {
        break;
      }
    }
  }

  public async rejectPlan() {
    if (this.state.phase !== 'WAITING_FOR_APPROVAL') return;
    globalEventBus.emit('onPlanRejected', {});
    this.transitionTo('DONE');
  }



  private async executeSingleStep(
    step: any,
    rollbackSystem: RollbackSystem,
    executedFiles: string[],
    changedFiles: Array<{ path: string; action: 'created' | 'modified' }>
  ): Promise<string> {
    const { tool, args } = step;
    
    // Phase 3: Hardening - Add a hard timeout to prevent indefinite hangs
    const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
      let timeoutId: NodeJS.Timeout;
      const timeoutPromise = new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Tool ${tool} timed out after ${ms}ms`)), ms);
      });
      return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
    };

    let result = '';

    const executeTool = async () => {
      if (tool === 'createFile' || tool === 'editFile') {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('fs') as typeof import('fs');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const nodePath = require('path') as typeof import('path');
      const fullPath = nodePath.resolve(this.workspaceRoot, args.path);
      const existed = fs.existsSync(fullPath);
      result = await EditFileTool.execute(
        this.workspaceRoot,
        args.path,
        (args as any).content ?? '',
        rollbackSystem
      );
      executedFiles.push(args.path);
      changedFiles.push({ path: args.path, action: existed ? 'modified' : 'created' });

    } else if (tool === 'runTerminal') {
      result = await TerminalTool.execute(
        (args as any).command,
        this.workspaceRoot
      );
      this.state.mergedContext += `\n\n=== TERMINAL: ${(args as any).command} ===\n${result}`;

    } else if (tool === 'readFile') {
      result = await ReadFileTool.execute(this.workspaceRoot, args.path, args.startLine, args.endLine);
      this.state.mergedContext += `\n\n=== FILE: ${args.path} ===\n${result.substring(0, 2000)}`;
    } else if (tool === 'listDir') {
      result = await ListDirTool.execute(args.path, this.workspaceRoot);
      this.state.mergedContext += `\n\n=== DIR: ${args.path} ===\n${result}`;
    } else if (tool === 'grepSearch') {
      result = await GrepSearchTool.execute(args.query, this.workspaceRoot);
      this.state.mergedContext += `\n\n=== SEARCH: ${args.query} ===\n${result}`;
    }
    return result;
  };

    result = await withTimeout(executeTool(), 45000); // 45 second hard limit per step
    return result;
  }

  private async executionPhase(signal?: AbortSignal) {
    if (this.state.executionQueue.length === 0) {
      if (this.state.plan) {
        this.conversationHistory.push({ role: 'assistant', content: this.state.plan.final_response });
        globalEventBus.emit('onAIResponse', { rawOutput: this.state.plan.final_response });
      }
      return;
    }

    if (signal?.aborted) return;
    globalEventBus.emit('onThinkingPhase', { phase: 'Executing', detail: `${this.state.executionQueue.length} steps` });

    const rollbackSystem = new RollbackSystem(this.tracer);
    const executedFiles: string[] = [];
    const changedFiles: Array<{ path: string; action: 'created' | 'modified' }> = [];
    const config = vscode.workspace.getConfiguration('goromMoshla');
    const MAX_ITERATIONS = config.get<number>('maxIterations') ?? 100;
    const queueLength = Math.min(this.state.executionQueue.length, MAX_ITERATIONS);

    for (let i = 0; i < queueLength; i++) {
      if (signal?.aborted) break;
      const queueItem = this.state.executionQueue[i];
      queueItem.status = 'RUNNING';
      const stepStart = Date.now();

      // Tell UI this step is running
      globalEventBus.emit('onStepUpdate', { index: i, status: 'running' });

      try {
        const result = await this.executeSingleStep(queueItem.step, rollbackSystem, executedFiles, changedFiles);

        const elapsed = Date.now() - stepStart;
        this.tracer.logToolExecution(queueItem.step.tool, queueItem.step.args, result.substring(0, 200));
        queueItem.status = 'COMPLETED';
        const resultSnippet = result.length > 80 ? result.substring(0, 80) + '…' : result;
        globalEventBus.emit('onStepUpdate', { index: i, status: 'done', result: resultSnippet, elapsed });

      } catch (e: any) {
        const elapsed = Date.now() - stepStart;
        queueItem.status = 'FAILED';
        globalEventBus.emit('onStepUpdate', { index: i, status: 'error', message: e.message, elapsed });
        this.tracer.logStep({ type: 'STEP_FAILED', step: i, error: e.message });

        // Trigger self-healing
        globalEventBus.emit('onThinkingPhase', {
          phase: 'Self-Healing 🌶️',
          detail: `Step ${i + 1} failed: ${e.message}. Roasting files to fix automatically...`
        });

        try {
          const provider = ProviderFactory.getProvider();
          const fixPrompt = `You are in self-healing mode. The execution of step ${i + 1} ("${queueItem.step.description || queueItem.step.tool}") failed with the following error:
${e.message}

Please output a JSON response containing the corrected steps (createFile, editFile, runTerminal, etc.) to repair this failure and let the assistant successfully finish the task. Do not make placeholders or explanation responses, only output JSON with intent "create" or "edit" and a short title indicating the fix.`;

          const fixPlan = await provider.generatePlan(
            fixPrompt,
            this.state.mergedContext,
            undefined,
            this.conversationHistory
          );

          if (fixPlan.steps && fixPlan.steps.length > 0) {
            globalEventBus.emit('onThinkingPhase', {
              phase: 'Applying Fixes 🍳',
              detail: `Cooking up ${fixPlan.steps.length} correction steps...`
            });
            for (let j = 0; j < fixPlan.steps.length; j++) {
              const fixStep = fixPlan.steps[j];
              globalEventBus.emit('onThinkingPhase', {
                phase: 'Cooking Fix Step',
                detail: `${fixStep.description || fixStep.tool} (${j + 1}/${fixPlan.steps.length})`
              });
              await this.executeSingleStep(fixStep, rollbackSystem, executedFiles, changedFiles);
            }
            // If we successfully ran the fix, update the step status in UI to let the user know it was healed!
            globalEventBus.emit('onStepUpdate', {
              index: i,
              status: 'done',
              message: `Healed automatically: ${fixPlan.title || 'Fixed failure'}`,
              elapsed
            });
            queueItem.status = 'COMPLETED';
          }
        } catch (healError: any) {
          this.tracer.logStep({ type: 'HEAL_FAILED', error: healError.message });
          globalEventBus.emit('onThinkingPhase', {
            phase: 'Self-Healing Failed 😔',
            detail: `Could not heal step ${i + 1}: ${healError.message}`
          });
          
          // Phase 6: Continuous Feedback Loop
          vscode.window.showErrorMessage(
            `Gorom Moshla: Step ${i + 1} failed and self-healing was unsuccessful.`,
            'Report Issue'
          ).then(choice => {
            if (choice === 'Report Issue') {
              const issueBody = encodeURIComponent(`Bug Report\\n\\nError: ${e.message}\\nHeal Error: ${healError.message}`);
              vscode.env.openExternal(vscode.Uri.parse(`https://github.com/example/gorom-moshla/issues/new?body=${issueBody}`));
            }
          });
        }
      }
    }

    // Emit file changes for UI summary bar
    if (changedFiles.length > 0) {
      globalEventBus.emit('onFilesChanged', { files: changedFiles });
    }

    // Emit the final AI response (markdown)
    if (this.state.plan) {
      const summary = this.state.plan.final_response;
      // Add to conversation history
      this.conversationHistory.push({ role: 'assistant', content: summary });
      globalEventBus.emit('onAIResponse', { rawOutput: summary });
    }

    // Show summary notification if files were created
    if (executedFiles.length > 0) {
      const walkMd = `# Walkthrough\n\nFiles modified:\n${executedFiles.map(f => `- ${f}`).join('\n')}\n\n${this.state.plan?.final_response || ''}`;
      const walkPath = vscode.Uri.file(`${this.workspaceRoot}/walkthrough.md`);
      await vscode.workspace.fs.writeFile(walkPath, new TextEncoder().encode(walkMd));

      vscode.window.showInformationMessage(
        `🌶️ Gorom Moshla: Created/updated ${executedFiles.length} file(s)`,
        'Open Folder'
      ).then(choice => {
        if (choice === 'Open Folder') {
          vscode.commands.executeCommand('workbench.view.explorer');
        }
      });
    }
  }
}
