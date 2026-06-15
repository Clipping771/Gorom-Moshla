/**
 * Token Budget Manager
 * Enforces a strict context token cap:
 * Immediate: 20%
 * Repo: 50%
 * Semantic: 30%
 */
export class TokenBudgetManager {
  private maxTokens: number;

  constructor(maxTokens: number = 8000) {
    this.maxTokens = maxTokens;
  }

  // Very rudimentary token counter stub (assuming ~4 chars per token)
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  public allocateBudget(immediateText: string, repoText: string, semanticText: string) {
    const limits = {
      immediate: Math.floor(this.maxTokens * 0.20),
      repo: Math.floor(this.maxTokens * 0.50),
      semantic: Math.floor(this.maxTokens * 0.30)
    };

    return {
      immediate: this.truncateToLimit(immediateText, limits.immediate),
      repo: this.truncateToLimit(repoText, limits.repo),
      semantic: this.truncateToLimit(semanticText, limits.semantic)
    };
  }

  private truncateToLimit(text: string, tokenLimit: number): string {
    const estimatedTokens = this.estimateTokens(text);
    if (estimatedTokens <= tokenLimit) {
      return text;
    }
    // Truncate based on character count estimate
    return text.substring(0, tokenLimit * 4) + '\n...[Truncated due to token budget]';
  }
}
