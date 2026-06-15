// Note: This logic runs inside the Webview's JavaScript
export const StreamBufferScript = `
class StreamBuffer {
  constructor(renderCallback, flushRateMs = 50) {
    this.buffer = '';
    this.renderCallback = renderCallback;
    this.flushRateMs = flushRateMs;
    this.interval = null;
  }

  start() {
    this.interval = setInterval(() => {
      if (this.buffer.length > 0) {
        this.renderCallback(this.buffer);
        this.buffer = ''; // clear after render
      }
    }, this.flushRateMs);
  }

  enqueue(chunk) {
    this.buffer += chunk;
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    if (this.buffer.length > 0) {
      this.renderCallback(this.buffer);
      this.buffer = '';
    }
  }
}
`;
