# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev           # Start server with .env (node --env-file=.env ./app.js)
npm run build         # Prisma generate + tsup bundle (ESM + CJS + DTS)
npm run db:gen        # Generate Prisma migration
npm run db:reset      # Wipe .mi.json, .bot.json, and SQLite DB
npx tsc --noEmit     # Type-check only
```

There are no tests.

## Architecture

MiGPT bridges Xiaomi smart speakers (小爱音箱) with OpenAI-compatible LLMs. A Node.js HTTP server (`app.js`) serves a configuration SPA (`speakers-editor.html`) and REST APIs, while the core runtime (`src/`) manages speaker communication, AI conversations, and persistence.

### Runtime stack

```
app.js  (HTTP server + REST API)
  └─ MiGPTManager  (src/manager.ts) — multi-account lifecycle
       └─ MiGPT  (src/index.ts) — one per Xiaomi account
            ├─ AISpeaker[]  (src/services/speaker/ai.ts)
            │    └─ Speaker  (src/services/speaker/speaker.ts)
            │         └─ BaseSpeaker  (src/services/speaker/base.ts)
            │              ├─ MiNA  — mi-service-lite: message poll + audio playback
            │              └─ MiIOT — mi-service-lite: device actions (TTS, wake-up)
            └─ MyBot[]  (src/services/bot/index.ts)
                 ├─ ConversationManager  — bot/master/room config + message history
                 │    └─ BotConfigStore  — persisted bot index (DB or .bot.<id>.json)
                 ├─ MemoryManager  — short-term + long-term memory via LLM summarization
                 └─ openai  (src/services/openai.ts)  — OpenAI-compatible chat stream
```

### Data flow (per speaker)

1. `Speaker.run()` polls MiNA for new messages in a heartbeat loop
2. Incoming message text is matched against `AISpeaker.commands` (wake-up, exit, switch speaker, ask AI)
3. `askAIForAnswer()` calls `MyBot.ask()` → builds system prompt from bot/master/room/memory → streams LLM response
4. Response is played via MiNA (audio URL) or MiIOT (TTS text), with polling to detect playback completion

### Database (SQLite via Prisma)

- **WebUser** — login accounts for the config UI
- **XiaomiAccount** — Xiaomi credentials + shared speaker defaults (keywords, prompts)
- **Speaker** — per-speaker device config (DID, model, TTS commands, bot/master/room overrides)
- **User/Room/Message/Memory** — bot personas, conversation rooms, chat history, memory records

### Key patterns

- **`.mi.json` isolation**: `mi-service-lite` uses `.mi.json` for auth tokens. Multi-account support copies per-account `.mi-{accountId}.json` to `.mi.json` before `initMiServices()` and saves back afterward.
- **Config storage**: Originally `.migpt.js` file. Now stored in DB via `db-config.ts`. A migration path (`migrateFromFile()`) auto-imports on first run.
- **Bot identity**: Each speaker has a `BotConfigStore` keyed by speaker ID (DB `botIndex` field). Stores pointers to User records for bot (AI persona) and master (human user). If records are lost, `_initConfig()` recreates them from defaults.
- **Keyword arrays**: Empty arrays `[]` suppress the corresponding AISpeaker behavior. `undefined` (key absent) triggers hardcoded AISpeaker defaults. The `buildMiGPTConfig()` function uses `defaults[key] ?? undefined` to distinguish these cases.
- **Build output**: `tsup` bundles `src/index.ts` into `dist/index.js` (ESM) + `dist/index.cjs` (CJS) + `dist/index.d.ts` (types). `app.js` imports from `./dist/index.js`.

### 业务要求
1. 该应用支持多小米账号、多音箱设备接入OpenAI。任何一个小米账户配置错误，都不应该影响应用正常启动。
2. 用户修改了自己账号下的信息并重启，只重启该账号下的音箱服务，其他账号下的音箱服务不受影响
3. 删除用户账号，请删除该账号下所有相关联的信息。
4. .migpt.js只一个数据模板，减少用户的输入。用户录入的信息，都要保存到用户关联的相关表中。

### AI行为要求
1. 每次改完bug后，请测试一下。


### Additional instruction
- 当你需要编写或修改前端视觉文件时，去参考这个文件[text](.claude/view.md)这个文件
