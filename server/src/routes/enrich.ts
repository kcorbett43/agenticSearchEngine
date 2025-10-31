import { Router } from 'express';
import { z } from 'zod';
import { runEnrichment } from '../services/enrich.js';

export const enrichRouter = Router();

const EnrichRequestSchema = z.object({
  query: z.string().min(2),
  // optional hint for expected variables to return (names and desired types)
  variables: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.enum(['boolean', 'string', 'number', 'date', 'url', 'text']).optional(),
        description: z.string().optional()
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
    const result = await runEnrichment(parsed.data.query, parsed.data.variables ?? []);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to run enrichment' });
  }
});


