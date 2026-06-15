import * as fs from 'fs';

export class ASTParserStub {
  /**
   * Extremely lightweight structural summarization.
   * Strict Limitation: ONLY extracts signatures, classes, interfaces, imports.
   * Does NOT parse or return full implementations.
   */
  public static summarizeFileStructure(filePath: string): string {
    if (!fs.existsSync(filePath)) return '';
    
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    
    const summaryLines: string[] = [];
    
    // Very naive Regex-based stub (In production use a lightweight parser)
    for (const line of lines) {
      if (line.trim().startsWith('import ')) {
        summaryLines.push(line);
      } else if (line.includes('class ') || line.includes('interface ') || line.includes('type ')) {
        summaryLines.push(line);
      } else if (line.trim().startsWith('public ') || line.trim().startsWith('private ') || line.trim().startsWith('export function')) {
        // Capture method/function signatures
        summaryLines.push(line.split('{')[0].trim());
      }
    }

    return summaryLines.join('\n');
  }
}
