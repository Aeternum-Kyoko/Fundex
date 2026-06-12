import { FormEvent, ReactNode, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

interface LoginGateProps {
  children: ReactNode;
}

interface AuthSession {
  authenticated: boolean;
  configured: boolean;
  username: string | null;
}

export function LoginGate({ children }: LoginGateProps) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      try {
        const response = await apiFetch("/auth/session");
        if (!response.ok) {
          throw new Error("Unable to verify login session.");
        }
        const payload = (await response.json()) as AuthSession;
        if (!cancelled) {
          setSession(payload);
        }
      } catch {
        if (!cancelled) {
          setSession({ authenticated: false, configured: false, username: null });
          setError("Unable to reach the authentication server.");
        }
      }
    }

    void loadSession();

    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = async () => {
    await apiFetch("/auth/logout", { method: "POST" });
    setSession((current) => ({ authenticated: false, configured: current?.configured ?? true, username: null }));
    setPassword("");
  };

  const submitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await apiFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        setError(response.status === 401 ? "Invalid username or password." : "Login failed.");
        setPassword("");
        return;
      }

      const payload = (await response.json()) as Pick<AuthSession, "authenticated" | "username">;
      setSession({ authenticated: payload.authenticated, configured: true, username: payload.username });
      setPassword("");
    } catch {
      setError("Unable to reach the authentication server.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (session?.authenticated) {
    return (
      <>
        <button type="button" className="auth-sign-out action-button secondary-button" onClick={signOut}>
          Sign out
        </button>
        {children}
      </>
    );
  }

  const configured = session?.configured ?? true;

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <div>
          <p className="eyebrow">ArbRadar</p>
          <h1>Private access</h1>
          <p className="auth-copy">Sign in to open the live funding desk.</p>
        </div>

        {!configured ? (
          <div className="banner banner-error">
            Set AUTH_USERNAME, AUTH_PASSWORD, and AUTH_SESSION_SECRET in the backend environment, then redeploy.
          </div>
        ) : null}

        <form className="auth-form" onSubmit={submitLogin}>
          <label className="control">
            <span className="subtle">Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              autoFocus
              disabled={!configured || isSubmitting}
            />
          </label>
          <label className="control">
            <span className="subtle">Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              disabled={!configured || isSubmitting}
            />
          </label>
          {error ? <div className="auth-error">{error}</div> : null}
          <button type="submit" className="action-button auth-submit" disabled={!configured || isSubmitting || session === null}>
            {isSubmitting ? "Unlocking..." : "Unlock"}
          </button>
        </form>
      </section>
    </main>
  );
}
