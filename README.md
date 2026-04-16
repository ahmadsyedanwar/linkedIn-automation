# LinkedIn Automation

Multi-profile LinkedIn inbox reader, connection profile scraper, and reply tool powered by **Playwright**. Designed for OpenClaw agent actions or standalone cron jobs.

## Workflow (4-Step Process)

### Step 1: Scrape inbox → identify threads needing reply
```bash
python3 linkedin_inbox.py
```
Output flags conversations where the **last message is incoming** (`needs_reply: true`), meaning the connection replied and is waiting for a response.

### Step 2: Scrape connection profile → get bio summary
```bash
python3 linkedin_profile_scraper.py \
  --inbox-json /tmp/linkedin_inbox_Default_*.json \
  --thread-id THREAD_ID \
  --profile Default
```
Extracts: name, headline, location, about section, experience, education — so AI can generate a personalized reply.

### Step 3: Generate reply (via AI agent)
The agent reads the conversation messages + bio summary and drafts a reply for user approval.

### Step 4: Send reply via Playwright
```bash
python3 linkedin_inbox.py \
  --reply \
  --profile Default \
  --conversation-id THREAD_ID \
  --text "Your reply here"
```

## Features

- **Multi-profile**: Auto-discovers all Chromium profiles (`Default`, `Profile 1`, `Profile 2`, …)
- **Inbox scraping**: Last 10 conversations × last 5 messages per thread with full message bodies
- **Needs-reply detection**: Flags threads where the last message is incoming
- **Profile scraper**: Name, headline, location, about, experience, education, connection degree
- **Reply**: Send a reply to any conversation by thread ID
- **JSON output**: Structured files for AI consumption
- **Cron-safe**: Exits with code 0 always; errors are logged, not thrown
- **OpenClaw-ready**: Call via `exec` tool from any agent

## Requirements

- Linux (Ubuntu/Debian)
- Chromium installed via snap: `/snap/chromium/`
- Python 3.10+
- Playwright for Python

```bash
pip3 install playwright --break-system-packages
```

No browser download needed — uses your existing Chromium snap install.

## Setup

1. Log in to LinkedIn in Chromium (each profile = one LinkedIn account)
2. Clone this repo
3. Copy `config/config.example.json` → `config/config.json` and update paths if needed
4. Run

## Usage

### Inbox Scraper (`linkedin_inbox.py`)

```bash
# Scrape all profiles
python3 linkedin_inbox.py

# Scrape a single profile
python3 linkedin_inbox.py --profile Default
python3 linkedin_inbox.py --profile "Profile 1"

# Send a reply
python3 linkedin_inbox.py \
  --reply \
  --profile Default \
  --conversation-id 2-Yzg3MTI3N2YtYzIwYS00... \
  --text "Thanks for reaching out!"
```

### Profile Scraper (`linkedin_profile_scraper.py`)

```bash
# Scrape by URL
python3 linkedin_profile_scraper.py --url "https://www.linkedin.com/in/username" --profile Default

# Look up from inbox JSON by thread ID
python3 linkedin_profile_scraper.py \
  --inbox-json /tmp/linkedin_inbox_Default_*.json \
  --thread-id THREAD_ID \
  --profile Default
```

## Output

Each run writes:

```
/tmp/linkedin_inbox_Default_20260416T163843.json
/tmp/linkedin_inbox_Profile1_20260416T163843.json
/tmp/linkedin_status.json
/tmp/linkedin_inbox.log
```

### Inbox JSON structure

```json
{
  "profile": "Default",
  "account_name": "Ahmad Syed Anwar",
  "scraped_at": "2026-04-16T16:38:43Z",
  "status": "ok",
  "conversations": [
    {
      "conversation_id": "2-Yzg3MTI3N2YtYzIwYS00...",
      "sender_name": "Aaron Captain Littles",
      "sender_profile_url": "https://www.linkedin.com/in/...",
      "unread": false,
      "needs_reply": true,
      "last_message_direction": "incoming",
      "last_message_preview": "I'm not sure",
      "timestamp": "Apr 14",
      "messages": [
        {
          "message_id": "2-Yzg3..._0",
          "sender_name": "Ahmad Syed Anwar",
          "sender_profile_url": "https://www.linkedin.com/in/...",
          "direction": "outgoing",
          "body": "Hi Aaron, I work with finance leaders...",
          "timestamp": "2026-04-13T20:11:00.000Z"
        },
        {
          "message_id": "2-Yzg3..._3",
          "sender_name": "Aaron Captain Littles",
          "direction": "incoming",
          "body": "I'm not sure",
          "timestamp": "2026-04-14T15:30:00.000Z"
        }
      ]
    }
  ]
}
```

### Bio JSON structure

```json
{
  "name": "Aaron Captain Littles",
  "headline": "Chief Executive Officer at DayOne Staffing, Inc.",
  "location": "Greater Tampa Bay Area",
  "connection_degree": "1st",
  "about": "I'm a results-driven executive leader...",
  "current_title": "Chief Executive Officer",
  "current_company": "DayOne Staffing, Inc.",
  "experience": [
    {"title": "CEO", "company": "DayOne Staffing", "duration": "2020 - Present"}
  ],
  "education": [
    {"school": "United States Naval Academy", "degree": "BS", "years": "2001-2005"}
  ]
}
```

## OpenClaw Integration

Call from an agent action using the `exec` tool:

```bash
# Scrape all profiles and return JSON paths
python3 /path/to/linkedin_inbox.py

# Reply to a conversation
python3 /path/to/linkedin_inbox.py \
  --reply \
  --profile Default \
  --conversation-id THREAD_ID \
  --text "Your reply here"
```

### Example cron schedule (via OpenClaw cron tool)

```
Every hour: python3 ~/linkedin-automation/linkedin_inbox.py
```

Output JSON files are written to `/tmp/` and can be read back by the agent for processing.

## File Structure

```
linkedin-automation/
├── linkedin_inbox.py           # Inbox scraper + reply tool
├── linkedin_profile_scraper.py # Connection profile/bio scraper
├── requirements.txt            # pip install playwright
├── config/
│   └── config.example.json     # Config template
├── output/                     # Gitignored — local JSON outputs
├── logs/                       # Gitignored — local log files
└── README.md
```

## Notes

- The script copies each Chromium profile to `/tmp/` before use to avoid file-lock conflicts with a running browser
- Temp copies are cleaned up after each run
- Rate-limited: 3-second pause between profile runs
- Error screenshots saved to `/tmp/linkedin_{profile}_error.png` on failure
