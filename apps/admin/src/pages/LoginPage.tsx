import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { LoginError } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../components/ui/Button';
import { IconCheck, IconEye, IconEyeOff, IconLock, IconMail } from '../components/ui/icons';

/** Login failure `code` → operator message. 401 = wrong credentials; anything else = backend unreachable. */
const LOGIN_MESSAGE: Record<string, string> = {
  INVALID_CREDENTIALS: 'Invalid email or password',
  SERVICE_UNAVAILABLE: 'Service unavailable — please try again in a moment',
};

// Dark inputs are styled inline (the login is the one dark-on-dark surface) rather than via the shared
// light `Input` primitive, so the dark classes win without a class-merge dependency.
const darkInput =
  'h-10 w-full rounded-md border border-white/10 bg-chrome-900/70 text-sm text-white shadow-sm ' +
  'placeholder:text-chrome-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/60';

// KPI tiles + feature list are static marketing chrome from the reference (00-login).
const STATS = [
  { label: 'Active Tickets', value: '248' },
  { label: 'SLA Compliance', value: '96.2%' },
  { label: 'Fleet Online', value: '14,238' },
  { label: 'Engineers Active', value: '84' },
];
const FEATURES = [
  'Real-time Ticket Tracking',
  'SLA Monitoring',
  'Fleet Visibility',
  'Engineer Management',
];

/**
 * Login (Issue 01 / FE-01). Reskinned to the `00-login` reference: dark split layout, marketing +
 * KPI tiles on the left, the sign-in card on the right. The `useAuth().login` flow is unchanged.
 */
export function LoginPage() {
  const { login, sessionExpired, clearSessionExpired } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    clearSessionExpired();
    setSubmitting(true);
    try {
      await login(email, password);
      navigate('/', { replace: true });
    } catch (err) {
      // 401 = invalid credentials; network/5xx = service unavailable (Issue 109 — honest errors).
      const code = err instanceof LoginError ? err.code : 'INVALID_CREDENTIALS';
      setError(LOGIN_MESSAGE[code] ?? LOGIN_MESSAGE.INVALID_CREDENTIALS);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="grid min-h-screen bg-chrome-900 text-white lg:grid-cols-[1.05fr_0.95fr]"
      style={{
        // Faint blueprint grid over the dark chrome, with a soft red brand glow (uiDashboardRef re-theme).
        backgroundImage:
          'radial-gradient(circle at 18% 12%, rgba(185,16,43,0.14), transparent 28rem), linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)',
        backgroundSize: '48px 48px',
      }}
    >
      {/* Left — brand + marketing + KPI tiles (hidden on small screens) */}
      <div className="relative hidden flex-col justify-between overflow-hidden p-12 lg:flex">
        <div>
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-b from-brand-600 to-brand-700 text-lg font-bold shadow-lg shadow-brand-700/25">
              A
            </span>
            <div>
              <div className="text-lg font-semibold">Autoplant</div>
              <div className="text-xs text-chrome-muted">Fleet Operations Platform</div>
            </div>
          </div>

          <h1 className="mt-16 max-w-lg text-5xl font-semibold leading-[1.05]">
            Manage Fleet Operations <span className="text-brand-600">Faster.</span>
          </h1>
          <p className="mt-5 max-w-md text-base leading-7 text-chrome-text">
            Monitor tickets, track SLA compliance, manage field engineers, and maintain complete fleet
            visibility from a unified platform.
          </p>
        </div>

        <div className="grid max-w-md grid-cols-2 gap-4">
          {STATS.map((s) => (
            <div key={s.label} className="rounded-card border border-white/10 bg-white/5 p-4 shadow-card backdrop-blur">
              <div className="text-xs text-chrome-muted">{s.label}</div>
              <div className="mt-1 text-2xl font-bold">{s.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Right — sign-in card */}
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm rounded-card border border-white/10 bg-chrome-800/75 p-8 shadow-floating backdrop-blur-xl">
          <h2 className="text-2xl font-semibold tracking-tight">Welcome Back</h2>
          <p className="mt-1 text-sm text-chrome-muted">Sign in to continue to Autoplant Platform.</p>

          {sessionExpired && (
            <p role="status" className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
              Your session expired. Please sign in again.
            </p>
          )}

          <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="email" className="text-[0.7rem] font-semibold uppercase tracking-wide text-chrome-text">
                Email Address
              </label>
              <div className="relative">
                <IconMail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-chrome-muted" />
                <input
                  id="email"
                  type="email"
                  autoComplete="username"
                  placeholder="zone.head@autoplant.in"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={`${darkInput} pl-9 pr-3`}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="password" className="text-[0.7rem] font-semibold uppercase tracking-wide text-chrome-text">
                Password
              </label>
              <div className="relative">
                <IconLock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-chrome-muted" />
                <input
                  id="password"
                  type={showPw ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={`${darkInput} px-9`}
                />
                {/* aria-label deliberately omits "password" so getByLabelText(/password/i) stays unambiguous. */}
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  aria-label={showPw ? 'Hide' : 'Show'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-chrome-muted hover:text-white"
                >
                  {showPw ? <IconEyeOff className="h-4 w-4" /> : <IconEye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between text-xs">
              <label className="flex items-center gap-2 text-chrome-text">
                <input type="checkbox" className="h-3.5 w-3.5 rounded border-chrome-700" /> Remember me
              </label>
              <a href="#" className="font-semibold text-brand-300 hover:text-white hover:underline">
                Forgot Password?
              </a>
            </div>

            {error && (
              <p role="alert" className="text-sm text-red-300">
                {error}
              </p>
            )}

            <Button type="submit" size="lg" loading={submitting} className="w-full">
              Sign In
            </Button>
          </form>

          <ul className="mt-6 space-y-2 border-t border-white/10 pt-6 text-xs text-chrome-text">
            {FEATURES.map((f) => (
              <li key={f} className="flex items-center gap-2">
                <IconCheck className="h-3.5 w-3.5 text-brand-300" /> {f}
              </li>
            ))}
          </ul>
          <p className="mt-6 text-center text-[11px] text-chrome-muted">
            Autoplant Platform v2.0 • Secure Enterprise Access
          </p>
        </div>
      </div>
    </div>
  );
}
