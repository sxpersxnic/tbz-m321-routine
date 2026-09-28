# Service specs

One file per service. Each spec is the **source of truth** for that service's schema,
endpoints, messages and manifest. Sections, in this order (a section that doesn't apply is
omitted):

1. **Responsibility**: what it owns, what it doesn't
2. **Data**: SQL (new migration files, numbered after the existing ones)
3. **HTTP API**: all under `/api/v1/...` unless marked `/internal/v1/...` (service tokens only)
4. **Messages**: consumed and produced
5. **Manifest**: domains only (capabilities, triggers, collections, quick entry, templates)
6. **Today cards**
7. **Background jobs**: all replica-safe
8. **Configuration**: environment variables
9. **Minimum lovable depth**: domains only, what its own page must do
10. **Tests**: beyond the conformance checklist of [../04-domain-platform.md §7](../04-domain-platform.md)

| Service | Kind | Milestone introduced / changed |
| --- | --- | --- |
| [gateway](gateway.md) | platform | M1, M2, M5, M12 |
| [identity-service](identity-service.md) | platform | M0, M5, M11 |
| [routine-service](routine-service.md) | platform | M1–M5, M9, M10 |
| [task-service](task-service.md) | domain | M2, M3, M5 |
| [notification-service](notification-service.md) | domain | M2, M3, M8 |
| [integration-worker](integration-worker.md) | domain (Connections) | M2, M9 |
| [trigger-service](trigger-service.md) | platform | M4 |
| [today-service](today-service.md) | platform | M5 |
| [delivery-service](delivery-service.md) | platform | M8 |
| [connector-service](connector-service.md) | platform | M9 |
| [assistant-service](assistant-service.md) | domain (AI) | M10 |
| [budget-service](budget-service.md) | domain | M6 |
| [health-service](health-service.md) | domain | M7 |
| [people-service](people-service.md) | domain | M7 |
| [home-service](home-service.md) | domain | M7 |
| [calendar-service](calendar-service.md) | domain | M9 |
