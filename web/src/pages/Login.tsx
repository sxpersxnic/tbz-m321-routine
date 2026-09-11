import { useState, type FormEvent } from 'react';
import { api, sessionStore } from '../api.ts';

export function Login() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('demo@routine.local');
  const [password, setPassword] = useState('demo12345');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (mode === 'register') await api.register(email, password, displayName || undefined);
      sessionStore.set(await api.login(email, password));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-intro">
        <div className="brand large"><img src="/favicon.svg" alt="" width={40} height={40} /> Routine</div>
        <p>Wiederkehrende Abläufe definieren – ausgeführt von autonomen Services, asynchron über einen Message Broker, fehlertolerant und skalierbar.</p>
        <ul className="feature-list">
          <li>Routinen mit Schritten, parallelen Aktionen und Zeitplan</li>
          <li>Live-Status jeder Ausführung über alle Services</li>
          <li>Retries, Idempotenz und Resilienz sichtbar gemacht</li>
        </ul>
      </div>
      <form className="card login-card" onSubmit={submit}>
        <h1>{mode === 'login' ? 'Anmelden' : 'Konto erstellen'}</h1>
        {mode === 'register' && (
          <label className="field">
            <span>Name</span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} autoComplete="name" />
          </label>
        )}
        <label className="field">
          <span>E-Mail</span>
          <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" />
        </label>
        <label className="field">
          <span>Passwort</span>
          <input type="password" required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        </label>
        {error && <p className="error-note">{error}</p>}
        <button type="submit" className="btn primary block" disabled={busy}>
          {busy ? 'Bitte warten …' : mode === 'login' ? 'Anmelden' : 'Registrieren & anmelden'}
        </button>
        <p className="muted small center">
          {mode === 'login' ? 'Noch kein Konto? ' : 'Bereits registriert? '}
          <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'Registrieren' : 'Anmelden'}
          </button>
        </p>
        <p className="muted small center">Demo-Konto: demo@routine.local / demo12345</p>
      </form>
    </div>
  );
}
