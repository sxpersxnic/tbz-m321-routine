import type { RoutineInput } from './types.ts';

/** Starting points for the editor – each one showcases a feature of the platform. */
export const TEMPLATES: Array<{ id: string; label: string; hint: string; routine: RoutineInput }> = [
  {
    id: 'weekly-review',
    label: 'Weekly Review',
    hint: 'parallele Aktionen, Datenfluss zwischen Schritten',
    routine: {
      name: 'Weekly Review',
      description: 'Wetter abrufen und Aufgabe erstellen (parallel), Zusammenfassung erzeugen, Benachrichtigung senden',
      trigger: { type: 'schedule', cron: '0 8 * * 1', timezone: 'Europe/Zurich' },
      actions: [
        { key: 'weather', type: 'weather.get', step: 1, params: { city: 'Zürich' } },
        { key: 'task', type: 'task.create', step: 1, params: { title: 'Wochenrückblick schreiben', dueInDays: 2, priority: 'high' } },
        {
          key: 'summary',
          type: 'summary.generate',
          step: 2,
          params: { title: 'Weekly Review', sections: { Wetter: '{{actions.weather.summary}}', Aufgabe: '{{actions.task.title}} (fällig {{actions.task.dueDate}})' } },
        },
        { key: 'notify', type: 'notification.send', step: 3, params: { title: 'Weekly Review bereit', body: '{{actions.summary.text}}' } },
      ],
    },
  },
  {
    id: 'morning-setup',
    label: 'Morning Setup',
    hint: 'Zeitplan an Werktagen',
    routine: {
      name: 'Morning Setup',
      description: 'Jeden Werktag um 07:30: Wetter, Tagesaufgabe, Guten-Morgen-Nachricht',
      trigger: { type: 'schedule', cron: '30 7 * * 1-5', timezone: 'Europe/Zurich' },
      actions: [
        { key: 'weather', type: 'weather.get', step: 1, params: { city: 'Bern' } },
        { key: 'task', type: 'task.create', step: 2, params: { title: 'Tagesplanung ({{actions.weather.condition}})', dueInDays: 0 } },
        { key: 'notify', type: 'notification.send', step: 3, params: { title: 'Guten Morgen', body: '{{actions.weather.summary}}' } },
      ],
    },
  },
  {
    id: 'flaky',
    label: 'Flaky Webhook',
    hint: 'Retry mit Backoff (2× HTTP 503)',
    routine: {
      name: 'Flaky Webhook',
      description: 'Der externe Dienst beantwortet die ersten zwei Versuche mit 503',
      trigger: { type: 'manual' },
      actions: [
        { key: 'call', type: 'http.request', step: 1, params: { method: 'POST', url: 'http://mock-external:8090/flaky?failTimes=2', body: { ping: true } } },
        { key: 'notify', type: 'notification.send', step: 2, params: { title: 'Webhook nach {{actions.call.body.attempt}} Versuchen erfolgreich' } },
      ],
    },
  },
  {
    id: 'heartbeat',
    label: 'Heartbeat',
    hint: 'Zeitplan alle 30 Sekunden (Demo)',
    routine: {
      name: 'Heartbeat',
      description: 'Ruft alle 30 Sekunden das Wetter ab',
      trigger: { type: 'schedule', cron: '*/30 * * * * *', timezone: 'Europe/Zurich' },
      actions: [{ key: 'weather', type: 'weather.get', step: 1, params: { city: 'Lugano' } }],
    },
  },
  {
    id: 'load',
    label: 'Load Test',
    hint: '12 parallele Aktionen – für die Skalierungs-Demo',
    routine: {
      name: 'Load Test',
      description: '12 parallele Wetterabfragen verteilen sich auf alle Worker-Replikas',
      trigger: { type: 'manual' },
      actions: ['Zürich', 'Bern', 'Basel', 'Luzern', 'Chur', 'Lugano', 'Genf', 'Lausanne', 'Sion', 'Thun', 'Aarau', 'Zug'].map((city, index) => ({
        key: `w${index + 1}`,
        type: 'weather.get',
        step: 1,
        params: { city },
      })),
    },
  },
  {
    id: 'broken',
    label: 'Fehlerhafter Endpunkt',
    hint: 'permanenter Fehler (HTTP 404)',
    routine: {
      name: 'Broken Endpoint',
      description: 'Ein 404 ist permanent – kein Retry, Folgeaktion wird übersprungen',
      trigger: { type: 'manual' },
      actions: [
        { key: 'call', type: 'http.request', step: 1, params: { method: 'GET', url: 'http://mock-external:8090/status/404' } },
        { key: 'notify', type: 'notification.send', step: 2, params: { title: 'wird nie gesendet' } },
      ],
    },
  },
];
