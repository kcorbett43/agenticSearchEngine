import { Router } from 'express';
import { z } from 'zod';
import { validateSources } from '../services/validation.js';

export const validateRouter = Router();

const ValidateRequestSchema = z.object({
  query: z.string().min(2),
  config: z
    .object({
      kInitial: z.number().int().min(1).max(30).optional(),
      kMax: z.number().int().min(1).max(50).optional(),
      maxLoops: z.number().int().min(1).max(5).optional(),
      targetConf: z.number().min(0).max(1).optional(),
      selfConsistencyRuns: z.number().int().min(1).max(7).optional(),
      weights: z
        .object({
          diversity: z.number().min(0).max(1).optional(),
          quality: z.number().min(0).max(1).optional(),
          recency: z.number().min(0).max(1).optional(),
          consistency: z.number().min(0).max(1).optional()
        })
        .optional()
    })
    .optional()
});

validateRouter.post('/', async (req, res) => {
  const parsed = ValidateRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }
  try {
    const out = await validateSources(parsed.data.query, parsed.data.config);
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Validation failed' });
  }
});


