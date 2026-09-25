import { useState, type FormEvent } from 'react';
import { api, sessionStore } from '../api.ts';
import { Icon, ThemeToggle } from '../components/ui.tsx';
import { ActionGlyph } from '../components/visual.tsx';

const DEMO = { email: 'demo@routine.local', password: 'demo12345' };

export function Login() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function signIn(credentials: { email: string; password: string }, register = false) {
    setBusy(true);
    setError(undefined);
    try {
      if (register) await api.register(credentials.email, credentials.password, displayName || undefined);
      sessionStore.set(await api.login(credentials.email, credentials.password));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void signIn({ email, password }, mode === 'register');
  }

  return (
    // <main>: without a landmark, screen-reader users cannot jump to the form
    <main className="login-screen">
      <section className="login-art" aria-labelledby="login-pitch">
        <div className="brand"><img src="/favicon.svg" alt="" width={36} height={36} /> Routine</div>
        <h1 id="login-pitch">Recurring work that takes care of itself.</h1>
        <p>Set it up once – Routine handles the rest, on time and reliably.</p>
        {/* a routine, told the way the app tells it – the product explained by example */}
        <ol className="demo-flow" aria-label="Example: morning routine">
          <li className="demo-step">
            <span className="glyph tint-grey" style={{ width: 36, height: 36, borderRadius: 10 }} aria-hidden="true"><Icon name="clock" size={20} /></span>
            <span><small>When</small><strong>Every weekday at 07:30</strong></span>
          </li>
          <li className="demo-step">
            <ActionGlyph type="weather.get" size={36} />
            <span><small>Get weather</small><strong>Bern: 12 °C, partly cloudy</strong></span>
            <span className="done" aria-label="done"><Icon name="check" size={14} /></span>
          </li>
          <li className="demo-step">
            <ActionGlyph type="task.create" size={36} />
            <span><small>Create task</small><strong>Plan the day</strong></span>
            <span className="done" aria-label="done"><Icon name="check" size={14} /></span>
          </li>
          <li className="demo-step">
            <ActionGlyph type="notification.send" size={36} />
            <span><small>Send notification</small><strong>Good morning!</strong></span>
            <span className="done" aria-label="done"><Icon name="check" size={14} /></span>
          </li>
        </ol>
      </section>
      <div className="login-side">
        <div className="login-theme"><ThemeToggle withLabel /></div>
        <form className="login-card" onSubmit={submit}>
          <h2>{mode === 'login' ? 'Welcome back' : 'Create account'}</h2>
          {mode === 'login' && (
            <>
              <button type="button" className="btn primary large block" disabled={busy} onClick={() => void signIn(DEMO)}>
                <Icon name="play" size={16} /> Try the demo
              </button>
              <div className="divider"><span>or</span></div>
            </>
          )}
          {mode === 'register' && (
            <label className="field">
              <span>Name</span>
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} autoComplete="name" />
            </label>
          )}
          <label className="field">
            <span>Email</span>
            <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" />
          </label>
          <label className="field">
            <span>Password</span>
            <span className="password">
              <input type={reveal ? 'text' : 'password'} required minLength={8} value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
              <button type="button" className="btn plain icon-only" onClick={() => setReveal(!reveal)}
                aria-label={reveal ? 'Hide password' : 'Show password'} aria-pressed={reveal}>
                <Icon name={reveal ? 'eye-off' : 'eye'} size={16} />
              </button>
            </span>
            {mode === 'register' && <small className="muted">At least 8 characters.</small>}
          </label>
          {error && <p className="error-note" role="alert">{error}</p>}
          <button type="submit" className={`btn block ${mode === 'register' ? 'primary' : ''}`} disabled={busy}>
            {busy ? <><span className="spinner" /><span className="sr-only">Please wait</span></> : mode === 'login' ? 'Sign in' : 'Sign up'}
          </button>
          <p className="muted small center">
            {mode === 'login' ? 'No account yet? ' : 'Already registered? '}
            <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
              {mode === 'login' ? 'Sign up' : 'Sign in'}
            </button>
          </p>
          <p className="tech-note">
            A school project (module 321): distributed services that work together asynchronously through a message broker.
          </p>
        </form>
      </div>
    </main>
  );
}
