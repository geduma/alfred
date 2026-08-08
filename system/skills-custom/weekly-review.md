---
name: Weekly Review
description: Weekly review of decisions, progress, metrics, and context cleanup
tools: exec, file_ops, memory, health
---

## Weekly Review

Run this skill proactively at the end of the week (Friday, configured via the `job` tool). Its goal is to consolidate progress and leave the context clean for the following week.

### Steps

1. **Weekly summary**: review the latest sessions and extract decisions, completed tasks, pending tasks, and key data (numbers, paths, dates).
2. **Metrics**: query token usage for the period with the `health` tool (action `budget`) and system status with `status`.
3. **Update context**: write or update the preferences/pending tasks file (`memory/personality/preferences.md`):
   - Add a "LAST WEEK" section with a one-line summary per relevant decision.
   - Add a "PENDING" section with the tasks that remain open.
   - Remove completed tasks.
4. **Cleanup**: if there are temporary files in `files/` older than 30 days, propose their cleanup (do not delete them without confirmation).

### Expected output

```
📊 WEEKLY SUMMARY
- <decision or progress 1>
- <decision or progress 2>

✅ COMPLETED
- <list>

🕒 PENDING FOR NEXT WEEK
- <list>

⚙️ METRICS
- Tokens used: <number> (day: <number> / month: <number>)
- Health findings: <number>

🗑️ SUGGESTED CLEANUP
- <candidate files, if any>
```

### Rules

- Do not invent metrics: if `health` is not enabled or no limits are configured, say so.
- Respect the user's language preference (English by default).
- The review must fit in 20 lines maximum.
