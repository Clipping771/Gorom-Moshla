import { ContextChunk, ContextRanker } from './ranker';
import { TokenBudgetManager } from './budget';

export class MergeStrategy {
  constructor(private budgetManager: TokenBudgetManager) {}

  /**
   * Merges, ranks, and truncates context into a final cohesive string.
   */
  public merge(chunks: ContextChunk[]): string {
    const rankedChunks = ContextRanker.rank(chunks);
    
    // Group by layer for the budget manager
    let semanticStr = '';
    let immediateStr = '';
    let repoStr = '';

    for (const chunk of rankedChunks) {
      if (chunk.type === 'semantic' || chunk.type === 'ast') {
        semanticStr += chunk.content + '\n';
      } else if (chunk.type === 'immediate') {
        immediateStr += chunk.content + '\n';
      } else if (chunk.type === 'repo') {
        repoStr += chunk.content + '\n';
      }
    }

    // Apply strict token budgets (20/50/30)
    const budgeted = this.budgetManager.allocateBudget(immediateStr, repoStr, semanticStr);

    return `
=== IMMEDIATE CONTEXT (Priority 1) ===
${budgeted.immediate}

=== SEMANTIC CONTEXT (Priority 2) ===
${budgeted.semantic}

=== REPOSITORY CONTEXT (Priority 3) ===
${budgeted.repo}
    `.trim();
  }
}
