---
name: queue-coordinator
description: Start the queue coordinator (same as /queue-start). Use when the user types /queue-coordinator.
---

This is an alias of `/queue-start`. Load the `task-queue:queue-start` skill with the Skill
tool and follow it exactly, as if `/queue-start` had been typed. If the Skill tool cannot load
it, read `${CLAUDE_PLUGIN_ROOT}/skills/queue-start/SKILL.md`, where the CLAUDE_PLUGIN_ROOT
placeholder means `${CLAUDE_PLUGIN_ROOT}`.
