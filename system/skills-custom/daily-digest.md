---
name: Daily Digest
description: Morning summary of pending tasks, reminders, and system status
tools: job, exec, health
---

## Daily Digest

Run this skill proactively every morning (configure the daily job in alfred.json or via the `job` tool). Its goal is to start your operator's day with an actionable summary, not with noise.

### Inputs

1. Read the preferences and pending tasks file at `memory/personality/preferences.md` (or the configured path) to get task context and preferences.
2. Review the files in `files/` that have a `.md` or `.txt` extension and a date close to today (in name or content).
3. Check system status with the `health` tool (action `status`) to detect service health problems.

### Expected output

Generate a message in this format:

```
Good morning ☀️

📌 PENDING
- [ ] <task 1>
- [ ] <task 2>

🗓️ TODAY'S AGENDA
- <summary of what is planned for today>

⚙️ SYSTEM STATUS
- <health monitor status, token usage if configured>
- <any critical findings>

🔔 SUGGESTED ACTIONS
- <maximum 2 concrete actions>
```

### Rules

- Maximum 10 lines of summary; prioritize what is actionable.
- If there are no pending tasks, say so in a single line; do not invent tasks.
- Do not include redundant information with the health alert job.
- The tone is direct and useful, in English by default (respect the language preference if one exists).
