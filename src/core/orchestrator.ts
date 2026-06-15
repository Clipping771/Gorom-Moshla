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

  private transitionTo(newPhase: Phase) {
    globalEventBus.emit('onStatePhaseChange', { oldPhase: this.state.phase, newPhase });
    this.state.phase = newPhase;
  }

  public async run(userInput: string) {
    // Reset state for this run
    this.state = createInitialState();

    try {
      this.tracer.logStep({ type: 'USER_INPUT', input: userInput });
      globalEventBus.emit('onUserInput', { input: userInput });

      this.transitionTo('COLLECTING_CONTEXT');
      globalEventBus.emit('onThinkingPhase', { phase: 'Collecting context', detail: 'Scanning workspace...' });
      await this.collectContextPhase();

      this.transitionTo('PLANNING');
      globalEventBus.emit('onThinkingPhase', { phase: 'Planning approach', detail: 'Generating response...' });
      await this.planningPhase(userInput);

      if (this.state.phase === 'DONE') return;

      if (this.state.executionQueue.length > 0 || this.state.plan?.intent === 'plan') {
        this.transitionTo('WAITING_FOR_APPROVAL');
        globalEventBus.emit('onWaitingForApproval', {});
      } else {
        this.transitionTo('EXECUTING');
        await this.executionPhase();
        await this.autoLoop();
        this.transitionTo('DONE');
      }
    } catch (error: any) {
      this.state.lastError = error.message;
      this.transitionTo('ERROR');
      vscode.window.showErrorMessage(`Gorom Moshla Error: ${error.message}`);
      this.tracer.logStep({ type: 'ERROR', error: error.message });
      globalEventBus.emit('onAIResponse', { rawOutput: `❌ Error: ${error.message}` });
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

  private async planningPhase(userInput: string) {
    try {
      const provider = ProviderFactory.getProvider();

      const streamController = new StreamController(50);
      streamController.startStream();

      this.state.plan = await provider.generatePlan(
        userInput,
        this.state.mergedContext,
        streamController,
        this.conversationHistory
      );

      streamController.endStream();

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
            description: (s as any).description || s.args.path || (s.args as any).command || s.tool,
            status: 'pending'
          }))
        });

        const planMarkdown = `# ${plan.title || 'Implementation Plan'}\n\n` +
          (plan.intent === 'plan'
            ? `${plan.plan_details || plan.final_response}`
            : `## Steps\n\n${plan.steps.map((s, i) => {
              const desc = (s as any).description || s.tool;
              const target = s.args.path || (s.args as any).command || (s.args as any).query || '';
              return `${i + 1}. **${desc}**\n   > \`${s.tool}\` ➔ *${target}*`;
            }).join('\n\n')}\n`);
        
        const planPath = vscode.Uri.file(`${this.workspaceRoot}/implementation_plan.md`);
        await vscode.workspace.fs.writeFile(planPath, new TextEncoder().encode(planMarkdown));

        // Automatically open the markdown preview
        vscode.commands.executeCommand('markdown.showPreview', planPath);
      }

    } catch (error: any) {
      this.tracer.logStep({ type: 'SAFE_MODE_TRIGGERED', reason: error.message });
      vscode.window.showWarningMessage(`Gorom Moshla SAFE MODE: ${error.message}`);
      this.state.plan = null;
      this.state.executionQueue = [];
      globalEventBus.emit('onAIResponse', { rawOutput: `⚠️ Could not process request: ${error.message}` });
      this.transitionTo('DONE');
    }
  }

  public async approvePlan() {
    if (this.state.phase !== 'WAITING_FOR_APPROVAL') return;

    // If this was a "plan" intent with empty steps, we need to re-plan
    // with a directive to actually generate the execution steps now.
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

      await this.planningPhase(execPrompt);

      if ((this.state.phase as string) === 'DONE' || (this.state.phase as string) === 'ERROR') return;
    }

    this.transitionTo('EXECUTING');

    // Generate task.md only if we have actual steps
    if (this.state.plan && this.state.executionQueue.length > 0) {
      await this.writeTaskMd();
    }

    await this.executionPhase();
    await this.autoLoop();
    this.transitionTo('DONE');
  }

  private async writeTaskMd() {
    if (!this.state.plan || this.state.executionQueue.length === 0) return;
    const steps = this.state.plan.steps;
    const taskMd = `# 📋 Task List\n\n## 🚀 ${this.state.plan.title || 'Implementation Plan'}\n\n${steps.map(s => {
      const desc = (s as any).description || 'Execute Tool';
      const target = s.args.path || (s.args as any).command || (s.args as any).query || 'Workspace';
      return `- [ ] **${desc}**\n  > \`${s.tool}\` ➔ *${target}*`;
    }).join('\n\n')}\n\n---\n*Gorom Moshla AI*`;
    const taskPath = vscode.Uri.file(`${this.workspaceRoot}/task.md`);
    await vscode.workspace.fs.writeFile(taskPath, new TextEncoder().encode(taskMd));
    vscode.commands.executeCommand('markdown.showPreview', taskPath);
  }

  private async autoLoop() {
    let loops = 0;
    const MAX_LOOPS = 5;
    while (loops < MAX_LOOPS) {
      loops++;

      // If the last plan was pure explanation or had no steps AND no more work to do, stop.
      if (this.state.plan?.intent === 'explain') break;

      // After executing, check if there's more context that needs follow-up
      // (e.g., readFile steps were executed, now we need editFile steps)
      const hadReadOrSearchSteps = this.state.executionQueue.some(
        q => q.step.tool === 'readFile' || q.step.tool === 'listDir' || q.step.tool === 'grepSearch'
      );

      if (!hadReadOrSearchSteps) break; // Pure write steps — we're done

      this.transitionTo('PLANNING');
      globalEventBus.emit('onAIResponse', { rawOutput: `\n\n🔄 *Analyzing results and planning next steps (${loops}/${MAX_LOOPS})…*` });

      await this.planningPhase("Continue based on the new context gathered from the files you just read. If the task is completely finished, use the 'explain' intent with a summary. Otherwise, output the next tool steps needed (editFile, createFile, runTerminal).");

      if (this.state.phase === 'DONE' || this.state.phase === 'ERROR') break;

      if (this.state.executionQueue.length > 0) {
        this.transitionTo('EXECUTING');
        await this.writeTaskMd();
        await this.executionPhase();
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

  private async updateTaskArtifact(index: number, status: 'RUNNING' | 'COMPLETED' | 'FAILED') {
    if (!this.state.plan) return;
    const marks = { 'RUNNING': '[/]', 'COMPLETED': '[x]', 'FAILED': '[ ]' };
    const taskMd = `# 📋 Task List\n\n## 🚀 ${this.state.plan.title || 'Implementation Plan'}\n\n${this.state.plan.steps.map((s, i) => {
      let mark = '[ ]';
      if (i < index) mark = '[x]';
      else if (i === index) mark = marks[status];
      
      const desc = (s as any).description || 'Execute Tool';
      const target = s.args.path || (s.args as any).command || (s.args as any).query || 'Workspace';
      
      return `- ${mark} **${desc}**\n  > \`${s.tool}\` ➔ *${target}*`;
    }).join('\n\n')}\n\n---\n*Gorom Moshla AI*`;
    const taskPath = vscode.Uri.file(`${this.workspaceRoot}/task.md`);
    await vscode.workspace.fs.writeFile(taskPath, new TextEncoder().encode(taskMd));
  }

  private async executeSingleStep(
    step: any, 
    rollbackSystem: RollbackSystem, 
    executedFiles: string[], 
    changedFiles: Array<{ path: string; action: 'created' | 'modified' }>
  ): Promise<string> {
    const { tool, args } = step;
    let result = '';

    if (tool === 'createFile' || tool === 'editFile') {
      const fs = require('fs') as typeof import('fs');
      const path = require('path') as typeof import('path');
      const fullPath = path.resolve(this.workspaceRoot, args.path);
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
  }

  private async executionPhase() {
    if (this.state.executionQueue.length === 0) {
      // Pure explain — just emit the final_response
      if (this.state.plan) {
        // Add to history
        this.conversationHistory.push({ role: 'assistant', content: this.state.plan.final_response });
        globalEventBus.emit('onAIResponse', { rawOutput: this.state.plan.final_response });
      }
      return;
    }

    globalEventBus.emit('onThinkingPhase', { phase: 'Executing', detail: `${this.state.executionQueue.length} steps` });

    const rollbackSystem = new RollbackSystem(this.tracer);
    const executedFiles: string[] = [];
    const changedFiles: Array<{ path: string; action: 'created' | 'modified' }> = [];
    const MAX_ITERATIONS = 20;
    const queueLength = Math.min(this.state.executionQueue.length, MAX_ITERATIONS);

    for (let i = 0; i < queueLength; i++) {
      const queueItem = this.state.executionQueue[i];
      queueItem.status = 'RUNNING';
      const stepStart = Date.now();

      // Tell UI this step is running
      globalEventBus.emit('onStepUpdate', { index: i, status: 'running' });
      await this.updateTaskArtifact(i, 'RUNNING');

      try {
        const result = await this.executeSingleStep(queueItem.step, rollbackSystem, executedFiles, changedFiles);

        const elapsed = Date.now() - stepStart;
        this.tracer.logToolExecution(queueItem.step.tool, queueItem.step.args, result.substring(0, 200));
        queueItem.status = 'COMPLETED';
        const resultSnippet = result.length > 80 ? result.substring(0, 80) + '…' : result;
        globalEventBus.emit('onStepUpdate', { index: i, status: 'done', result: resultSnippet, elapsed });
        await this.updateTaskArtifact(i, 'COMPLETED');

      } catch (e: any) {
        const elapsed = Date.now() - stepStart;
        queueItem.status = 'FAILED';
        globalEventBus.emit('onStepUpdate', { index: i, status: 'error', message: e.message, elapsed });
        await this.updateTaskArtifact(i, 'FAILED');
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
