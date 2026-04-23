# LinkedIn Automation

Multi-profile LinkedIn **inbox reader**, **mention checker**, **profile scraper**, and **reply tool** — built in TypeScript with Playwright. Runs on Jenkins, exposes a local HTTP API on port 9000, and integrates with OpenClaw / Claude remote functions via webhook.

---

## Architecture

```
Jenkins (cron every 2h)
    ├── npm run build
    ├── Scrape inbox → /tmp/linkedin_inbox_*.json
    ├── Check mentions → /tmp/linkedin_mentions_*.json
    ├── Analyze & report → output/linkedin_inbox_check_latest.json
    └── Keep API server alive on port 9000

API Server (port 9000)
    ├── GET  /needs-reply       ← OpenClaw / Claude polls this
    ├── GET  /mentions          ← new @mentions across all profiles
    ├── POST /run/all           ← trigger a live scrape on demand
    ├── POST /reply             ← send a reply to a conversation
    └── ... (full endpoint list below)
```

---

## Quick Start

### 1. Install

```bash
git clone https://github.com/ahmadsyedanwar/linkedIn-automation.git
cd linkedin-automation
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# edit .env — set PORT, LINKEDIN_API_TOKEN, LINKEDIN_WEBHOOK_URL
```

### 3. Log in to LinkedIn in Chromium

Open Chromium for each profile (`Default`, `Profile 1`, …) and log in to LinkedIn. The scraper reuses your existing sessions — no passwords stored.

### 4. Run

```bash
# Scrape inbox (all profiles)
npm run inbox

# Check mentions
npm run mentions

# Scrape + analyze + report
npm run check

# Start the API server
npm run server
```

---

## Workflow

### Step 1 — Scrape inbox

```bash
npm run inbox
# or single profile:
node --import ./register.js src/inbox.ts --profile Default
```

Scrapes the last 10 conversations × last 5 messages per thread. Flags `needs_reply: true` on any thread where the last message is **incoming** (the connection replied and is waiting).

Output: `/tmp/linkedin_inbox_Default_20260423T063710.json`

### Step 2 — Check mentions

```bash
npm run mentions
# or:
node --import ./register.js src/mentionChecker.ts --profile Default
```

Navigates to `/notifications/?filter=mentions`, clicks "Load new notifications", and extracts all `article.nt-card` elements whose headline contains "mentioned you". Tracks seen mention IDs in `/tmp/linkedin_mentions_seen.json` so only genuinely new mentions are flagged `is_new: true`.

Output: `/tmp/linkedin_mentions_Default_20260423T070107.json`

### Step 3 — Scrape connection profile (for AI reply generation)

```bash
# By LinkedIn URL
node --import ./register.js src/profileScraper.ts \
  --url "https://www.linkedin.com/in/username" \
  --profile Default

# Look up from inbox JSON by thread ID
node --import ./register.js src/profileScraper.ts \
  --inbox-json /tmp/linkedin_inbox_Default_*.json \
  --thread-id THREAD_ID \
  --profile Default
```

Extracts: name, headline, location, about, experience, education, connection degree — structured for AI to generate a personalized reply.

Output: `/tmp/linkedin_bio_Mark_Samuel_20260423T063845.json`

### Step 4 — Send reply

```bash
node --import ./register.js src/inbox.ts \
  --reply \
  --profile Default \
  --conversation-id 2-MGZmOWE3... \
  --text "Thanks for reaching out!"

# or via the API:
curl -X POST http://localhost:9000/reply \
  -H "Authorization: Bearer $LINKEDIN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"profile":"Default","conversation_id":"2-MGZm...","text":"Hi!"}'
```

---

## API Server

Start with `npm run server` (or `npm run server:build` after `npm run build`). Default port: **9000**.

### Authentication

Set `LINKEDIN_API_TOKEN` in `.env`. All requests must include:
```
Authorization: Bearer <token>
```
Leave `LINKEDIN_API_TOKEN` empty to run open (dev only).

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness check — no auth required |
| `GET` | `/inbox` | Latest inbox results (all profiles) |
| `GET` | `/inbox/:profile` | Latest inbox for one profile |
| `GET` | `/mentions` | Latest mention results (all profiles) |
| `GET` | `/mentions/:profile` | Latest mentions for one profile |
| `GET` | `/needs-reply` | All threads needing reply across all profiles |
| `GET` | `/status` | Latest `linkedin_status.json` |
| `GET` | `/profile?url=<url>&profile=Default` | Scrape a profile bio on demand |
| `POST` | `/run/inbox` | Trigger live inbox scrape (body: `{"profile":"Default"}`) |
| `POST` | `/run/mentions` | Trigger live mention check |
| `POST` | `/run/all` | Trigger inbox + mentions together |
| `POST` | `/reply` | Send a reply (`profile`, `conversation_id`, `text`) |
| `GET` | `/webhook/test` | Fire a test payload to `LINKEDIN_WEBHOOK_URL` |

### Example — poll needs-reply

```bash
curl http://localhost:9000/needs-reply \
  -H "Authorization: Bearer $LINKEDIN_API_TOKEN"
```

```json
{
  "ok": true,
  "data": [
    {
      "profile_key": "Default",
      "account_name": "Ahmad Syed Anwar",
      "conversation_id": "2-MGZmOWE3...",
      "connection_name": "Mark Samuel",
      "last_incoming_message": "Thanks for endorsing me for Executive Coaching!",
      "sender_profile_url": "https://www.linkedin.com/in/...",
      "timestamp": "4:18 AM",
      "messages": [ ... ]
    }
  ],
  "timestamp": "2026-04-23T07:00:00.000Z"
}
```

---

## OpenClaw / Claude Integration

### Webhook (push)

Set `LINKEDIN_WEBHOOK_URL` in `.env` to your OpenClaw gateway webhook URL. After every Jenkins run the server fires a POST:

```json
{
  "event": "full_run_complete",
  "needs_reply_count": 1,
  "new_mention_count": 2,
  "timestamp": "2026-04-23T07:00:00.000Z"
}
```

OpenClaw gateway is already running on port `18789`. Example `.env` value:

```
LINKEDIN_WEBHOOK_URL=http://localhost:18789/webhook/linkedin
```

### Poll (pull)

From a Claude remote function or OpenClaw `exec` skill, call the API directly:

```bash
# Get everything needing attention
curl http://localhost:9000/needs-reply -H "Authorization: Bearer $TOKEN"
curl http://localhost:9000/mentions    -H "Authorization: Bearer $TOKEN"

# Trigger a live scrape
curl -X POST http://localhost:9000/run/all -H "Authorization: Bearer $TOKEN"
```

---

## Jenkins Pipeline

The `Jenkinsfile` defines a declarative pipeline:

```
Triggers:  cron('0 */2 * * *')   — every 2 hours

Stages:
  1. Checkout        git pull origin main
  2. Install         npm ci
  3. Build           tsc
  4. Scrape Inbox    node ... src/inbox.ts
  5. Check Mentions  node ... src/mentionChecker.ts
  6. Analyze         node ... src/inboxCheck.ts --analyze-only
  7. Ensure Server   start src/server.ts on port 9000 if not running
  8. Notify Webhook  curl /webhook/test
```

**Jenkins credentials required:**
- `LINKEDIN_API_TOKEN`
- `LINKEDIN_WEBHOOK_URL`

Artifacts archived per run: all `/tmp/linkedin_inbox_*.json`, `/tmp/linkedin_mentions_*.json`, `output/linkedin_inbox_check_latest.json`.

---

## Output Files

| File | Written by | Description |
|------|-----------|-------------|
| `/tmp/linkedin_inbox_<Profile>_<ts>.json` | `inbox.ts` | Per-profile inbox scrape |
| `/tmp/linkedin_mentions_<Profile>_<ts>.json` | `mentionChecker.ts` | Per-profile mentions |
| `/tmp/linkedin_mentions_seen.json` | `mentionChecker.ts` | Seen mention IDs (state) |
| `/tmp/linkedin_bio_<Name>_<ts>.json` | `profileScraper.ts` | Bio scrape result |
| `/tmp/linkedin_status.json` | `inbox.ts` | Profile run status map |
| `/tmp/linkedin_inbox.log` | All scripts | Combined log |
| `output/linkedin_inbox_check_latest.json` | `inboxCheck.ts` | Latest check summary |

### Inbox JSON

```json
{
  "profile": "Default",
  "account_name": "Ahmad Syed Anwar",
  "scraped_at": "2026-04-23T06:37:10.414Z",
  "status": "ok",
  "conversations": [
    {
      "conversation_id": "2-MGZmOWE3...",
      "sender_name": "Mark Samuel",
      "sender_profile_url": "https://www.linkedin.com/in/...",
      "unread": false,
      "needs_reply": true,
      "last_message_direction": "incoming",
      "last_message_preview": "Thanks for endorsing me!",
      "timestamp": "4:18 AM",
      "messages": [
        {
          "message_id": "2-MGZm..._0",
          "sender_name": "Ahmad Syed Anwar",
          "direction": "outgoing",
          "body": "Hi Mark, ...",
          "timestamp": "2:23 AM"
        }
      ]
    }
  ]
}
```

### Mentions JSON

```json
{
  "profile": "Default",
  "account_name": "Ahmad Syed Anwar",
  "scraped_at": "2026-04-23T07:01:07.311Z",
  "status": "ok",
  "new_mention_count": 2,
  "mentions": [
    {
      "mention_id": "https://www.linkedin.com/feed/update/urn%3Ali...",
      "type": "comment_mention",
      "author_name": "Fuad Al Nahhean",
      "author_profile_url": "https://www.linkedin.com/in/fuadalnahhean",
      "post_text": "Fuad Al Nahhean mentioned you in a comment.",
      "comment_text": "Ahmad Syed Anwar Good job. Will join next month meeting! inshallah",
      "post_url": "https://www.linkedin.com/feed/update/urn%3Ali...",
      "timestamp": "2m",
      "is_new": true
    }
  ]
}
```

### Bio JSON

```json
{
  "name": "Mark Samuel",
  "headline": "Transforming business & culture to achieve measurable breakthrough results",
  "location": "Pensacola, Florida, United States",
  "connection_degree": "1st",
  "about": "As a leader, you're always looking for ways to achieve breakthrough results...",
  "current_title": "CEO",
  "current_company": "B STATE",
  "experience": [
    { "title": "CEO", "company": "B STATE", "duration": "2020 - Present", "location": "" }
  ],
  "education": [
    { "school": "Example University", "degree": "MBA", "years": "1995-1999" }
  ]
}
```

---

## File Structure

```
linkedin-automation/
├── src/
│   ├── config.ts           # Constants (paths, limits)
│   ├── types.ts            # All TypeScript interfaces
│   ├── logger.ts           # File + stdout logger
│   ├── inbox.ts            # Inbox scraper + reply tool
│   ├── inboxCheck.ts       # Run inbox + analyze + report
│   ├── profileScraper.ts   # Connection bio scraper
│   ├── mentionChecker.ts   # @mention checker
│   └── server.ts           # HTTP API server (port 9000)
├── linkedin_inbox.py           # Legacy Python (kept for reference)
├── linkedin_profile_scraper.py # Legacy Python
├── linkedin_inbox_check.py     # Legacy Python
├── Jenkinsfile             # CI/CD pipeline
├── package.json            # npm scripts + dependencies
├── tsconfig.json           # TypeScript config
├── register.js             # ts-node ESM loader (Node 22)
├── .env.example            # Environment variable template
├── config/
│   └── config.example.json # Path config template
├── output/                 # Gitignored — local JSON outputs
└── logs/                   # Gitignored — local log files
```

---

## Requirements

- **Node.js** 18+ (tested on 22)
- **Chromium** installed via snap: `/snap/chromium/`
- LinkedIn logged in per Chromium profile (no credentials stored)

```bash
npm install
```

No extra browser download needed — Playwright uses the existing Chromium snap.

---

## Notes

- Each Chromium profile is copied to `/tmp/linkedin_pw_<Profile>/` before use to avoid file-lock conflicts with a running browser — temp copies are cleaned up after each run
- Rate-limited: 3-second pause between profile runs
- Error screenshots saved to `/tmp/linkedin_<profile>_error.png` on failure
- The server exits with SIGTERM/SIGINT gracefully — safe for systemd or Jenkins process management
- Jenkins pipeline starts the server in the background and verifies it with `/health` before marking the stage green
