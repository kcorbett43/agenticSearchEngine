import { DynamicTool } from '@langchain/core/tools';
import { getDefaultLlm } from '../services/providers.js';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

export const plausibilityCheckTool = new DynamicTool({
  name: 'evaluate_plausibility',
  description: `Evaluate the plausibility of conflicting claims or uncertain information. Use this when you encounter conflicting sources or claims that seem unusual.

IMPORTANT: Input MUST be valid JSON with:
- "claims": array of claim strings (REQUIRED) - At least one claim to evaluate. Example: ["claim A", "claim B"]
- "context": string (optional) - Additional research context that helps evaluate the claims

Example: {"claims":["Company X was acquired in 2024","Company X was acquired in 2023"],"context":"Multiple sources conflict on acquisition date"}
Alternative: If only one claim, you can use {"claim":"single claim string","context":"..."} which will be converted to an array.

Do NOT call this tool without providing at least one claim. Returns JSON with plausibility scores and reasoning for each claim.`,
  func: async (input: string) => {
    let claims: string[] = [];
    let context = '';
    
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed?.claims)) claims = parsed.claims as string[];
      else if (typeof parsed?.claim === 'string') claims = [parsed.claim];
      if (typeof parsed?.context === 'string') context = parsed.context;
    } catch {
      // If not JSON, treat input as a single claim
      if (typeof input === 'string' && input.trim()) {
        claims = [input];
      }
    }
    
    // Normalize, dedupe, and filter empty values
    claims = Array.from(new Set(
      (Array.isArray(claims) ? claims : [])
        .map((c: any) => typeof c === 'string' ? c.trim() : String(c ?? ''))
        .filter((c: string) => c.length > 0)
    ));

    if (claims.length === 0) {
      return JSON.stringify({
        error: 'No claims provided',
        hint: 'Pass JSON like {"claims":["claim A","claim B"],"context":"..."} or a non-empty claim string.'
      });
    }
    
    const model = getDefaultLlm();
    const system = `You are a plausibility evaluator. Assess whether claims make logical sense in the real world.
Consider:
- Legal/physical impossibilities
- Consistency with well-known facts
- Whether claims seem like jokes, satire, or hoaxes
- Whether claims align with normal business/life patterns
- If multiple claims conflict, which is more plausible?
- Do all entities line up correctly or is there ambiguity?

Return JSON: {"evaluations": [{"claim": string, "plausible": boolean, "confidence": 0-1, "reasoning": string}]}`;
    
    const human = new HumanMessage(
      context 
        ? `Context: ${context}\n\nClaims to evaluate:\n${claims.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
        : `Evaluate these claims:\n${claims.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
    );
    
    const response = await model.invoke([new SystemMessage(system), human]);
    const content = typeof response.content === 'string' 
      ? response.content 
      : String(response.content);
    
    // Try to extract JSON if wrapped
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return jsonMatch[0];
      }
    } catch {}
    
    return content;
  }
});
