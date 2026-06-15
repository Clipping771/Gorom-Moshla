import * as vscode from 'vscode';
import { ValidatedAIResponse } from './schema';
import { PromptEngineering } from './prompt';
import { StreamController } from './streamController';

export interface ConversationMessage { role: 'user' | 'assistant'; content: string; }

export interface AIProvider {
  name: string;
  generatePlan(
    userInput: string,
    context: any,
    streamController?: StreamController,
    history?: ConversationMessage[]
  ): Promise<ValidatedAIResponse>;
}

export interface ModelEntry { id: string; label: string; }

/**
 * Fetches the live model list from each provider's API using the supplied key.
 * Returns { models, error } — error is set if the fetch fails.
 */
export async function fetchModelsForProvider(
  providerName: string,
  apiKey: string
): Promise<{ models: ModelEntry[]; error?: string }> {
  try {
    let models: ModelEntry[] = [];

    if (providerName === 'groq') {
      // OpenAI-compatible /models endpoint
      const res = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as any;
      models = (data.data as any[])
        .map(m => ({ id: m.id, label: m.id }))
        .sort((a, b) => a.id.localeCompare(b.id));

    } else if (providerName === 'gemini') {
      // Native Gemini models list — filter to generateContent-capable ones
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as any;
      models = (data.models as any[])
        .filter(m =>
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes('generateContent')
        )
        .map(m => ({
          id: m.name.replace('models/', ''),          // e.g. "gemini-2.0-flash"
          label: m.displayName || m.name.replace('models/', '')
        }))
        .sort((a, b) => a.id.localeCompare(b.id));

    } else if (providerName === 'openrouter') {
      // OpenRouter requires these headers even for the models list
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://github.com/gorom-moshla',
          'X-Title': 'Gorom Moshla'
        }
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText.substring(0, 200)}`);
      }
      const data = await res.json() as any;
      models = (data.data as any[])
        .map(m => ({ id: m.id, label: m.name || m.id }))
        .sort((a, b) => a.label.localeCompare(b.label));

    } else if (providerName === 'huggingface') {
      // HuggingFace inference API — list models with serverless inference
      const res = await fetch(
        'https://huggingface.co/api/models?inference=warm&pipeline_tag=text-generation&limit=200&sort=downloads',
        { headers: { 'Authorization': `Bearer ${apiKey}` } }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as any[];
      models = data.map(m => ({ id: m.id, label: m.id }));
    }

    return { models };
  } catch (err: any) {
    return { models: [], error: err.message };
  }
}

// Generic fetch — OpenAI-compatible endpoints
// Retries automatically on 429 (rate limit) up to MAX_RETRIES times.
const MAX_RETRIES = 3;

async function fetchAIResponse(
  url: string,
  apiKey: string,
  model: string,
  prompt: string,
  streamController?: StreamController,
  extraHeaders: Record<string, string> = {}
): Promise<ValidatedAIResponse> {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    max_tokens: 8192,
  });

  let lastError = '';

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...extraHeaders
      },
      body
    });

    // ── Rate limited ────────────────────────────────────────────────
    if (response.status === 429) {
      let retryAfter = 10; // default wait
      try {
        const errJson = await response.json() as any;
        // OpenRouter puts retry_after_seconds in metadata
        retryAfter = Math.ceil(
          errJson?.error?.metadata?.retry_after_seconds
          ?? errJson?.error?.metadata?.retry_after_seconds_raw
          ?? parseInt(response.headers.get('Retry-After') || '10', 10)
        );
      } catch { /* ignore parse error, use default */ }

      // Cap wait to 60s — don't hang the user forever
      retryAfter = Math.min(retryAfter, 60);

      if (attempt < MAX_RETRIES - 1) {
        // Notify the UI so the user knows what's happening
        if (streamController) {
          streamController.enqueueChunk(`⏳ Rate limited. Retrying in ${retryAfter}s… (attempt ${attempt + 1}/${MAX_RETRIES})`);
        }
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      } else {
        lastError = `Rate limited (429). The model "${model}" is temporarily unavailable. Try a different model or wait ${retryAfter}s.`;
        throw new Error(lastError);
      }
    }

    // ── Other errors ────────────────────────────────────────────────
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API ${response.status}: ${errText}`);
    }

    // ── Success ─────────────────────────────────────────────────────
    const data = await response.json() as any;
    const rawText: string = data?.choices?.[0]?.message?.content || '';

    if (!rawText) {
      throw new Error('Empty response from AI provider');
    }

    let parsed: any;
    let jsonStr = rawText;
    let planDetails = '';
    const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
      planDetails = rawText.replace(jsonMatch[0], '').trim();
    } else {
      const start = rawText.indexOf('{');
      if (start !== -1) {
        let openBraces = 0;
        let end = -1;
        let inString = false;
        let escapeNext = false;
        
        for (let i = start; i < rawText.length; i++) {
          const char = rawText[i];
          if (escapeNext) {
            escapeNext = false;
            continue;
          }
          if (char === '\\') {
            escapeNext = true;
            continue;
          }
          if (char === '"') {
            inString = !inString;
            continue;
          }
          if (!inString) {
            if (char === '{') openBraces++;
            if (char === '}') {
              openBraces--;
              if (openBraces === 0) {
                end = i;
                break;
              }
            }
          }
        }
        
        if (end !== -1) {
          jsonStr = rawText.substring(start, end + 1);
          planDetails = rawText.substring(end + 1).trim() || rawText.substring(0, start).trim();
        }
      }
    }

    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      // If parsing fails, try to salvage conversational text instead of dumping raw JSON
      let salvagedResponse = planDetails || '';
      
      // Attempt to extract final_response via regex
      const frMatch = jsonStr.match(/"final_response"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (frMatch) {
        // Unescape newlines and quotes
        const extractedFr = frMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
        salvagedResponse = extractedFr + (salvagedResponse ? '\n\n' + salvagedResponse : '');
      }
      
      if (!salvagedResponse.trim()) {
        salvagedResponse = "⚠️ I encountered an internal formatting error while generating the code. Let's try breaking the request into smaller steps.";
      }

      return {
        intent: 'explain',
        steps: [],
        final_response: salvagedResponse,
        plan_details: planDetails
      };
    }

    // Ensure required fields exist, avoiding fallback to rawText (which contains JSON)
    const validated: ValidatedAIResponse = {
      intent: ['edit', 'create', 'explain', 'debug', 'refactor', 'plan'].includes(parsed.intent)
        ? parsed.intent
        : 'explain',
      title: parsed.title || '',
      thoughts: parsed.thoughts || '',
      steps: Array.isArray(parsed.steps) ? parsed.steps.slice(0, 20) : [],
      final_response: parsed.final_response || planDetails || (parsed.intent === 'plan' ? 'Plan generated.' : 'Task completed.'),
      plan_details: parsed.plan_details || planDetails || ''
    };

    // Stream the final response text to UI if streaming is active
    if (streamController) {
      const chunkSize = 10;
      const text = validated.final_response;
      for (let i = 0; i < text.length; i += chunkSize) {
        streamController.enqueueChunk(text.substring(i, i + chunkSize));
        await new Promise(resolve => setTimeout(resolve, 15));
      }
    }

    return validated;
  }

  // Should never reach here, but satisfies TypeScript
  throw new Error(lastError || 'Request failed after retries');
}

class GroqProvider implements AIProvider {
  name = 'Groq';
  constructor(private apiKey: string, private model: string) { }
  async generatePlan(userInput: string, context: any, streamController?: StreamController, history?: ConversationMessage[]): Promise<ValidatedAIResponse> {
    const prompt = PromptEngineering.buildFullPrompt(userInput, typeof context === 'string' ? context : JSON.stringify(context), history);
    return fetchAIResponse('https://api.groq.com/openai/v1/chat/completions', this.apiKey, this.model, prompt, streamController);
  }
}

class GeminiProvider implements AIProvider {
  name = 'Gemini';
  constructor(private apiKey: string, private model: string) { }
  async generatePlan(userInput: string, context: any, streamController?: StreamController, history?: ConversationMessage[]): Promise<ValidatedAIResponse> {
    const prompt = PromptEngineering.buildFullPrompt(userInput, typeof context === 'string' ? context : JSON.stringify(context), history);
    return fetchAIResponse('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', this.apiKey, this.model, prompt, streamController);
  }
}

class OpenRouterProvider implements AIProvider {
  name = 'OpenRouter';
  constructor(private apiKey: string, private model: string) { }
  async generatePlan(userInput: string, context: any, streamController?: StreamController, history?: ConversationMessage[]): Promise<ValidatedAIResponse> {
    const prompt = PromptEngineering.buildFullPrompt(userInput, typeof context === 'string' ? context : JSON.stringify(context), history);
    return fetchAIResponse(
      'https://openrouter.ai/api/v1/chat/completions',
      this.apiKey,
      this.model,
      prompt,
      streamController,
      { 'HTTP-Referer': 'https://github.com/gorom-moshla', 'X-Title': 'Gorom Moshla' }
    );
  }
}

class HuggingFaceProvider implements AIProvider {
  name = 'HuggingFace';
  constructor(private apiKey: string, private model: string) { }
  async generatePlan(userInput: string, context: any, streamController?: StreamController, history?: ConversationMessage[]): Promise<ValidatedAIResponse> {
    const prompt = PromptEngineering.buildFullPrompt(userInput, typeof context === 'string' ? context : JSON.stringify(context), history);
    return fetchAIResponse('https://api-inference.huggingface.co/v1/chat/completions', this.apiKey, this.model, prompt, streamController);
  }
}

export class ProviderFactory {
  static getProvider(): AIProvider {
    const config = vscode.workspace.getConfiguration('goromMoshla');
    const providerName = config.get<string>('aiProvider') || 'groq';
    const apiKey = config.get<string>('apiKey') || '';

    if (!apiKey) {
      throw new Error(`Gorom Moshla: API Key not set. Go to Settings → search "goromMoshla" → enter your API key.`);
    }

    const defaultModels: Record<string, string> = {
      groq: 'llama-3.3-70b-versatile',
      gemini: 'gemini-2.0-flash',
      openrouter: 'meta-llama/llama-3.1-8b-instruct:free',
      huggingface: 'meta-llama/Llama-3.2-3B-Instruct',
    };
    const model = config.get<string>('model') || defaultModels[providerName] || defaultModels['groq'];

    switch (providerName) {
      case 'groq': return new GroqProvider(apiKey, model);
      case 'gemini': return new GeminiProvider(apiKey, model);
      case 'openrouter': return new OpenRouterProvider(apiKey, model);
      case 'huggingface': return new HuggingFaceProvider(apiKey, model);
      default: throw new Error(`Unknown provider: ${providerName}`);
    }
  }
}
