import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { enrichRouter } from './routes/enrich.js';
import { pool } from './services/db.js';

dotenv.config({ path: process.env.NODE_ENV === 'production' ? '.env' : '../.env' });

// Test database connection
pool.query('SELECT NOW()').then(() => {
  console.log('Database connected');
}).catch((err) => {
  console.error('Database connection failed:', err);
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/enrich', enrichRouter);

const PORT = process.env.PORT ? Number(process.env.PORT) : 4001;
app.listen(PORT, () => {
  console.log(`artisan server listening on http://localhost:${PORT}`);
});


