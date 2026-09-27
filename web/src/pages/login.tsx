import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import { api, ApiError, type ServerInfo } from '../api';
import { Icon, useLoad } from '../lib';

export function AuthArt() {
  return (
    <div class="auth-art">
      <div class="brand">
        <img src="/logo.svg" alt="" />
        <span>
          Collaborator
          <small>s&amp;box team sync</small>
        </span>
      </div>
      <div>
        <h1>Your coding agents, working like one team.</h1>
        <p>Presence, tasks, file reservations, API changes and build status – shared between every developer and agent on your s&amp;box projects, with GitHub as the source of truth.</p>
      </div>
      <div class="auth-feed">
        <div class="item"><Icon name="task_alt" /> chomnr-agent claimed “Boat buoyancy rewrite”</div>
        <div class="item"><Icon name="lock" /> friend-agent reserved Assets/Weather/</div>
        <div class="item"><Icon name="published_with_changes" /> API change: ApplyBuoyancyForce introduced</div>
        <div class="item"><Icon name="science" /> Storm test passed on main</div>
      </div>
    </div>
  );
}

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div class="stepper">
      {steps.map((label, i) => (
        <Fragment key={label}>
          {i > 0 && <div class={`step-line${i <= current ? ' done' : ''}`} />}
          <div class={`step${i === current ? ' on' : ''}${i < current ? ' done' : ''}`}>
            <span class="n">{i < current ? <Icon name="check" style="font-size:15px" /> : i + 1}</span>
            {label}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

export function LoginPage({ signedIn }: { signedIn: boolean }) {
  const info = useLoad(() => api.get<ServerInfo>('/api/server-info'), []);
  const params = new URLSearchParams(location.search);
  const [error, setError] = useState<string | null>(params.get('error'));
  const [step, setStep] = useState(0);
  const [serverKey, setServerKey] = useState('');
  const [existing, setExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [accessKey, setAccessKey] = useState('');

  if (signedIn) {
    location.href = '/';
    return null;
  }

  const checkKey = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/server-key/check', { serverKey: serverKey.trim() });
      setExisting(false);
      setStep(1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not check the key');
    } finally {
      setBusy(false);
    }
  };

  const github = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.post<{ url: string }>('/api/auth/github/start', { serverKey: existing ? null : serverKey.trim(), returnTo: '/' });
      location.href = url;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'GitHub login failed');
      setBusy(false);
    }
  };

  const keyLogin = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/key-login', { token: accessKey.trim() });
      location.href = '/';
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
      setBusy(false);
    }
  };

  return (
    <div class="auth">
      <AuthArt />
      <div class="auth-panel">
        <div style="max-width:400px;width:100%;margin:0 auto">
          <h2>Join {info.data?.name ?? 'the team'}</h2>
          <p class="muted" style="margin:0">Enter the server key you were given, then sign in with GitHub.</p>
          <Stepper steps={['Server key', 'GitHub']} current={step} />

          {error && (
            <div class="banner red" style="margin-bottom:16px">
              <Icon name="error" />
              <span>{error}</span>
            </div>
          )}

          {step === 0 && (
            <form class="col" style="gap:14px" onSubmit={checkKey}>
              <div class="field">
                <label for="server-key">Server key</label>
                <input id="server-key" class="input mono" placeholder="sbj_…" value={serverKey} onInput={(e) => setServerKey((e.target as HTMLInputElement).value)} autoComplete="off" spellcheck={false} autoFocus />
              </div>
              <button class="btn primary big block" disabled={busy || serverKey.trim().length < 10}>
                Continue <Icon name="arrow_forward" />
              </button>
              <div class="row" style="justify-content:center">
                <button
                  type="button"
                  class="linkish small"
                  onClick={() => {
                    setExisting(true);
                    setStep(1);
                    setError(null);
                  }}
                >
                  I already have an account
                </button>
              </div>
            </form>
          )}

          {step === 1 && (
            <div class="col" style="gap:14px">
              <div class={`banner ${existing ? 'yellow' : 'green'}`}>
                <Icon name={existing ? 'person' : 'verified'} fill />
                <span class="small">{existing ? 'Signing in to your existing account.' : 'Server key accepted. Your GitHub account will be added to the team.'}</span>
              </div>
              <button class="btn big block gh-btn" onClick={github} disabled={busy || info.data?.githubLogin === false}>
                <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                </svg>
                Continue with GitHub
              </button>
              {info.data?.githubLogin === false && <div class="small yellow">GitHub login is not configured on this server – use an access key below.</div>}
              <button class="linkish small" style="align-self:center" onClick={() => setStep(0)}>
                ← Back
              </button>
            </div>
          )}

          <div class="or">or</div>
          {!showKey ? (
            <button class="btn ghost block" onClick={() => setShowKey(true)}>
              <Icon name="key" /> Sign in with an access key
            </button>
          ) : (
            <form class="col" onSubmit={keyLogin}>
              <input class="input mono" placeholder="sbc_…" value={accessKey} onInput={(e) => setAccessKey((e.target as HTMLInputElement).value)} autoComplete="off" spellcheck={false} />
              <button class="btn block" disabled={busy || accessKey.trim().length < 10}>
                Sign in
              </button>
            </form>
          )}
          <p class="tiny faint" style="margin-top:28px;text-align:center">
            {info.data ? `${info.data.name} · v${info.data.version}` : ''}
          </p>
        </div>
      </div>
    </div>
  );
}
