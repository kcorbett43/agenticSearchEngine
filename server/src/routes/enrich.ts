import { Router } from 'express';
import { z } from 'zod';
import { runAgent } from '../services/researchAgent.js';
import { setTrustedFact } from '../services/factsStore.js';

export const enrichRouter = Router();

const EnrichRequestSchema = z.object({
  query: z.string().min(2),
  variables: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.enum(['boolean', 'string', 'number', 'date', 'url', 'text']).optional(),
        description: z.string().optional()
      })
    )
    .optional(),
  sessionId: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  entity: z.string().min(1).optional(),
  researchIntensity: z.enum(['low', 'medium', 'high']).optional(),
  corrections: z
    .array(
      z.object({
        entity: z.string().min(1).optional(),
        field: z.string().min(1),
        value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
        source: z.string().url().optional()
      })
    )
    .optional()
});

enrichRouter.post('/', async (req, res) => {
  const parsed = EnrichRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }

  try {
    // Apply any trusted fact corrections provided by the caller (feedback learning)
    if (Array.isArray(parsed.data.corrections) && parsed.data.corrections.length > 0) {
      const fallbackEntity = parsed.data.entity || 'global';
      const username = parsed.data.username;
      for (const c of parsed.data.corrections) {
        await setTrustedFact({
          entity: c.entity || fallbackEntity,
          field: c.field,
          value: c.value as any,
          source: c.source,
          updatedBy: username
        });
      }
    }

    const result = await runAgent(
      parsed.data.query,
      parsed.data.variables ?? [],
      parsed.data.sessionId,
      parsed.data.username,
      parsed.data.entity,
      parsed.data.researchIntensity ?? 'medium'
    );
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to run enrichment' });
  }
});


