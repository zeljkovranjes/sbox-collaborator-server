import { useState } from 'preact/hooks';
import { api, ApiError, type Me } from '../api';
import { Icon, Loading, useLoad } from '../lib';
import { AuthArt, Stepper } from './login';

interface DeviceInfo {
  userCode: string;
  clientName: string;
  clientType: string;
  hasServerKey: boolean;
  expiresAt: string;
}

/** Browser half of the editor sign-in: shows the code, then approves via GitHub (or the current session). */
export function DevicePage({ me, loading }: { me: Me | null; loading: boolean }) {
  const params = new URLSearchParams(location.search);
  const code = (params.get('code') ?? '').toUpperCase();
  const [done, setDone] = useState(params.get('approved') === '1');
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(params.get('error'));
  const [busy, setBusy] = useState(false);
  const info = useLoad(() => (code && !done ? api.get<DeviceInfo>(`/api/auth/device/${encodeURIComponent(code)}`) : Promise.resolve(null)), [code, done]);

  if (loading) return <Loading />;

  const github = async () => {
    setBusy(true);
    try {
      const { url } = await api.post<{ url: string }>('/api/auth/github/start', { device: code });
      location.href = url;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'GitHub login failed');
      setBusy(false);
    }
  };
  const approve = async () => {
    setBusy(true);
    try {
      await api.post('/api/auth/device/approve', { userCode: code });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Approval failed');
    } finally {
      setBusy(false);
    }
  };
  const deny = async () => {
    await api.post('/api/auth/device/deny', { userCode: code }).catch(() => undefined);
    setDenied(true);
  };

  return (
    <div class="auth">
      <AuthArt />
      <div class="auth-panel">
        <div style="max-width:400px;width:100%;margin:0 auto">
          <h2>Connect the s&amp;box editor</h2>
          <p class="muted" style="margin:0">Approve this sign-in to give the editor its own access key.</p>
          <Stepper steps={['Address', 'Server key', 'GitHub']} current={done ? 3 : 2} />

          {error && (
            <div class="banner red" style="margin-bottom:16px">
              <Icon name="error" />
              <span>{error}</span>
            </div>
          )}

          {done ? (
            <div class="col" style="align-items:center;text-align:center;gap:10px;padding:10px 0">
              <Icon name="check_circle" fill style="font-size:52px;color:var(--green)" />
              <h3 style="margin:0">You’re connected</h3>
              <p class="muted" style="margin:0">Go back to s&amp;box – the Collaborator panel signs in on its own. You can close this tab.</p>
            </div>
          ) : denied ? (
            <div class="banner yellow">
              <Icon name="block" />
              <span>Sign-in denied. Nothing was shared.</span>
            </div>
          ) : !code ? (
            <div class="banner yellow">
              <Icon name="info" />
              <span>Open this page from the Collaborator panel in the s&amp;box editor.</span>
            </div>
          ) : info.error ? (
            <div class="banner red">
              <Icon name="timer_off" />
              <span>{info.error} Start again from the editor.</span>
            </div>
          ) : !info.data ? (
            <Loading />
          ) : (
            <div class="col" style="gap:16px">
              <div class="field">
                <label>Code shown in the editor</label>
                <div class="code-display">{info.data.userCode}</div>
              </div>
              <div class="small muted">
                <Icon name="desktop_windows" style="font-size:15px;vertical-align:-3px" /> {info.data.clientName}
                {info.data.hasServerKey && <span class="pill green" style="margin-left:6px">server key ok</span>}
              </div>
              {me ? (
                <>
                  <button class="btn primary big block" onClick={approve} disabled={busy}>
                    <Icon name="check" /> Approve as {me.developer.displayName}
                  </button>
                  <button class="linkish small" style="align-self:center" onClick={github}>
                    Use a different GitHub account
                  </button>
                </>
              ) : (
                <button class="btn big block gh-btn" onClick={github} disabled={busy}>
                  <Icon name="login" /> Continue with GitHub
                </button>
              )}
              <button class="btn ghost block" onClick={deny}>
                Deny
              </button>
              <p class="tiny faint" style="margin:0">Only approve if the code matches the one in your editor.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
