import { FormEvent, ReactNode, useState } from "react";

const AUTH_SESSION_KEY = "arbradar-frontend-auth-session";
const AUTH_USERNAME = (import.meta.env.VITE_AUTH_USERNAME as string | undefined)?.trim() ?? "";
const AUTH_PASSWORD = (import.meta.env.VITE_AUTH_PASSWORD as string | undefined) ?? "";

interface LoginGateProps {
  children: ReactNode;
}

function isConfigured() {
  return AUTH_USERNAME.length > 0 && AUTH_PASSWORD.length > 0;
}

function readSession() {
  if (typeof window === "undefined") {
    return false;
  }

  return window.sessionStorage.getItem(AUTH_SESSION_KEY) === "active";
}

export function LoginGate({ children }: LoginGateProps) {
  const [isAuthenticated, setIsAuthenticated] = useState(readSession);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const configured = isConfigured();

  const signOut = () => {
    window.sessionStorage.removeItem(AUTH_SESSION_KEY);
    setIsAuthenticated(false);
    setPassword("");
  };

  const submitLogin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (!configured) {
      setError("Login credentials are not configured.");
      return;
    }

    if (username.trim() !== AUTH_USERNAME || password !== AUTH_PASSWORD) {
      setError("Invalid username or password.");
      setPassword("");
      return;
    }

    window.sessionStorage.setItem(AUTH_SESSION_KEY, "active");
    setIsAuthenticated(true);
    setPassword("");
  };

  if (isAuthenticated && configured) {
    return (
      <>
        <button type="button" className="auth-sign-out action-button secondary-button" onClick={signOut}>
          Sign out
        </button>
        {children}
      </>
    );
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <div>
          <p className="eyebrow">ArbRadar</p>
          <h1>Private access</h1>
          <p className="auth-copy">Sign in to open the live funding desk.</p>
        </div>

        {!configured ? (
          <div className="banner banner-error">Set VITE_AUTH_USERNAME and VITE_AUTH_PASSWORD in Vercel, then redeploy.</div>
        ) : null}

        <form className="auth-form" onSubmit={submitLogin}>
          <label className="control">
            <span className="subtle">Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              autoFocus
              disabled={!configured}
            />
          </label>
          <label className="control">
            <span className="subtle">Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              disabled={!configured}
            />
          </label>
          {error ? <div className="auth-error">{error}</div> : null}
          <button type="submit" className="action-button auth-submit" disabled={!configured}>
            Unlock
          </button>
        </form>
      </section>
    </main>
  );
}
