# Projektarbeit: Distributed Systems & Service Autonomy

## Übersicht & Zielsetzung

In dieser Projektarbeit implementieren Sie in Teams von **2 bis maximal 3 Personen** ein verteiltes System nach
Microservice-Prinzipien. Ziel ist die praxisnahe Simulation einer Unternehmensorganisation mit autonomen Service-Teams.

Jedes Teammitglied übernimmt die vollständige Verantwortung für mindestens 1–2 Services/Komponenten. Der Fokus liegt auf Schnittstellendisziplin, Daten-Autonomie, Entkopplung,
Resilienz, Observability sowie dem Beherrschen von Breaking Changes. UI und Funktionalität der Software sind sekundär.

## Rahmenbedingungen & Architektur-Regeln

### Repository-Isolation

Die Services, die von einem Teammitglied entwickelt werden, liegen in einem eigenen Git-Repository.

Commits und Code-Ownership im jeweiligen Service-Repo sind strikt dem zuständigen Teammitglied zugeordnet (die Nutzung
von KI-Werkzeugen ist explizit erlaubt).

### Shared Assets & Kontrakte

Es dürfen zusätzliche Meta-/Shared-Repositories existieren.

Diese Repos dürfen ausschliesslich enthalten:

* Schnittstellenkontrakte (z. B. OpenAPI-Spezifikationen, AsyncAPI-Schemas, Protobuf-Dateien).
* Gemeinsame Deployment- und Orchestrierungs-Konfigurationen (z. B. docker-compose.yml oder Scripts).

### Deployment:

Alle Teammitlieder müssen fähig sein, das Gesamtsystem (alle Services, Datenbanken, Message Broker, Observability-Tools)
zu starten.

## Technische Schwerpunkte

* Schnittstellendesign: Explizite formal definierte Kontrakte (OpenAPI/Protobuf/AsyncAPI) vor oder parallel zur
  Implementierung.

* Asynchronität & Idempotenz: Entkopplung über einen Message-Broker (z.B. RabbitMQ, Kafka, NATS).

* Observability: Nachvollziehbarkeit von Anfragen über Service-Grenzen hinweg mittels strukturierter Logs und
  durchgereichter Correlation-ID (oder OpenTelemetry/Tracing).

* Breaking Changes & Evolution: Demonstration einer API-Änderung (v1 $\to$ v2) ohne Systemfehler oder simultane
  Deployments (Expand and Contract-Muster, Tolerant Reader).

## Detailliertes Bewertungsraster

Das Raster unterscheidet vier Qualitätsstufen:

* Ungenügend (0% - 59%): Kriterium nicht erfüllt, fehlerhaft oder missachtet Kernprinzipien.

* Minimal (60% - 74%, 4er Zone): Basisanforderungen erfüllt; teilweise Lücken oder manuelle Eingriffe nötig.

* Ideal (75% - 89%, 5er Zone): Solider, industrienaher Standard sauber umgesetzt.

* Maximal (90% - 100%, 6er Zone): Best-Practice-Lösung mit fundierter technischer Reife und Weitsicht.

### Raster-Übersicht

| Nr. | Kriterium                                  | Gewichtung | Ungenügend                                                                                 | Minimal (60% - 74%)                                                                                                                        | Ideal (75% - 89%)                                                                                                                                                     | Maximal (90% - 100%)                                                                                                                                              |
|-----|--------------------------------------------|------------|--------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1   | Systemdokumentation & Architekturüberblick | 5 Pkt      | Keine Dokumentation vorhanden.                                                             | Textlastige Beschreibung, rudimentäres Diagramm. Systemarchitektur nur durch Code-Inspektion verständlich.                                 | Präziser One-Pager mit Diagramm; Service-Grenzen, Protokolle und Verantwortlichkeiten sind klar erkennbar.                                                            | Umfassende Visualisierung inkl. synchroner/asynchroner Datenflüsse, Fehlerbehandlung und Deployment-Topologie.                                                    |
| 2   | Schnittstellendesign & Kontrakte           | 15 Pkt     | Keine funktionierende synchrone Kommunikation zwischen den Services.                       | Keine Gemeinsame Schnittstellen Basis. Kommunikation funktioniert, aber Schnittstellenänderungen können nicht technisch propagiert werden. | Kontrakte über Shared Code aber ohne formalen Kontrakt gelöst.                                                                                                        | Formale Kontrakte (OpenAPI/AsyncAPI/Protobuf) versioniert im Shared-Repo; klare DTO-Trennung.                                                                     |
| 3   | Asynchrone Entkopplung & Idempotenz        | 15 Pkt     | Keine asynchronität implementiert. Nur synchrone Kommunikation.                            | Asynchrone Prozesse implementiert, aber Services sind nicht voneinander entkoppelt.                                                        | Asynchrone Kommunikation via Message Broker für entkoppelte Prozesse.                                                                                                 | Saubere Idempotenz-Strategie. Konsumenten ignorieren oder handhaben doppelte Nachrichten. Ausfall/Verzögerung des Consumers blockiert Publisher in keiner Weise.  |
| 4   | Security & Login                           | 5 Pkt      | Keine Autorisierung / Authentifizierung implementiert.                                     | Autorisierung / Authentifizierung rudimentär implementiert: z.B. mit hardcodierten Mock JWTs.                                              | Social Login für Applikation integiert.                                                                                                                               | Eigenen Identity Provider (Keycloak, Auth0 oder AWS Cognito) konfiguriert und in Projekt integriert.                                                              |
| 5   | Observability & Distributed Tracing        | 5 Pkt      | Unstrukturierte Konsolen-Logs ohne Kontext; Nachverfolgung über Services hinweg unmöglich. | Korrelation der Logs der Services manuell möglich.                                                                                         | Einheitliches Logging-Format. Korrelations-ID wird über alle Aufrufe und Message-Payloads durchgereicht.                                                              | Vollständiges Distributed Tracing (z.B. OpenTelemetry/Jaeger) oder zentralisiertes Log-Aggregation-Setup mit Trace-Verknüpfung.                                   |
| 6   | Skalierbarkeit & Resilienz                 | 10 Pkt     | Kein Konzept für Skaliereung vorhanden                                                     | Konzept zur Skalierung von mindestens einem Worker/Service vorhanden aber nicht implementiert.                                             | Services sind stateless; mindestens ein Worker/Service lässt sich horizontal hochskalieren.                                                                           | Lastverteilung funktioniert dynamisch; Timeouts, Retries und Circuit-Breaker oder Graceful Degradation implementiert.                                             |
| 7   | Evolution & Breaking Change Handling       | 15 Pkt     | Änderung kann nicht implementiert werden. Verständnis für System nicht genügend vorhanden. | Änderung am Schema bricht abhängige Services (erfordert zeitgleiches Deployment beider Services).                                          | Breaking Change (v1 $\to$ v2) wird isoliert deployed; Rückwärtskompatibilität bleibt für bestehende Konsumenten gewahrt (z. B. Parallelbetrieb oder Tolerant Reader). | Konsequente Umsetzung des Expand and Contract-Patterns; Live-Migration eines Consumers ohne Unterbrechung oder Datenverlust.                                      |
| 8   | Autonomie, Repo-Struktur & Deployment      | 5 Pkt      | System kann nicht gerstartet werden.                                                       | Vermischte Repositories; gemeinsame Domain-Bibliotheken; komplexes manuelles Starten nötig.                                                | Repo Trennung eingehalten; strikte Trennung; Gesamtsystem mit einem Befehl startbar.                                                                                  | Isolierte CI-Pipelines (Linter/Tests). Services sind Containerisiert.                                                                                             |
| 9   | Live-Demonstration & Systemdurchstich      | 20 Pkt     | System funktioniert nicht und Verständnis vom System nicht vorhanden.                      | System demonstriert nur Teile; Abstürze bei regulärem Workflow; manuelle Eingriffe erforderlich.                                           | Strukturierter Durchstich des Haupt-Workflows; Systemzustand bleibt konsistent; Demo läuft flüssig.                                                                   | Souveräne Live-Demo inkl. Ausfallszenario (z. B. Service B gestoppt $\to$ Service A nimmt Auftrag an $\to$ Service B startet $\to$ Verarbeitung wird nachgeholt). |

## Checkliste für die Live-Demonstration (ca. 15 – maximal 20min)

Die Demonstration dient dem Nachweis der funktionierenden Architektur und Systemautonomie. Folgende Kernpunkte sind vom
Team vorzuführen:

[ ] Architektur & Ownership: Kurze Orientierung anhand eines Diagramms (wer verantwortet welchen Service und welche
Schnittstelle?).

[ ] End-to-End-Durchstich: Erfolgreiche Ausführung des Haupt-Workflows.

[ ] Breaking Change & Evolution: Demonstration einer API-Änderung in einem Service, während abhängige Services ohne
Ausfall weiterfunktionieren.

[ ] Resilienz / Skalierung: Kurzer Nachweis von horizontaler Skalierung (z.B. Worker) oder Pufferung bei temporärem
Service-Ausfall.
