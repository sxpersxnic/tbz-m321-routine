# Verträge (Contracts)

Alle Schnittstellen zwischen den Services sind hier – unabhängig vom Code der
Services – formal beschrieben. Services teilen **keine** Domain-Klassen: jeder
Service übersetzt Nachrichten in seinem eigenen `src/messages.ts` in sein
internes Modell.

| Datei | Inhalt |
| --- | --- |
| `openapi/identity-api.yaml` | Registrierung, Login, JWKS (synchron) |
| `openapi/routine-api.yaml` | Routinen, Auslösen, Ausführungsstatus (synchron) |
| `openapi/task-api.yaml` | Aufgaben (synchron) |
| `openapi/notification-api.yaml` | Posteingang (synchron) |
| `asyncapi/routine-messaging.yaml` | Exchanges, Routing-Keys, Producer/Consumer (asynchron) |
| `schemas/*.schema.json` | JSON Schemas aller Nachrichten inkl. Envelope und beider Versionen von `ExecutionCompleted` |
| `validate.ts` | Helfer für Contract-Tests (nur Tests, nie zur Laufzeit) |

## Versionierung

* **HTTP**: Pfad-Version `/api/v1`. Additive Änderungen bleiben in v1, Breaking Changes erhalten `/api/v2` parallel zu v1.
* **Events**: Feld `version` im Envelope. Consumer sind *tolerant readers* (unbekannte Felder werden ignoriert).
  Felder werden nie direkt entfernt, sondern per **Expand and Contract** – siehe `ExecutionCompleted` v1 → v2 und
  `scripts/demo.sh evolution`.

## Contract-Tests

`npm test` prüft, dass jede produzierte Nachricht ihrem Schema entspricht
(`services/*/test/contracts.test.ts`). Damit fällt ein versehentlich
inkompatibler Producer auf, bevor er deployt wird.
