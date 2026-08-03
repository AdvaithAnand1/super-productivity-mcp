# Architecture

```mermaid
graph TD
    Host["MCP host: ChatGPT Desktop or Codex"]
    Transport["STDIO JSON-RPC transport"]
    Server["MCP tool layer\nZod schemas + explicit task IDs"]
    Client["REST client\ntimeout + Bearer auth"]
    LocalAPI["Super Productivity\n127.0.0.1:3876"]
    Issue["GitHub reference\nURL or owner/repo#number"]

    Host --> Transport --> Server --> Client --> LocalAPI
    Issue --> Server
```

The server has no background worker, database, GitHub network client, or HTTP listener. Its only
state is the local Super Productivity state it reads and updates in response to an MCP tool call.

## State-changing boundary

```mermaid
flowchart TD
    Select["search_tasks / list_today"] -->|exact taskId| Plan["plan_task_today"]
    Plan --> Start["start_task"]
    Start --> Stop["stop_timer"]
    Stop --> Complete["complete_task"]
    Issue["ensure_github_issue_task"] -->|explicit only| Existing["reuse marked/native task"]
    Issue -->|missing| Created["create one marked task"]
    Created -->|planToday=true only| Plan
```
