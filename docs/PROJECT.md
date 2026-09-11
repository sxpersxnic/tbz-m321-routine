# Routine – Verteiltes Automatisierungssystem

## 1. Projektübersicht

**Projektname:** Routine
**Projektart:** Verteiltes System / Microservices
**Modul:** M321 – Verteilte Systeme
**Projektteam:** 3–4 Personen
**Geplanter Aufwand:** ca. 20 Lektionen pro Person

---

## 2. Projektidee

Routine ist eine Plattform, mit der Benutzer wiederkehrende Abläufe definieren und automatisiert ausführen lassen können.

Eine Routine besteht aus einem Auslöser und mehreren Aktionen. Der Auslöser kann beispielsweise ein Zeitplan oder eine manuelle Ausführung sein. Die einzelnen Aktionen werden anschliessend von spezialisierten Systemkomponenten verarbeitet.

Ein Beispiel:

> Jeden Montagmorgen soll eine Routine gestartet werden, welche Informationen abruft, eine Aufgabe erstellt und anschliessend eine Benachrichtigung versendet.

Für den Benutzer erscheint dies als ein einziger Ablauf. Intern wird die Verarbeitung jedoch auf mehrere autonome Services verteilt.

Der Schwerpunkt des Projekts liegt deshalb nicht auf einer umfangreichen Benutzeroberfläche, sondern auf der Umsetzung eines funktionierenden verteilten Systems mit klaren Schnittstellen, asynchroner Kommunikation und Massnahmen für Hochverfügbarkeit.

---

# 3. Zielsetzung

Mit Routine soll ein praxisnahes verteiltes System entwickelt werden, bei dem die einzelnen Teammitglieder eigenständig für Systemkomponenten verantwortlich sind.

Dabei sollen insbesondere folgende Ziele erreicht werden:

* Entwicklung mehrerer voneinander unabhängiger Systemkomponenten
* Definition und Einhaltung klarer Schnittstellen
* Kommunikation zwischen den Systemkomponenten
* Verwendung synchroner und asynchroner Kommunikation
* Einsatz eines Message Brokers
* zuverlässige Verarbeitung von Nachrichten
* Umgang mit mehrfach zugestellten Nachrichten
* horizontale Skalierung mindestens einer Systemkomponente
* Umsetzung von Massnahmen zur Hochverfügbarkeit
* nachvollziehbare Fehlerbehandlung
* zentrale Nachvollziehbarkeit von verteilten Abläufen
* Integration der einzelnen Komponenten zu einem funktionierenden Gesamtsystem

---

# 4. Anforderungen an das System

## 4.1 Funktionale Anforderungen

### Muss-Anforderungen

Das System muss:

1. Benutzer authentifizieren können.
2. Benutzern ermöglichen, Routinen zu erstellen.
3. Routinen aktivieren und deaktivieren können.
4. Routinen manuell ausführen können.
5. Routinen zeitgesteuert ausführen können.
6. Eine Routine aus mehreren Aktionen aufbauen können.
7. Für jede Ausführung einen eigenen Ausführungsstatus führen.
8. Aktionen asynchron an zuständige Systemkomponenten übergeben.
9. Erfolgreiche und fehlgeschlagene Aktionen erkennen.
10. Wiederholungen fehlgeschlagener Aktionen ermöglichen.
11. Bereits verarbeitete Nachrichten erkennen können.
12. Den Status einer Routine-Ausführung anzeigen können.

### Optionale Anforderungen

Je nach verfügbarem Zeitaufwand können zusätzlich umgesetzt werden:

* weitere Trigger-Typen
* zusätzliche Action-Typen
* Wiederholungsregeln für einzelne Aktionen
* Prioritäten für Aktionen
* Ausführungsverlauf
* einfache Statistiken
* Webhooks als externe Aktionen

---

# 5. Nicht-funktionale Anforderungen

Das System soll folgende Eigenschaften erfüllen:

### Schnittstellen

Alle Kommunikation zwischen den Systemkomponenten erfolgt über klar definierte und dokumentierte Schnittstellen.

Die Schnittstellen werden vor bzw. parallel zur Implementierung formal beschrieben.

### Autonomie

Jede Systemkomponente besitzt einen klar abgegrenzten Verantwortungsbereich.

Die Komponenten dürfen nicht direkt auf die Datenbanken anderer Komponenten zugreifen.

### Asynchronität

Lang laufende oder voneinander unabhängige Verarbeitung soll über einen Message Broker erfolgen.

Der Ausfall eines Consumers soll den Publisher nicht blockieren.

### Idempotenz

Nachrichten können aufgrund von Wiederholungen mehrfach eintreffen. Die Verarbeitung muss deshalb so implementiert werden, dass eine Nachricht nicht zu unerwünschten mehrfachen Aktionen führt.

### Skalierbarkeit

Mindestens eine Systemkomponente soll horizontal skalierbar sein.

Mehrere Instanzen derselben Komponente sollen gleichzeitig Nachrichten verarbeiten können.

### Hochverfügbarkeit

Das System soll auch bei einem Ausfall einzelner Komponenten möglichst funktionsfähig bleiben.

Mindestens zwei konkrete Massnahmen zur Hochverfügbarkeit sollen umgesetzt und demonstriert werden.

### Observability

Verteilte Vorgänge sollen über strukturierte Logs und eine gemeinsame Korrelations- bzw. Trace-ID nachvollziehbar sein.

### Deployment

Alle für das Gesamtsystem benötigten Komponenten sollen auf LernMAAS lauffähig installiert und gestartet werden können.

---

# 6. Systemkomponenten

Das System wird in mehrere autonome Komponenten aufgeteilt.

Die genaue Aufteilung wird gemeinsam im Team festgelegt. Eine mögliche Aufteilung ist:

| Komponente                     | Verantwortung                                  |
| ------------------------------ | ---------------------------------------------- |
| **Routine Service**            | Verwaltung von Routinen und deren Ausführungen |
| **Execution / Worker Service** | Verarbeitung und Ausführung von Aktionen       |
| **Integration Service**        | Kommunikation mit externen Diensten            |
| **Notification Service**       | Versand von Benachrichtigungen                 |

Zusätzlich werden Infrastrukturkomponenten wie ein Message Broker und gegebenenfalls ein API Gateway eingesetzt.

Die konkrete Verantwortungsverteilung wird bei der Projektplanung festgehalten. Jedes Teammitglied übernimmt mindestens eine Systemkomponente vollständig und ist für deren Implementierung, Integration und Dokumentation verantwortlich.

---

# 7. Zusammenspiel der Komponenten

Die zentrale Kommunikation erfolgt beispielsweise nach folgendem Prinzip:

```text
                         ┌───────────────┐
                         │    Client     │
                         └───────┬───────┘
                                 │
                                 ▼
                         ┌───────────────┐
                         │ Routine       │
                         │ Service       │
                         └───────┬───────┘
                                 │
                         Action Requested
                                 │
                                 ▼
                       ┌───────────────────┐
                       │  Message Broker   │
                       └───────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
       ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
       │ Worker      │  │ Integration │  │ Notification│
       │ Service     │  │ Service     │  │ Service     │
       └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
              │                │                │
              └────────────────┼────────────────┘
                               ▼
                         Action Completed
```

Die einzelnen Services kommunizieren dabei nicht über gemeinsame Domain-Modelle oder gemeinsam genutzte Datenbanken.

---

# 8. Beispiel eines Systemdurchlaufs

Ein Benutzer erstellt die Routine **"Weekly Review"**:

```text
Trigger:
Jeden Montag um 08:00

Aktionen:
1. Informationen abrufen
2. Aufgabe erstellen
3. Benachrichtigung senden
```

Zum Ausführungszeitpunkt wird eine neue Routine-Ausführung erstellt.

Anschliessend werden die benötigten Aktionen als Nachrichten veröffentlicht.

```text
Routine Service
      │
      │ RoutineTriggered
      ▼
Message Broker
      │
      ├──► Integration Service
      │
      ├──► Worker Service
      │
      └──► Notification Service
```

Die Services verarbeiten ihre jeweiligen Aufgaben unabhängig voneinander und melden das Ergebnis wiederum über definierte Nachrichten zurück.

---

# 9. Hochverfügbarkeit und Fehlertoleranz

Ein wesentlicher Bestandteil des Projekts ist der Umgang mit Ausfällen.

Beispielsweise kann der Notification Service während der Ausführung einer Routine nicht verfügbar sein.

```text
Routine Service
      │
      ▼
Message Broker
      │
      X
Notification Service nicht verfügbar
```

Die Nachricht wird nicht verworfen, sondern bleibt im Message Broker bestehen.

Nach dem Neustart des Notification Services kann die Nachricht verarbeitet werden.

```text
Notification Service startet
            │
            ▼
wartende Nachricht wird gelesen
            │
            ▼
Aktion wird verarbeitet
            │
            ▼
Ergebnis wird veröffentlicht
```

Dadurch muss die gesamte Routine nicht erneut gestartet werden.

Weitere mögliche Hochverfügbarkeitsmassnahmen sind:

* mehrere Worker-Instanzen
* automatische Wiederholung fehlgeschlagener Nachrichten
* Timeouts
* Dead-Letter-Queue
* Health Checks
* horizontale Skalierung

Mindestens zwei dieser Massnahmen sollen funktional umgesetzt werden.

---

# 10. Schnittstellen

Die Schnittstellen zwischen den Systemkomponenten werden unabhängig von deren Implementierung definiert.

Für synchrone Kommunikation werden API-Spezifikationen verwendet.

Für asynchrone Kommunikation werden Event- bzw. Nachrichtenschemas definiert.

Beispielsweise:

```json
{
  "executionId": "exec-123",
  "actionId": "action-456",
  "actionType": "notification",
  "payload": {
    "message": "Routine completed"
  }
}
```

Die Schnittstellen werden versioniert und Änderungen sollen ohne unnötige Abhängigkeiten zwischen den Teammitgliedern möglich sein.

Gemeinsame Business-Logik oder gemeinsame Domain-Klassen werden nicht als Shared Library verwendet.

---

# 11. Breaking Changes

Während der Projektarbeit soll mindestens eine Schnittstellenänderung demonstriert werden.

Beispielsweise wird ein bestehendes Event erweitert:

### Version 1

```json
{
  "executionId": "exec-123",
  "message": "Routine completed"
}
```

### Version 2

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

Die Änderung soll nach Möglichkeit ohne gleichzeitiges Deployment aller betroffenen Services erfolgen können.

Damit wird die Evolution einer Schnittstelle innerhalb eines verteilten Systems demonstriert.

---

# 12. Observability

Da eine Routine mehrere Systemkomponenten durchläuft, muss eine einzelne Ausführung über die verschiedenen Services hinweg nachvollziehbar sein.

Dazu wird eine Korrelations- bzw. Trace-ID verwendet.

Beispiel:

```text
Trace ID: 7f91a2

API Gateway
    │
    ▼
Routine Service
    │
    ▼
Message Broker
    │
    ├──► Worker Service
    │
    └──► Notification Service
```

Die beteiligten Services schreiben strukturierte Logs mit dieser ID.

Dadurch kann nachvollzogen werden, wann und wo eine Routine oder einzelne Aktion verarbeitet wurde.

---

# 13. Projektvorgehen

Das Projekt wird schrittweise umgesetzt.

## Phase 1 – Konzeption

* Anforderungen definieren
* Features festlegen und priorisieren
* Systemkomponenten bestimmen
* Verantwortlichkeiten verteilen
* Architektur entwerfen
* Hochverfügbarkeitsmassnahmen definieren

## Phase 2 – Schnittstellenplanung

* synchrone Schnittstellen definieren
* Event-Schemas definieren
* Datenverantwortlichkeiten festlegen
* Fehlerfälle betrachten
* Versionierung planen

## Phase 3 – Machbarkeitsprüfung

* Message Broker testen
* Hochverfügbarkeitskonzepte testen
* Deployment auf LernMAAS überprüfen
* grundlegende Kommunikation zwischen Komponenten testen

## Phase 4 – Individuelle Entwicklung

Jedes Teammitglied entwickelt seine zugewiesene Systemkomponente unabhängig.

Dabei werden die zuvor definierten Schnittstellen eingehalten.

## Phase 5 – Integration

Die einzelnen Komponenten werden miteinander verbunden.

Anschliessend wird der vollständige End-to-End-Workflow getestet.

## Phase 6 – Hochverfügbarkeit

Die geplanten Massnahmen für Hochverfügbarkeit werden umgesetzt und getestet.

## Phase 7 – Testing und Fehlerbehebung

Das Gesamtsystem wird unter normalen Bedingungen sowie bei Ausfällen einzelner Komponenten getestet.

## Phase 8 – Dokumentation und Abgabe

Die Dokumentation wird vervollständigt und Code sowie Dokumentation werden für die Abgabe vorbereitet.

---

# 14. Testing

Das Testing erfolgt parallel zur Entwicklung.

Für die Systemkomponenten werden Testfälle definiert und dokumentiert.

Besonders getestet werden:

* erfolgreiche Routine-Ausführung
* fehlerhafte Aktionen
* wiederholte Nachrichten
* Ausfall eines Consumers
* Wiederaufnahme nach einem Ausfall
* parallele Verarbeitung
* horizontale Skalierung
* Schnittstellenänderungen
* End-to-End-Kommunikation

Zusätzlich sollen, sofern zeitlich möglich, automatisierte Tests für die einzelnen Komponenten erstellt werden.

---

# 15. Deployment

Das Gesamtsystem soll auf LernMAAS betrieben werden können.

Die benötigten Services und Infrastrukturkomponenten werden containerisiert und über eine gemeinsame Deployment-Konfiguration gestartet.

Ziel ist ein möglichst einfacher Start des Gesamtsystems.

Beispielsweise:

```bash
docker compose up
```

Nach dem Start sollen alle für den Systemdurchlauf benötigten Komponenten verfügbar sein.

---

# 16. Abgrenzung

Routine ist keine vollständige Workflow-Automatisierungsplattform wie kommerzielle Lösungen.

Der Fokus des Projekts liegt auf der Demonstration der technischen Eigenschaften eines verteilten Systems.

Daher werden bewusst keine umfangreichen Funktionen wie komplexe Benutzerverwaltung, umfangreiche Integrationskataloge oder ein visueller Workflow-Editor umgesetzt.

Die vorhandene Entwicklungszeit soll stattdessen für saubere Schnittstellen, autonome Komponenten, asynchrone Kommunikation, Hochverfügbarkeit und Testing eingesetzt werden.

---

# 17. Erwartetes Projektergebnis

Am Ende des Projekts steht ein funktionsfähiges verteiltes System, mit dem Benutzer Routinen erstellen und ausführen können.

Das System besteht aus mehreren unabhängig entwickelten Systemkomponenten und ermöglicht einen vollständigen End-to-End-Durchlauf.

Zusätzlich kann demonstriert werden, dass:

* eine Komponente unabhängig ausfallen kann,
* bereits publizierte Aufgaben nicht verloren gehen,
* Aufgaben nach einem Ausfall weiterverarbeitet werden,
* Worker horizontal skaliert werden können,
* Nachrichten idempotent verarbeitet werden,
* verteilte Abläufe nachvollziehbar sind,
* Schnittstellen weiterentwickelt werden können, ohne das Gesamtsystem gleichzeitig zu aktualisieren.

Damit deckt Routine die zentralen Lernziele der Projektarbeit ab und bietet gleichzeitig einen überschaubaren Umfang für die verfügbare Projektzeit.

---

# 18. Fazit

Mit Routine wird ein praxisnahes Beispiel für ein verteiltes System umgesetzt. Die Anwendung selbst bleibt bewusst einfach, während die technische Architektur verschiedene zentrale Herausforderungen verteilter Systeme sichtbar macht.

Die Aufteilung in autonome Services ermöglicht es den Teammitgliedern, unabhängig voneinander zu entwickeln und gleichzeitig über definierte Schnittstellen ein gemeinsames Gesamtsystem zu erstellen.

Der wichtigste Mehrwert des Projekts liegt deshalb nicht in der Anzahl der Funktionen, sondern darin, dass Verteilung, Asynchronität, Service-Autonomie, Hochverfügbarkeit und Schnittstellen-Evolution praktisch umgesetzt und demonstriert werden können.
