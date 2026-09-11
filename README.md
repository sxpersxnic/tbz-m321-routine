# Routine

## 1. Kurzbeschreibung

**Routine** ist eine Plattform zur Erstellung und automatisierten Ausführung wiederkehrender Abläufe.

Benutzer können sogenannte **Routinen** definieren, die aus mehreren unabhängigen Aktionen bestehen. Eine Routine kann beispielsweise jeden Montagmorgen automatisch mehrere Aufgaben ausführen:

> Informationen abrufen → Aufgabe erstellen → Benachrichtigung senden → externen Dienst aufrufen

Beim Ausführen einer Routine werden die einzelnen Arbeitsschritte nicht direkt und synchron nacheinander ausgeführt. Stattdessen werden Aufgaben als Nachrichten an einen Message Broker übergeben und von spezialisierten Services verarbeitet.

Dadurch können einzelne Services unabhängig voneinander betrieben, skaliert, aktualisiert oder vorübergehend abgeschaltet werden.

---

## 2. Ziel des Projekts

Das Projekt dient als praktische Umsetzung eines verteilten Systems nach Microservice-Prinzipien.

Der Schwerpunkt liegt nicht auf einer umfangreichen Benutzeroberfläche, sondern auf:

* klar abgegrenzten Services
* autonomen Datenbeständen
* formal definierten Schnittstellen
* synchroner und asynchroner Kommunikation
* Message-Broker-basierter Entkopplung
* Idempotenz und Wiederholbarkeit
* Ausfallsicherheit
* horizontaler Skalierung
* Distributed Tracing und Observability
* Evolution von Schnittstellen ohne Systemunterbruch

Die Anwendung soll dabei trotzdem einen nachvollziehbaren praktischen Nutzen haben.

---

## 3. Grundidee

Eine **Routine** beschreibt einen wiederkehrenden oder manuell auslösbaren Ablauf.

Beispiel:

### Routine: "Weekly Review"

Die Routine besteht aus folgenden Aktionen:

1. Aktuelle Informationen von einem externen Dienst abrufen
2. Eine Aufgabe im Task-System erstellen
3. Eine Zusammenfassung generieren
4. Eine Benachrichtigung senden

Der Benutzer muss nicht wissen, welcher Service welche Aktion ausführt.

Aus Sicht des Benutzers ist lediglich sichtbar:

```text
Weekly Review
     │
     ▼
  gestartet
     │
     ▼
   läuft
     │
     ▼
 abgeschlossen
```

Intern entsteht dagegen ein verteiltes Verarbeitungssystem.

---

## 4. Beispielablauf

Ein Benutzer startet eine Routine.

```text
User
 │
 │ Start Routine
 ▼
Routine Service
 │
 │ RoutineTriggered
 ▼
Message Broker
 │
 ├───────────────┐
 ▼               ▼
Task Service   Integration Service
 │               │
 │               │
 ▼               ▼
Task erstellt   Daten abgerufen
 │               │
 └───────┬───────┘
         ▼
    Message Broker
         │
         ▼
 Notification Service
         │
         ▼
   Benachrichtigung
```

Die Services müssen dabei nicht direkt voneinander abhängig sein.

Ein Service veröffentlicht ein Ereignis, ohne wissen zu müssen, welcher andere Service es konsumiert.

---

## 5. Kernkonzepte

### 5.1 Routine

Eine Routine beschreibt einen Ablauf und dessen Aktionen.

Eine Routine besitzt unter anderem:

* Namen
* Beschreibung
* Auslöser
* Aktionen
* Reihenfolge bzw. Abhängigkeiten
* Aktivierungsstatus

Beispiel:

```text
Routine: Morning Setup

Trigger:
    Jeden Werktag um 07:30

Actions:
    1. GetWeather
    2. CreateTask
    3. SendNotification
```

---

### 5.2 Trigger

Ein Trigger bestimmt, wann eine Routine ausgeführt wird.

Mögliche Trigger:

* manueller Start
* Zeitplan
* externes Ereignis

Für die erste Version reicht ein manueller Trigger und ein zeitbasierter Trigger.

---

### 5.3 Action

Eine Action ist eine einzelne ausführbare Aufgabe innerhalb einer Routine.

Beispiele:

* HTTP-Anfrage an einen externen Dienst
* Aufgabe erstellen
* Nachricht senden
* Daten abrufen
* Webhook auslösen

Actions werden von spezialisierten Services verarbeitet.

---

### 5.4 Routine Execution

Jede Ausführung einer Routine besitzt eine eigene Execution.

Beispiel:

```text
Routine:
    Weekly Review

Execution:
    2026-09-11 08:00
```

Eine Execution besitzt einen Status:

```text
PENDING
   ↓
RUNNING
   ↓
COMPLETED
```

Bei Fehlern sind beispielsweise folgende Zustände möglich:

```text
RUNNING
   ↓
FAILED
```

oder:

```text
RUNNING
   ↓
WAITING
   ↓
RUNNING
```

Dadurch kann eine einzelne Ausführung unabhängig von der Definition der Routine verfolgt werden.

---

# 6. Verteilte Architektur

Die Anwendung besteht aus mehreren autonomen Services.

Ein möglicher Zuschnitt ist:

```text
                    ┌───────────────┐
                    │    Client     │
                    └───────┬───────┘
                            │
                            ▼
                    ┌───────────────┐
                    │ API / Gateway │
                    └───────┬───────┘
                            │
             ┌──────────────┴──────────────┐
             │                             │
             ▼                             ▼
      ┌──────────────┐             ┌──────────────┐
      │   Routine    │             │   Identity   │
      │   Service    │             │   Service    │
      └──────┬───────┘             └──────────────┘
             │
             │ events
             ▼
      ┌─────────────────┐
      │  Message Broker │
      └────┬─────┬──────┘
           │     │
       ┌───┘     └──────────┐
       ▼                    ▼
┌──────────────┐      ┌──────────────┐
│ Action /     │      │ Notification │
│ Worker       │      │ Service      │
└──────────────┘      └──────────────┘
```

Die konkrete Anzahl und Aufteilung der Services wird während der Architekturplanung festgelegt.

Wichtig ist, dass jeder Service für einen klar abgegrenzten Verantwortungsbereich zuständig ist.

---

# 7. Service-Autonomie

Jeder Service besitzt seine eigenen Daten und seine eigene interne Implementierung.

Beispielsweise:

```text
Routine Service
    └── Routine Database

Notification Service
    └── Notification Database

Task Service
    └── Task Database
```

Services greifen nicht direkt auf die Datenbank eines anderen Services zu.

Kommunikation erfolgt ausschliesslich über definierte Schnittstellen.

Dadurch kann beispielsweise die interne Datenstruktur des Notification Services verändert werden, ohne dass der Routine Service angepasst werden muss.

---

# 8. Synchrone Kommunikation

Synchrone Kommunikation wird verwendet, wenn unmittelbar eine Antwort benötigt wird.

Beispielsweise:

```text
Client
  │
  │ POST /routines
  ▼
Routine Service
  │
  │ 201 Created
  ▼
Client
```

Synchrone Kommunikation eignet sich insbesondere für:

* Benutzeranfragen
* Erstellen und Ändern von Routinen
* Abfragen des aktuellen Status
* Authentifizierung

Sie soll nicht für lang laufende Hintergrundverarbeitung verwendet werden.

---

# 9. Asynchrone Kommunikation

Die eigentliche Ausführung von Actions erfolgt asynchron.

Beispiel:

```text
Routine Service
      │
      │ ActionRequested
      ▼
Message Broker
      │
      ▼
Worker Service
      │
      │ ActionCompleted
      ▼
Message Broker
```

Der Publisher wartet nicht darauf, dass der Consumer die Aufgabe verarbeitet.

Dadurch bleibt der auslösende Service funktionsfähig, auch wenn ein Consumer momentan nicht verfügbar ist.

---

# 10. Ausfallszenario

Ein zentraler Bestandteil des Projekts ist die Demonstration eines Service-Ausfalls.

Beispiel:

```text
Routine gestartet
      │
      ▼
ActionRequested
      │
      ▼
Message Broker
      │
      X
Notification Service DOWN
```

Die Nachricht bleibt im Broker verfügbar.

Andere Teile der Routine können weiterhin verarbeitet werden.

Wird der Notification Service später wieder gestartet:

```text
Notification Service
        │
        ▼
liest wartende Nachricht
        │
        ▼
verarbeitet Action
        │
        ▼
ActionCompleted
```

Der Benutzer muss die Routine nicht erneut starten.

Damit wird demonstriert, dass ein temporärer Ausfall eines Consumers nicht automatisch zum Verlust der Arbeit führt.

---

# 11. Idempotenz

Nachrichten können aufgrund von Retries oder Netzwerkproblemen mehrfach zugestellt werden.

Ein Consumer darf deshalb nicht davon ausgehen, dass jede Nachricht nur einmal eintrifft.

Beispiel:

```text
ActionRequested
      │
      ├── Delivery 1 → verarbeitet
      │
      └── Delivery 2 → bereits verarbeitet → ignorieren
```

Jede ausführbare Action erhält deshalb eine eindeutige ID.

Der Consumer kann anhand dieser ID erkennen, ob eine Action bereits verarbeitet wurde.

Damit werden doppelte Aktionen verhindert.

---

# 12. Skalierung

Verarbeitungsservices sollen horizontal skaliert werden können.

Beispielsweise:

```text
                 Message Broker
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
      Worker 1    Worker 2    Worker 3
```

Bei höherer Last können zusätzliche Worker gestartet werden.

```text
1 Worker
   ↓
3 Worker
   ↓
5 Worker
```

Die Aufgaben werden dabei über den Message Broker verteilt.

Die Services sollen möglichst stateless sein, sodass zusätzliche Instanzen ohne spezielle Konfiguration gestartet werden können.

---

# 13. Schnittstellen und Verträge

Alle Kommunikation zwischen Services wird über explizite Verträge definiert.

Dabei werden beispielsweise verwendet:

* OpenAPI für synchrone HTTP-Schnittstellen
* AsyncAPI bzw. definierte Event-Schemas für asynchrone Kommunikation

Die Verträge liegen unabhängig von den einzelnen Service-Repositories.

Beispielsweise:

```text
contracts/
├── routine-api.yaml
├── routine-events.yaml
└── notification-events.yaml
```

Die Services dürfen keine gemeinsamen Domain-Klassen oder ORM-Modelle verwenden.

Jeder Service besitzt eigene interne Modelle und übersetzt eingehende bzw. ausgehende Daten an seinen eigenen Domain-Kontext.

---

# 14. Evolution einer Schnittstelle

Ein wichtiger Bestandteil des Projekts ist die kontrollierte Änderung eines bestehenden Events.

Beispielsweise wird zunächst folgende Nachricht verwendet:

```json
{
  "executionId": "exec-123",
  "message": "Routine completed"
}
```

Später wird die Nachricht erweitert:

```json
{
  "executionId": "exec-123",
  "notification": {
    "title": "Routine completed",
    "body": "Weekly Review finished successfully"
  },
  "priority": "normal"
}
```

Die Änderung darf bestehende Consumer nicht unmittelbar brechen.

Dazu wird das **Expand-and-Contract-Prinzip** eingesetzt:

```text
Version 1
   │
   ▼
Neue Felder hinzufügen
   │
   ▼
Consumer aktualisieren
   │
   ▼
Neue Version verwenden
   │
   ▼
Alte Felder entfernen
```

Die Migration soll ohne simultanes Deployment aller beteiligten Services möglich sein.

---

# 15. Observability

Da eine einzelne Routine mehrere Services durchläuft, muss eine Execution über Service-Grenzen hinweg nachvollziehbar sein.

Jede Anfrage und jedes Event besitzt deshalb eine gemeinsame Korrelations- bzw. Trace-ID.

Beispiel:

```text
Trace ID: 7f91...

API Gateway
    │
    ├── Routine Service
    │
    ├── Worker Service
    │
    └── Notification Service
```

Die Logs aller beteiligten Services können dadurch einer einzigen Routine-Ausführung zugeordnet werden.

Das ermöglicht insbesondere die Analyse von:

* Fehlern
* Verzögerungen
* Retries
* fehlgeschlagenen Actions
* Service-Ausfällen

---

# 16. Security

Benutzer müssen authentifiziert werden.

Routinen und ihre Ausführungen gehören jeweils zu einem Benutzer.

Ein Benutzer darf nur auf seine eigenen Routinen und Ausführungen zugreifen.

Die Authentifizierung wird über einen externen oder eigenständigen Identity Provider realisiert.

Die konkrete Technologie wird während der Architekturplanung festgelegt.

---

# 17. Geplanter Haupt-Workflow

Der zentrale Demo-Workflow ist:

```text
1. Benutzer erstellt Routine
        ↓
2. Routine wird aktiviert
        ↓
3. Trigger startet Routine
        ↓
4. Routine Service erstellt Execution
        ↓
5. Actions werden als Events veröffentlicht
        ↓
6. Worker verarbeiten die Actions
        ↓
7. Worker veröffentlichen Ergebnisse
        ↓
8. Execution wird aktualisiert
        ↓
9. Routine wird als abgeschlossen angezeigt
```

Dieser Workflow bildet den Systemdurchstich für die Live-Demonstration.

---

# 18. Geplanter Resilienz-Workflow

Zusätzlich wird ein Service-Ausfall demonstriert:

```text
1. Routine starten
        ↓
2. Worker Service stoppen
        ↓
3. Action wird weiterhin veröffentlicht
        ↓
4. Nachricht wartet im Broker
        ↓
5. Routine bzw. andere Services bleiben verfügbar
        ↓
6. Worker Service starten
        ↓
7. Nachricht wird verarbeitet
        ↓
8. Execution wird abgeschlossen
```

Damit werden die Vorteile der asynchronen Entkopplung praktisch sichtbar.

---

# 19. Projektumfang

Die erste Version konzentriert sich bewusst auf einen kleinen Funktionsumfang.

### Enthalten

* Benutzer-Authentifizierung
* Routinen erstellen, bearbeiten und aktivieren
* manuelles Auslösen einer Routine
* zeitbasierte Trigger
* mehrere Action-Typen
* asynchrone Action-Verarbeitung
* Status einer Routine Execution
* Message Broker
* Retry-Verhalten
* Idempotenz
* horizontale Skalierung eines Workers
* strukturierte Logs
* Correlation-ID bzw. Distributed Tracing
* versionierte Schnittstellen
* Demonstration eines Breaking Changes
* Docker-basierter Systemstart

### Nicht Bestandteil der ersten Version

* komplexer visueller Workflow-Editor
* Mobile App
* Marketplace für Integrationen
* umfangreiche Benutzerverwaltung
* komplexe Berechtigungsmodelle
* künstliche Intelligenz als Kernfunktion
* beliebig komplexe Workflow-Verzweigungen
* produktionsreife SaaS-Infrastruktur

Der Schwerpunkt liegt auf der Qualität des verteilten Systems und nicht auf der Anzahl der Features.

---

# 20. Erfolgskriterien

Routine gilt als erfolgreich umgesetzt, wenn:

1. mindestens drei autonome Services miteinander kommunizieren;
2. synchrone und asynchrone Kommunikation verwendet werden;
3. Services ihre Daten unabhängig verwalten;
4. Events über einen Message Broker verarbeitet werden;
5. doppelte Nachrichten sicher behandelt werden;
6. mindestens ein Worker horizontal skaliert werden kann;
7. ein ausgefallener Consumer keine bereits veröffentlichten Aufgaben verliert;
8. eine Routine-Ausführung über mehrere Services hinweg nachvollziehbar ist;
9. eine Schnittstelle ohne gleichzeitiges Deployment aller abhängigen Services weiterentwickelt werden kann;
10. das Gesamtsystem mit einem einzigen definierten Startvorgang gestartet werden kann.

---

# 21. Kernidee in einem Satz

**Routine ist eine verteilte Automatisierungsplattform, bei der Benutzer wiederkehrende Abläufe definieren und deren einzelne Aktionen unabhängig, asynchron, fehlertolerant und skalierbar von autonomen Services verarbeitet werden.**

---

# 22. Umsetzung

Die Plattform ist vollständig umgesetzt. Details: [docs/architecture.md](docs/architecture.md) · Live-Demo & Nachweis der Erfolgskriterien: [docs/demo.md](docs/demo.md) · Verträge: [contracts/](contracts/README.md)

## Schnellstart

Voraussetzung: Docker (Compose v2). Für die Demo-Skripte zusätzlich `curl` und `jq`.

```bash
docker compose up -d --build --wait   # startet das gesamte System
scripts/demo.sh main                  # Haupt-Workflow im Terminal
scripts/demo.sh all                   # alle Szenarien als Abnahmetest
docker compose down -v                # stoppen und Daten löschen
```

| | URL |
| --- | --- |
| Web-UI & API (Gateway) | <http://localhost:8080> – Login `demo@routine.local` / `demo12345` |
| RabbitMQ Management | <http://localhost:15672> – `routine` / `routine` |
| Jaeger (Distributed Tracing) | <http://localhost:16686> |
| Mock External APIs | <http://localhost:8090> |

## Aufbau

```text
compose.yaml                 Gesamtsystem (16 Container)
contracts/                   OpenAPI, AsyncAPI, JSON Schemas (unabhängig von den Services)
infra/rabbitmq/              Broker-Topologie als Code
libs/service-kit/            technisches Chassis (Logging, HTTP, DB, Broker, Auth, Tracing) – keine Domain-Modelle
services/
  gateway/                   API Gateway (einziger Einstiegspunkt)
  identity-service/          Benutzer, Login, JWT/JWKS
  routine-service/           Routinen, Orchestrierung, Scheduler, Outbox
  task-service/              Aufgaben (Action task.create)
  notification-service/      Posteingang (notification.send, Execution-Events)
  integration-worker/        skalierbarer Worker für externe Aufrufe
  mock-external/             simulierte Drittanbieter
web/                         Web-Client (React + Vite, nginx) – eigener Service
scripts/demo.sh              Demo-Szenarien / Abnahmetest
```

## Entwicklung

```bash
npm install          # Abhängigkeiten der Services (Node ≥ 24)
npm --prefix web install   # Abhängigkeiten des Web-Clients
npm --prefix web run dev   # UI mit Hot Reload auf :5173 (API via laufendem Gateway)
npm run typecheck    # TypeScript
npm test             # Unit- und Contract-Tests
```
