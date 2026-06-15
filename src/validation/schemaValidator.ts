import { AIResponseSchema, ValidatedAIResponse } from '../ai/schema';
import { z } from 'zod';

export class SchemaValidator {
  public static validate(rawJsonString: string): ValidatedAIResponse {
    try {
      const parsed = JSON.parse(rawJsonString);
      return AIResponseSchema.parse(parsed);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(`Schema Validation Failed: ${error.message}`);
      } else if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON format: ${error.message}`);
      }
      throw error;
    }
  }
}
