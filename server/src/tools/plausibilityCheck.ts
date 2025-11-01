import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getDefaultLlm } from '../services/providers.js';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

export class PlausibilityCheckTool extends StructuredTool {
  name = 'evaluate_plausibility';
  description = `Evaluate the plausibility of conflicting claims or uncertain information. Use this when you encounter conflicting sources or claims that seem unusual.

IMPORTANT: Input MUST be valid JSON with:
- "claims": array of claim strings (REQUIRED) - At least one claim to evaluate. Example: ["claim A", "claim B"]
- "context": string (optional) - Additional research context that helps evaluate the claims

Example: {"claims":["Company X was acquired in 2024","Company X was acquired in 2023"],"context":"Multiple sources conflict on acquisition date"}

Do NOT call this tool without providing at least one claim. Returns JSON with plausibility scores and reasoning for each claim.`;
  schema = z.object({
    claims: z.array(z.string().min(1)).min(1),
    context: z.string().optional()
  }).strict();

  async _call(input: z.infer<typeof this.schema>): Promise<string> {
    const { claims, context } = input;
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
    const content = typeof response.content === 'string' ? response.content : String(response.content);

    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return jsonMatch[0];
      }
    } catch {}

    return content;
  }
}

export const plausibilityCheckTool = new PlausibilityCheckTool();
