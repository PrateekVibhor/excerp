# Excerp

Tech moves faster than you can read. Excerp is a pocket coach for techies: stay current in 10 minutes a day, see exactly what to learn next, and meet people reading what you read.

## What it does

1. **Swipe cards with quizzes and a Verified badge.** The Feed shows short summaries of recent articles from tech companies. Swipe to save or skip. Open an article and take its quiz; passing it marks the article Verified on your profile and on the leaderboard.
2. **A skills list built from a pasted job posting.** Paste a job posting and Excerp pulls out the skills it asks for, searches the web for sources for each one, and rates your coverage of each skill as strong, thin or missing. The list builds in stages and you can stop a build while it runs.
3. **Reader messaging with report and block.** Readers can send message requests to other readers. Messages have Requests, Messages and Sent views, and a reader can report or block another reader.

## How it uses Nebius and NVIDIA

Every language-model call goes through one function, `createNebiusChat` in `server/src/llm.ts`. It talks to the OpenAI-compatible endpoint of **Nebius Token Factory** (`https://api.tokenfactory.nebius.com/v1`). The model is set by `NEBIUS_MODEL`; the value in `server/.env.example` is **`nvidia/nemotron-3-super-120b-a12b`** (NVIDIA Nemotron). `NEBIUS_JUDGE_MODEL` can name a smaller model for judging web pages in skills-list builds; if unset, the main model judges.

Where the model is created and called:

- `server/src/pipeline.ts` — the Feed pipeline: summaries and quizzes for found articles.
- `server/src/worker.ts` — runs that pipeline on a schedule.
- `server/src/backfillQuiz.ts` — adds quizzes to existing articles.
- `server/src/courses/runner.ts` — creates the model (and the optional judge model) for skills-list builds.
- `server/src/courses/pipeline/*.ts` (for example `postings.ts`, `merge.ts`, `chapters.ts`, `accuracy.ts`, `sectionQuiz.ts`) — the stages that read postings, merge skills, check sources and write quiz questions.

**Tavily** provides web search and page extraction:

- `server/src/tavily.ts` — finds articles for the Feed.
- `server/src/courses/pipeline/clients.ts` (`createTavily`) — search and extract for skills lists.
- Credit use is capped per source search and per build (`COURSE_FIND_CREDITS`, `COURSE_BUILD_CREDITS`).

An optional YouTube client (`YOUTUBE_API_KEY`, same file) looks up videos for skills lists.

## Architecture

- **App:** Expo (React Native, expo-router, TypeScript) in `app/` and `src/`. It reads its data from the server, or from built-in sample articles in mock mode.
- **Server:** Node (24 or newer) with Fastify and Postgres, in `server/`. `src/api.ts` is the API; `src/worker.ts` and `src/courseWorker.ts` are the background workers; SQL migrations are in `server/migrations/`.
- **Pipelines:** the Feed pipeline (`server/src/pipeline.ts`) and the skills-list pipeline (`server/src/courses/pipeline/`) are staged. Each stage records its progress, search credits and tokens, and a failing stage stops the run with its name and reason.
- **Tests:** jest for the app, Node's built-in test runner for the server (each test file uses a throwaway Postgres schema), and Maestro flows in `e2e/` for the simulator.

## Run it locally

You need Node 24 or newer, a local Postgres, and for the server a Tavily key and a Nebius key.

**Server**

```
cd server
npm install
cp .env.example .env      # fill in the values; server/.env is git-ignored
npm run api               # the API
npm run worker            # the Feed pipeline on a schedule (needs the keys)
npm run course:worker     # runs skills-list builds (needs COURSE_RUNNER_SECONDS set)
```

The schema is in `server/schema.sql` and `server/migrations/`.

**App**

```
npm install
cp .env.example .env
npx expo start --clear
```

With `EXPO_PUBLIC_DATA_SOURCE=mock` (the default in `.env.example`) the app uses its built-in sample articles and needs no server. With `api`, set `EXPO_PUBLIC_API_URL` to your server. `eas.json` and `server/Caddyfile` use the placeholder `YOUR-API-HOST`; replace it with your own host. Google and Apple sign-in need your own client ids and keys.

**Tests**

```
npx tsc --noEmit && npm test          # app
cd server && npm run typecheck && npm test   # server (needs local Postgres)
```

**Environment variables (names only)**

- App: `EXPO_PUBLIC_DATA_SOURCE`, `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, `EXPO_PUBLIC_E2E` (test builds only).
- Server: `DATABASE_URL`, `TAVILY_API_KEY`, `NEBIUS_API_KEY`, `NEBIUS_MODEL`, `NEBIUS_JUDGE_MODEL`, `YOUTUBE_API_KEY`, `GOOGLE_WEB_CLIENT_ID`, `ALLOW_ANY_GOOGLE_ACCOUNT`, `APPLE_BUNDLE_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_PRIVATE_KEY_PATH`, `TRUST_PROXY`, `DELETION_LOG_PATH`, `RUN_INTERVAL_MINUTES`, `RUN_ON_START`, `MAX_PER_COMPANY`, `LIST_REFRESH_MINUTES`, `COURSE_RUNNER_SECONDS`, `COURSE_FIND_CREDITS`, `COURSE_BUILD_CREDITS`, `POSTGRES_PASSWORD` (Docker Compose only).

## Limitations

- English only.
- A pasted job posting is limited to 4,000 characters.
- How well a skill is covered depends on what the web search finds for it.
- The iOS app is distributed through TestFlight and App Store review. Android is untested.
- A hosted backend is not always running, so the app may not be able to reach one; run your own server to try it.

## License

MIT. See `LICENSE`.

Built by Prateek and Chandrima.
