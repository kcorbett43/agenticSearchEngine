## Agentic Search Engine

An AI-powered research and enrichment web app. Takes in natural language queries and returns structured, sourced variables. Handles different output types (boolean, questions, specific answers, contextual information) based on the users input.

Outputs concise answers to queries. Click on "View Full JSON Response" to see the
full variable output.

### Environment file (.env)
Create a `.env` file at the repo root with the following variables:
```
PORT=4001
OPENAI_API_KEY=
SEARCH_PROVIDER=tavily
TAVILY_API_KEY=
OPENAI_MODEL=
  eg gpt-5 or gpt-4o-mini
```

### Setup (Docker)
1. Environment variables
   - Create a `.env` file at repo root (same folder as `docker-compose.yml`) and set these keys:
```
OPENAI_API_KEY=your_openai_key
OPENAI_MODEL=gpt-4o-mini
SEARCH_PROVIDER=tavily
TAVILY_API_KEY=your_tavily_key
```

2. Build and start everything
```
docker compose up --build
```

3. Run database migrations (first time setup)
```
docker compose exec server npm run migrate
```

4. Access
   - Client: http://localhost:5173
   - Postgres (pgvector): localhost:5432 (user: artisan, password: artisan, db: artisan)

5. Stop
```
docker compose down
```


### Research Agent Overview
- **Intent & routing**: The agent first classifies intent (boolean/specific/contextual) and infers context (entity type, attribute constraints, evidence policy, vocabulary hints) to guide research.
- **Research intensity**: Caps steps and web searches by intensity (`low`/`medium`/`high`).
- **Tools**: Uses `web_search`, `latest_finder` (recency-focused), `knowledge_query` (DB lookups), and `evaluate_plausibility`. Duplicate tool calls with identical arguments are blocked and cached.
- **Evidence handling**: Aggregates results, dedupes by URL, and ranks sources by an internal authority score (e.g., SEC/Wikidata/Wikipedia/major news > blogs). A citations gate enforces corroboration (e.g., dates/numbers/strings prefer ≥2 agreeing sources; optional high-authority requirement).
- **Stopping**: Two layers:
  - Stop when no more tools are being used.
  - A supervisor "stop judge" LLM can instruct finalization once evidence appears sufficient.
- **Finalization**: A separate finalizer LLM produces strict JSON. The agent validates required fields, injects a default subject when applicable, and re-prompts if citations are insufficient.
- **Entities & memory**: Resolves subjects to canonical IDs, merges user trusted facts (prefers higher confidence), stores stable facts to the facts store, and periodically summarizes chat into durable long‑term memory when the short‑term window is exceeded.

The implementation lives in `server/src/services/researchAgent.ts`


### Further Development

- latency: web requests are responsible for most of the latency.
  - next steps:
    - keep summaries of webpages traversed in DB.
    - create more "facts" as agents scan through trusted sources.
    - enhance the "judge" model to more accurately determine when enough infomation has been provided.
      - a binary classifier may be better than an LLM in this case or in addition to the judeg model.
    - run tools at each iteration in parallel, have an "aggregation" model to combine sources and provide context to the "system" model.

- web contexualization: currently web pages are searched one by one through Tavily
  - next steps:
    - gather web pages from each page visited and add those to potential future searches.

- UI
  - next steps:
    - Give users context for what tools and actions the LLM is taking and allow for early stopping.

- Facts: Currently facts are given a confidence score by the LLM. If a user implicitly gives credence to a fact, that confidence score is increased.
  - next steps:
    - more robust fact handling: outside of the user workflow, conduct searches on existing facts to corrobarate. Update confidence score based on independent searches.
    - remove stale facts after a certain amount of time.
