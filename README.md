# LinkedIn Automation

Multi-profile LinkedIn inbox reader and reply tool powered by **Playwright**. Reads the last 10 conversations (with last 5 messages each) from every Chromium profile that has a LinkedIn session — and can send replies. Designed for OpenClaw agent actions or standalone cron jobs.

## Features

- **Multi-profile**: Auto-discovers all Chromium profiles (`Default`, `Profile 1`, `Profile 2`, …)
- **Inbox scraping**: Last 10 conversations × last 5 messages per thread
- **Reply**: Send a reply to any conversation by thread ID
- **JSON output**: One file per profile per run, plus a `status.json` summary
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

## Output

Each run writes:

```
/tmp/linkedin_inbox_Default_20260416T163843.json
/tmp/linkedin_inbox_Profile1_20260416T163843.json
/tmp/linkedin_status.json
/tmp/linkedin_inbox.log
```

### JSON structure

```json
{
  "profile": "Default",
  "account_name": "Ahmad Syed Anwar",
  "scraped_at": "2026-04-16T16:38:43Z",
  "status": "ok",
  "conversations": [
    {
      "conversation_id": "2-Yzg3MTI3N2YtYzIwYS00...",
      "sender_name": "Jacob Shepherd",
      "sender_profile_url": "https://www.linkedin.com/in/ACoAAA...",
      "unread": false,
      "last_message_preview": "You: Thanks for connecting...",
      "timestamp": "Apr 15",
      "messages": [
        {
          "message_id": "2-Yzg3..._0",
          "sender_name": "Ahmad Syed Anwar",
          "sender_profile_url": "https://www.linkedin.com/in/...",
          "direction": "outgoing",
          "body": "Hi Jacob, I work with finance leaders...",
          "timestamp": "2026-04-13T20:11:00.000Z"
        }
      ]
    }
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
├── linkedin_inbox.py        # Main script
├── config/
│   └── config.example.json  # Config template (copy to config.json)
├── output/                  # Gitignored — local JSON outputs
├── logs/                    # Gitignored — local log files
└── README.md
```

## Notes

- The script copies each Chromium profile to `/tmp/` before use to avoid file-lock conflicts with a running browser
- Temp copies are cleaned up after each run
- Rate-limited: 3-second pause between profile runs
- Error screenshots saved to `/tmp/linkedin_{profile}_error.png` on failure
