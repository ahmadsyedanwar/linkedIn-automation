#!/usr/bin/env python3
import glob
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

INBOX_CMD = ["python3", "/home/ahmad/linkedin-automation/linkedin_inbox.py"]
TMP_GLOB = "/tmp/linkedin_inbox_*.json"
STATE_FILE = "/home/ahmad/linkedin-automation/output/linkedin_inbox_check_latest.json"


def newest_inbox_files():
    files = [f for f in glob.glob(TMP_GLOB) if os.path.isfile(f)]
    files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return files


def extract_needs_reply(path):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    conversations = data.get("conversations", [])
    items = []
    for conv in conversations:
        if not conv.get("needs_reply"):
            continue
        messages = conv.get("messages", [])
        last_incoming = None
        for msg in reversed(messages):
            if msg.get("direction") == "incoming":
                last_incoming = msg.get("body", "")
                break
        items.append({
            "inbox_json": path,
            "profile_key": data.get("profile", ""),
            "account_name": data.get("account_name", ""),
            "conversation_id": conv.get("conversation_id", ""),
            "connection_name": conv.get("sender_name", ""),
            "last_incoming_message": last_incoming or "",
            "messages": messages,
            "sender_profile_url": conv.get("sender_profile_url", ""),
            "timestamp": conv.get("timestamp", ""),
        })
    return {
        "source_file": path,
        "profile": data.get("profile", ""),
        "account_name": data.get("account_name", ""),
        "status": data.get("status", ""),
        "needs_reply": items,
    }


def print_report(summary):
    print(f"LinkedIn inbox check — {summary['checked_at']}")
    print(f"Inbox JSON files analyzed: {len(summary['files'])}")
    print()
    total = 0
    for file_summary in summary["results"]:
        print(f"FILE: {file_summary['source_file']}")
        print(f"PROFILE: {file_summary['profile']} | ACCOUNT: {file_summary['account_name']} | STATUS: {file_summary['status']}")
        if not file_summary["needs_reply"]:
            print("No threads need reply in this file.")
            print()
            continue
        for idx, item in enumerate(file_summary["needs_reply"], start=1):
            total += 1
            print(f"[{idx}] Connection name: {item['connection_name']}")
            print(f"Conversation ID: {item['conversation_id']}")
            print(f"Last incoming message: {item['last_incoming_message']}")
            print("Full conversation history:")
            for msg in item["messages"]:
                sender = msg.get("sender_name", "") or msg.get("direction", "unknown")
                body = (msg.get("body", "") or "").replace("\n", " ").strip()
                ts = msg.get("timestamp", "")
                print(f"- [{msg.get('direction', 'unknown')}] {sender} | {ts} | {body}")
            print()
    print(f"Total threads needing reply: {total}")


def main():
    run_scrape = "--analyze-only" not in sys.argv
    if run_scrape:
        proc = subprocess.run(INBOX_CMD, text=True)
        if proc.returncode != 0:
            sys.exit(proc.returncode)

    files = newest_inbox_files()
    results = [extract_needs_reply(p) for p in files]
    summary = {
        "checked_at": datetime.utcnow().isoformat() + "Z",
        "files": files,
        "results": results,
    }

    Path(os.path.dirname(STATE_FILE)).mkdir(parents=True, exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)

    print_report(summary)


if __name__ == "__main__":
    main()
