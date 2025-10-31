## Artisan Research (TypeScript)

AI-powered research and enrichment web app. Enter natural language queries about companies or people and get structured, sourced "magic variables". Handles different output types (boolean questions, specific answers, contextual info) based on the user's input.

### Stack
- Server: Node + Express + TypeScript
- Client: Vite + React + TypeScript
- Providers: OpenAI (LLM), Tavily/SerpAPI (web search)

### Setup
1. Install deps
   - Server
     - `cd server && npm install`
   - Client
     - `cd client && npm install`

2. Environment variables (create a `.env` file in `server/`)
```
PORT=4001
OPENAI_API_KEY=your_openai_key
OPENAI_MODEL=gpt-4o-mini
SEARCH_PROVIDER=tavily
TAVILY_API_KEY=your_tavily_key
# or use SerpAPI instead:
# SEARCH_PROVIDER=serpapi
# SERPAPI_API_KEY=your_serpapi_key
```

3. Run
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


