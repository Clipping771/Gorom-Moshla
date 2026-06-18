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
    history?: ConversationMessage[],
    signal?: AbortSignal,
    attachments?: { type: string, data: string, name: string }[],
    mode?: string
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
      const res = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      if (res.status === 401 || res.status === 403) throw new Error('Invalid API key. Check your Groq key at console.groq.com.');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as any;
      models = (data.data as any[])
        .map(m => ({ id: m.id, label: m.id }))
        .sort((a, b) => a.id.localeCompare(b.id));

    } else if (providerName === 'gemini') {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`
      );
      if (res.status === 400 || res.status === 401 || res.status === 403) throw new Error('Invalid API key. Check your key at aistudio.google.com.');
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
      const res = await fetch(
        'https://huggingface.co/api/models?inference=warm&pipeline_tag=text-generation&limit=200&sort=downloads',
        { headers: { 'Authorization': `Bearer ${apiKey}` } }
      );
      if (res.status === 401 || res.status === 403) throw new Error('Invalid API key. Check your key at huggingface.co/settings/tokens.');
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
  prompt: string | any[],
  streamController?: StreamController,
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal,
  maxTokens: number = 4096
): Promise<ValidatedAIResponse> {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
    max_tokens: maxTokens,
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
      body,
      signal
    });

    if (signal?.aborted) throw new Error('Stopped by user.');

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
      let msg = errText;
      if (errText.toLowerCase().includes('request too large') || errText.toLowerCase().includes('rate_limit_exceeded') || response.status === 413) {
        msg = `[TOKEN LIMIT ERROR]\n\n${errText}\n\n💡 TIP: Your prompt context + Max Tokens exceeded the provider's limit. Try lowering "Max T." in the Settings (⚙️). Alternatively, switch to "Gemini" in the Settings (which has a much larger free limit) or upgrade your Groq API tier.`;
      }
      throw new Error(`API ${response.status}: ${msg}`);
    }

    // ── Stream Parser ───────────────────────────────────────────────
    let rawText = '';
    let jsonStarted = false;
    let inThought = false;
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    if (response.body) {
      // Consume as async iterable (works in Node.js 18+ fetch)
      for await (const chunk of response.body as any) {
        if (signal?.aborted) throw new Error('Stopped by user.');
        
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const data = JSON.parse(line.slice(6));
              const textChunk = data.choices?.[0]?.delta?.content || '';
              rawText += textChunk;
              
              if (!jsonStarted) {
                if (rawText.includes('```json') || rawText.includes('```\n{') || rawText.includes('{\n  "intent"')) {
                  jsonStarted = true;
                } else if (streamController) {
                  // Track thought block to suppress it from the UI stream
                  if (rawText.endsWith('<thought>') || rawText.includes('<thought>')) {
                    if (!rawText.includes('</thought>')) {
                      inThought = true;
                    } else {
                      inThought = false;
                    }
                  }
                  
                  if (!inThought && !textChunk.includes('<thought>') && !textChunk.includes('</thought>')) {
                    streamController.enqueueChunk(textChunk);
                  }
                }
              }
            } catch (e) {
              // ignore partial JSON parse errors
            }
          }
        }
      }
    }

    if (!rawText) {
      throw new Error('Empty response from AI provider');
    }

    // ── Extract JSON ────────────────────────────────────────────────
    let parsed: any;
    let jsonStr = rawText;
    let planDetails = '';
    const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
      planDetails = rawText.replace(jsonMatch[0], '').trim();
    } else {
      const start = rawText.indexOf('{');
      const end = rawText.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        jsonStr = rawText.substring(start, end + 1);
        planDetails = rawText.substring(0, start).trim();
      }
    }

    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      if (attempt < MAX_RETRIES - 1) {
        if (streamController) {
          streamController.enqueueChunk(`\n[⚠️ JSON error, retrying... (attempt ${attempt + 1}/${MAX_RETRIES})]\n`);
        }
        // Instead of throwing, we append to the prompt that the last JSON was malformed
        const retryPrompt = `${prompt}\n\nSYSTEM NOTE: Your last response was not valid JSON. Please ensure your response contains ONLY a strictly valid JSON object starting with { and ending with } inside a markdown code block.`;
        return fetchAIResponse(url, apiKey, model, retryPrompt, streamController, extraHeaders, signal);
      }

      // If parsing fails on the final attempt, try to salvage conversational text
      let salvagedResponse = planDetails || '';
      const frMatch = jsonStr.match(/"final_response"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (frMatch) {
        const extractedFr = frMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
        salvagedResponse = salvagedResponse ? `${salvagedResponse}\n\n${extractedFr}` : extractedFr;
      } else {
        salvagedResponse = salvagedResponse || rawText;
      }

      // Strip <thought>...</thought> tags from salvaged response
      salvagedResponse = salvagedResponse.replace(/<thought>[\s\S]*?<\/thought>/g, '').trim();

      return {
        intent: 'explain',
        title: 'Response',
        steps: [],
        final_response: salvagedResponse || "I encountered an error formatting my response. Please try again.",
        plan_details: planDetails
      };
    }

    // Extract thoughts and plan correctly
    let extractedThoughts = parsed.thoughts || '';
    let extractedPlan = parsed.plan_details || '';

    if (planDetails) {
      const thoughtMatch = planDetails.match(/<thought>([\s\S]*?)<\/thought>/);
      if (thoughtMatch) {
        extractedThoughts = thoughtMatch[1].trim();
      }
      extractedPlan = planDetails.replace(/<thought>[\s\S]*?<\/thought>/g, '').trim();
    }

    // Ensure required fields exist
    const validated: ValidatedAIResponse = {
      intent: ['edit', 'create', 'explain', 'debug', 'refactor', 'plan'].includes(parsed.intent)
        ? parsed.intent
        : 'explain',
      title: parsed.title || '',
      thoughts: extractedThoughts,
      steps: Array.isArray(parsed.steps) ? parsed.steps.slice(0, 20) : [],
      final_response: parsed.final_response || (parsed.intent === 'plan' ? 'Plan generated.' : 'Task completed.'),
      plan_details: extractedPlan || parsed.plan_details || ''
    };


    return validated;
  }

  // Should never reach here, but satisfies TypeScript
  throw new Error(lastError || 'Request failed after retries');
}

function processAttachments(promptStr: string, attachments?: { type: string, data: string, name: string }[]): string | any[] {
  if (!attachments || attachments.length === 0) return promptStr;
  let finalPrompt: string | any[] = promptStr;
  const textAtts = attachments.filter(a => a.type === 'text');
  if (textAtts.length > 0) {
    finalPrompt += '\n\n=== ATTACHED FILES ===\n' + textAtts.map(a => `--- ${a.name} ---\n${a.data}`).join('\n\n');
  }
  const imgAtts = attachments.filter(a => a.type === 'image');
  if (imgAtts.length > 0) {
    const contentArr: any[] = [{ type: 'text', text: finalPrompt }];
    imgAtts.forEach(img => contentArr.push({ type: 'image_url', image_url: { url: img.data } }));
    finalPrompt = contentArr;
  }
  return finalPrompt;
}

class GroqProvider implements AIProvider {
  name = 'Groq';
  constructor(private apiKey: string, private model: string, private maxTokens: number) { }
  async generatePlan(userInput: string, context: any, streamController?: StreamController, history?: ConversationMessage[], signal?: AbortSignal, attachments?: any[], mode: string = 'vibe'): Promise<ValidatedAIResponse> {
    const prompt = PromptEngineering.buildFullPrompt(userInput, typeof context === 'string' ? context : JSON.stringify(context), history, mode);
    return fetchAIResponse('https://api.groq.com/openai/v1/chat/completions', this.apiKey, this.model, processAttachments(prompt, attachments), streamController, {}, signal, this.maxTokens);
  }
}

class GeminiProvider implements AIProvider {
  name = 'Gemini';
  constructor(private apiKey: string, private model: string, private maxTokens: number) { }
  async generatePlan(userInput: string, context: any, streamController?: StreamController, history?: ConversationMessage[], signal?: AbortSignal, attachments?: any[], mode: string = 'vibe'): Promise<ValidatedAIResponse> {
    const prompt = PromptEngineering.buildFullPrompt(userInput, typeof context === 'string' ? context : JSON.stringify(context), history, mode);
    return fetchAIResponse('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', this.apiKey, this.model, processAttachments(prompt, attachments), streamController, {}, signal, this.maxTokens);
  }
}

class OpenRouterProvider implements AIProvider {
  name = 'OpenRouter';
  constructor(private apiKey: string, private model: string, private maxTokens: number) { }
  async generatePlan(userInput: string, context: any, streamController?: StreamController, history?: ConversationMessage[], signal?: AbortSignal, attachments?: any[], mode: string = 'vibe'): Promise<ValidatedAIResponse> {
    const prompt = PromptEngineering.buildFullPrompt(userInput, typeof context === 'string' ? context : JSON.stringify(context), history, mode);
    return fetchAIResponse(
      'https://openrouter.ai/api/v1/chat/completions',
      this.apiKey, this.model, processAttachments(prompt, attachments), streamController,
      { 'HTTP-Referer': 'https://github.com/gorom-moshla', 'X-Title': 'Gorom Moshla' },
      signal,
      this.maxTokens
    );
  }
}

class HuggingFaceProvider implements AIProvider {
  name = 'HuggingFace';
  constructor(private apiKey: string, private model: string, private maxTokens: number) { }
  async generatePlan(userInput: string, context: any, streamController?: StreamController, history?: ConversationMessage[], signal?: AbortSignal, attachments?: any[], mode: string = 'vibe'): Promise<ValidatedAIResponse> {
    const prompt = PromptEngineering.buildFullPrompt(userInput, typeof context === 'string' ? context : JSON.stringify(context), history, mode);
    return fetchAIResponse('https://api-inference.huggingface.co/models/' + this.model + '/v1/chat/completions', this.apiKey, this.model, processAttachments(prompt, attachments), streamController, {}, signal, this.maxTokens);
  }
}

export class ProviderFactory {
  static getProvider(): AIProvider {
    const config = vscode.workspace.getConfiguration('goromMoshla');
    const providerName = config.get<string>('aiProvider') || 'groq';
    const apiKey = config.get<string>('apiKey') || '';
    const maxTokens = config.get<number>('maxTokens') || 4096;

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
      case 'groq': return new GroqProvider(apiKey, model, maxTokens);
      case 'gemini': return new GeminiProvider(apiKey, model, maxTokens);
      case 'openrouter': return new OpenRouterProvider(apiKey, model, maxTokens);
      case 'huggingface': return new HuggingFaceProvider(apiKey, model, maxTokens);
      default: throw new Error(`Unknown provider: ${providerName}`);
    }
  }
}
