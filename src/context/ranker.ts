export interface ContextChunk {
  content: string;
  source: string;
  type: 'semantic' | 'immediate' | 'repo' | 'ast';
  score?: number;
}

export class ContextRanker {
  /**
   * Ranks context chunks based on heuristics.
   * Prioritizes semantic (LSP), then immediate (cursor), then repo.
   */
  public static rank(chunks: ContextChunk[]): ContextChunk[] {
    for (const chunk of chunks) {
      chunk.score = 0;
      
      // Heuristic Scoring
      if (chunk.type === 'semantic') chunk.score += 100;
      if (chunk.type === 'immediate') chunk.score += 80;
      if (chunk.type === 'ast') chunk.score += 50;
      if (chunk.type === 'repo') chunk.score += 20;
      
      // Could add more complex text-based ranking here (e.g. TF-IDF or BM25)
    }

    // Sort descending by score
    return chunks.sort((a, b) => (b.score || 0) - (a.score || 0));
  }
}
