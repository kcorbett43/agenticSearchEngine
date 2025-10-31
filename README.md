## Artisan Research (TypeScript)

AI-powered research and enrichment web app. Enter natural language queries about companies or people and get structured, sourced "magic variables". Handles different output types (boolean questions, specific answers, contextual info) based on the user's input.

### Stack
- Server: Node + Express + TypeScript
- Client: Vite + React + TypeScript
- Database: Postgres (pgvector)
- Providers: OpenAI (LLM), Tavily/SerpAPI (web search)

### Setup (Docker - recommended)
1. Environment variables
   - Create a `.env` file at repo root (same folder as `docker-compose.yml`) and set any keys you have:
```
OPENAI_API_KEY=your_openai_key
OPENAI_MODEL=gpt-4o-mini
SEARCH_PROVIDER=tavily
TAVILY_API_KEY=your_tavily_key
# or use SerpAPI instead:
# SEARCH_PROVIDER=serpapi
# SERPAPI_API_KEY=your_serpapi_key
```

2. Build and start everything
```
docker compose up --build
```

This will:
- Build the server and client images
- Start the database, wait for it to be healthy
- Start the server (auto-installs dependencies via entrypoint if needed)
- Start the client
- Run in the foreground (use `-d` flag to run in detached mode)

3. Run database migrations (first time setup)
```
docker compose exec server npm run migrate
```

4. Access
   - Client (Vite dev server): http://localhost:5173
   - Server (Express API): http://localhost:4001
   - Postgres (pgvector): localhost:5432 (user: artisan, password: artisan, db: artisan)

5. Stop
```
docker compose down
```

**Live development**: Source folders `client/` and `server/` are mounted into their containers; changes hot-reload automatically.

### Setup (Local - optional)
1. Install deps
   - Server
     - `cd server && npm install`
   - Client
     - `cd client && npm install`

2. Environment variables (create a `.env` file in `server/`)
```
PORT=4001
DATABASE_URL=postgres://artisan:artisan@localhost:5432/artisan
OPENAI_API_KEY=your_openai_key
OPENAI_MODEL=gpt-4o-mini
SEARCH_PROVIDER=tavily
TAVILY_API_KEY=your_tavily_key
# or use SerpAPI instead:
# SEARCH_PROVIDER=serpapi
# SERPAPI_API_KEY=your_serpapi_key
```

3. Run database migrations
```
cd server
npm run migrate
```

4. Run
```
# terminal 1
cd server
npm run dev

# terminal 2
cd client
# optional: set VITE_API_URL if server not at localhost:4001
npm run dev
```

Visit the client URL printed by Vite (typically `http://localhost:5173`).

### API
POST `/api/enrich`
```
{ "query": string, "variables"?: [{ "name": string, "type"?: "boolean"|"string"|"number"|"date"|"url"|"text", "description"?: string }] }
```

Response
```
{
  "intent": "boolean" | "specific" | "contextual",
  "variables": [
    { "name": string, "type": string, "value": any, "confidence": number, "sources": [{ "title"?: string, "url": string, "snippet"?: string }] }
  ],
  "notes"?: string
}
```

### Notes
- Without API keys, the app uses a minimal mock LLM and returns limited results.
- Intent handling: boolean/specific/contextual is auto-detected and the returned variables reflect that.
- All values include source attributions where available.
- Long-term memory: User conversations are automatically summarized and persisted to Postgres when short-term memory exceeds the window. Pass `username` in API requests to enable this.


