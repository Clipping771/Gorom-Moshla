import { globalEventBus } from '../core/eventBus';

export class StreamController {
  private buffer: string = '';
  private flushInterval: NodeJS.Timeout | null = null;
  private isStreaming: boolean = false;

  constructor(private flushRateMs: number = 50) {}

  public startStream() {
    this.isStreaming = true;
    this.buffer = '';
    
    // Periodically flush the buffer to the UI to avoid DOM spam
    this.flushInterval = setInterval(() => {
      if (this.buffer.length > 0) {
        globalEventBus.emit('onAIStreamChunk', { chunk: this.buffer });
        this.buffer = '';
      }
    }, this.flushRateMs);
  }

  public enqueueChunk(chunk: string) {
    if (!this.isStreaming) return;
    this.buffer += chunk;
  }

  public endStream() {
    this.isStreaming = false;
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    // Flush remaining buffer
    if (this.buffer.length > 0) {
      globalEventBus.emit('onAIStreamChunk', { chunk: this.buffer });
      this.buffer = '';
    }
  }

  public isStreamingActive(): boolean {
    return this.isStreaming;
  }
}
