---
name: System Check
description: Proactive check of system health, logs, and database status
tools: exec, file_ops, health
---

## System Check

Run this skill proactively every few hours (configured via the `job` tool) or on demand. Its goal is to detect problems before they affect the service.

### Steps

1. **Health monitor**: run the `health` tool with action `check` and then `findings` (filter by `severity: error`).
2. **Recent logs**: review the latest lines of `logs/alfred.log` and look for error patterns (`ERROR`, `fatal`, `Failed`).
3. **Database**: verify that `db/alfred.db` is readable and its size is stable (does not grow abnormally).
4. **Space and processes**: use `exec` to check the workspace disk usage and that the Alfred process is still alive (`pgrep`).

### Expected output

```
🔍 SYSTEM CHECK

⚙️ HEALTH
- <health monitor status>
- <recent errors or "no findings">

📜 LOGS
- <recent errors or "no relevant errors">

🗄️ DATABASE
- <size / status>

💾 SYSTEM
- <workspace disk usage>
- <alfred process: active/missing>

🚨 REQUIRED ACTIONS
- <only if there is something to fix; otherwise: "None">
```

### Rules

- If there are no errors, the summary must be 5 lines maximum.
- `exec` commands must be read-only (do not modify anything without confirmation).
- If you detect something critical (dead process, corrupt DB), escalate it immediately and do not wait for the next cycle.
- Respect the user's language preference (English by default).
