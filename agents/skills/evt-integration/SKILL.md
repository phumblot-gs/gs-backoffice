---
name: evt-integration
description: >
  Publish and consume events through the EVT (gs-stream-events) platform.
  Use this skill when you need to emit business events or query the event stream.
---

# EVT Integration Skill

GRAFMAKER's event platform (EVT) is the central message bus. All agents publish events to record their actions and consume events to stay informed.

## Event Format

Events follow this structure:

```json
{
  "eventType": "backoffice.invoice.draft_created",
  "source": {
    "application": "gs-backoffice",
    "version": "0.1.0",
    "environment": "production"
  },
  "actor": {
    "userId": "<your-agent-id>",
    "accountId": "grafmaker"
  },
  "scope": {
    "accountId": "grafmaker",
    "resourceType": "invoice",
    "resourceId": "<resource-id>"
  },
  "payload": { ... }
}
```

## Event Type Conventions

All back office events use the `backoffice.` prefix:

- `backoffice.invoice.*` — Invoice lifecycle events
- `backoffice.contract.*` — Contract events
- `backoffice.consistency.*` — Data consistency alerts
- `backoffice.digest.*` — Digest publications
- `backoffice.process.*` — Process documentation changes
- `backoffice.notify.*` — Notification routing (Google Chat, email)
- `backoffice.hr.*` — HR events
- `backoffice.data.*` — Data query events
- `backoffice.deal.*` — Sales deal events
- `backoffice.payment.*` — Payment events

## Publishing Events

Use the EVT API to publish events:

```
POST /v1/events
Authorization: Bearer <EVT_API_KEY>
Content-Type: application/json
```

## Querying Events

Use cursor-based pagination to query the event stream:

```
POST /v1/events/query
Authorization: Bearer <EVT_API_KEY>
Content-Type: application/json

{
  "filters": { "eventTypes": ["backoffice.invoice.*"] },
  "limit": 50
}
```

## When to Publish

- After completing any significant action (invoice created, contract registered, etc.)
- When detecting data inconsistencies (consistency.alert)
- When producing digests (digest.published)
- When routing notifications (notify.google_chat, notify.email)
