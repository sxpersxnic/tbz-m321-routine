import { useState } from 'react';
import { signIn, takeSignInError, type SignInOptions } from '../auth.ts';
import { Icon, ThemeToggle } from '../components/ui.tsx';
import { ActionGlyph } from '../components/visual.tsx';

const DEMO = { email: 'demo@routine.local', password: 'demo12345' };

type Action = 'demo' | 'sign-in' | 'register';

/** Landing page. Passwords are typed on Keycloak's page, never here (OpenID Connect, see auth.ts). */
export function Login() {
  const [error, setError] = useState(takeSignInError);
  const [busy, setBusy] = useState<Action>();

  function start(action: Action, options: SignInOptions) {
    setBusy(action);
    setError(undefined);
    // on success the browser leaves for Keycloak; a failure means Keycloak did not answer
    signIn(options).catch(() => {
      setBusy(undefined);
      setError('Sign-in is unavailable right now. Try again in a moment.');
    });
  }

  const label = (action: Action, text: string) =>
    busy === action ? <><span className="spinner" /><span className="sr-only">Please wait</span></> : text;

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
        <div className="login-card">
          <h2>Welcome</h2>
          <button type="button" className="btn primary large block" disabled={busy !== undefined}
            onClick={() => start('demo', { loginHint: DEMO.email })}>
            {busy === 'demo' ? label('demo', '') : <><Icon name="play" size={16} /> Try the demo</>}
          </button>
          <p className="muted small center">Demo password: <code>{DEMO.password}</code></p>
          <div className="divider"><span>or</span></div>
          <button type="button" className="btn block" disabled={busy !== undefined} onClick={() => start('sign-in', {})}>
            {label('sign-in', 'Sign in')}
          </button>
          {error && <p className="error-note" role="alert">{error}</p>}
          <p className="muted small center">
            No account yet?{' '}
            <button type="button" className="link" disabled={busy !== undefined} onClick={() => start('register', { register: true })}>
              Sign up
            </button>
          </p>
          <p className="tech-note">
            A school project (module 321): distributed services that work together asynchronously through a message broker.
            Sign-in by Keycloak (OpenID Connect).
          </p>
        </div>
      </div>
    </main>
  );
}
