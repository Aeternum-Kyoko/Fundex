import { FormEvent, useCallback, useEffect, useState } from "react";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";
const TOKEN_KEY = "arbradar-admin-token";

interface CredentialRow {
  exchange: string;
  display_name: string;
  accepts_keys: boolean;
  benefit: string;
  configured: boolean;
  key_hint?: string;
  updated_at?: string;
  verified_at?: string | null;
  verify_status?: string | null;
  verify_message?: string | null;
  verify_details?: Record<string, unknown>;
}

interface CredentialsResponse {
  encryption_ready: boolean;
  taker_fee_overrides_bps: Record<string, number>;
  exchanges: CredentialRow[];
}

interface AdminPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

function readToken() {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeToken(value: string) {
  try {
    if (value) {
      window.sessionStorage.setItem(TOKEN_KEY, value);
    } else {
      window.sessionStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // Storage blocked: the token simply lasts for this page view.
  }
}

async function readError(response: Response) {
  try {
    const payload = await response.json();
    return typeof payload?.detail === "string" ? payload.detail : `Request failed (${response.status}).`;
  } catch {
    return `Request failed (${response.status}).`;
  }
}

const STATUS_TONE: Record<string, string> = { verified: "positive", warning: "warning", error: "danger" };

export function AdminPanel({ isOpen, onClose }: AdminPanelProps) {
  const [token, setToken] = useState(readToken);
  const [tokenInput, setTokenInput] = useState("");
  const [adminEnabled, setAdminEnabled] = useState<boolean | null>(null);
  const [data, setData] = useState<CredentialsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [forms, setForms] = useState<Record<string, { api_key: string; api_secret: string; exchange: string }>>({});
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const request = useCallback(
    async (path: string, init?: RequestInit) => {
      const response = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", "X-Admin-Token": token, ...(init?.headers ?? {}) },
      });
      if (response.status === 401) {
        writeToken("");
        setToken("");
        throw new Error("Admin token rejected. Enter it again.");
      }
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      return response.json();
    },
    [token],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const status = await fetch(`${API_BASE}/admin/status`).then((response) => response.json());
      setAdminEnabled(Boolean(status.admin_enabled));
      if (!status.admin_enabled || !token) {
        return;
      }
      setData((await request("/admin/credentials")) as CredentialsResponse);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load admin data.");
    }
  }, [request, token]);

  useEffect(() => {
    if (isOpen) {
      void load();
    }
  }, [isOpen, load]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  const submitToken = (event: FormEvent) => {
    event.preventDefault();
    const value = tokenInput.trim();
    writeToken(value);
    setToken(value);
    setTokenInput("");
  };

  const formFor = (exchange: string) => forms[exchange] ?? { api_key: "", api_secret: "", exchange: "EXCHANGE_2" };
  const updateForm = (exchange: string, field: "api_key" | "api_secret" | "exchange", value: string) =>
    setForms((current) => ({ ...current, [exchange]: { ...formFor(exchange), [field]: value } }));

  const run = async (exchange: string, action: () => Promise<unknown>) => {
    setBusy(exchange);
    setError(null);
    try {
      await action();
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Request failed.");
    } finally {
      setBusy(null);
    }
  };

  const save = (exchange: string) =>
    run(exchange, async () => {
      const form = formFor(exchange);
      await request(`/admin/credentials/${exchange}`, {
        method: "PUT",
        body: JSON.stringify({
          api_key: form.api_key,
          api_secret: form.api_secret,
          extra: exchange === "coinswitch" ? { exchange: form.exchange } : {},
        }),
      });
      // Secrets are not kept in the page once the server has them.
      setForms((current) => ({ ...current, [exchange]: { ...formFor(exchange), api_key: "", api_secret: "" } }));
    });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <aside className="inspector-modal admin-panel" role="dialog" aria-modal="true" aria-labelledby="admin-title" onClick={(event) => event.stopPropagation()}>
        <div className="inspector-header">
          <div>
            <p className="eyebrow">Admin</p>
            <h3 id="admin-title">Exchange API keys</h3>
            <p className="subtle">
              Keys are encrypted on the server and never sent back to the browser. Use read-only keys with withdrawals disabled.
            </p>
          </div>
          <div className="inspector-actions">
            {token ? (
              <button type="button" className="overview-button" onClick={() => { writeToken(""); setToken(""); setData(null); }}>
                Lock
              </button>
            ) : null}
            <button type="button" className="close-button" onClick={onClose} aria-label="Close admin">
              Close
            </button>
          </div>
        </div>

        {error ? <div className="banner banner-error">{error}</div> : null}

        {adminEnabled === false ? (
          <div className="empty-state">
            <p>Admin is disabled on this backend.</p>
            <span>Set ADMIN_TOKEN and CREDENTIALS_ENCRYPTION_KEY in the backend environment, then restart it.</span>
          </div>
        ) : !token ? (
          <form className="admin-token-form" onSubmit={submitToken}>
            <label className="control">
              <span className="subtle">Admin token (ADMIN_TOKEN in the backend .env)</span>
              <input type="password" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} autoComplete="off" autoFocus />
            </label>
            <button type="submit" className="action-button" disabled={!tokenInput.trim()}>
              Unlock admin
            </button>
          </form>
        ) : !data ? (
          <p className="subtle">Loading…</p>
        ) : (
          <div className="admin-grid">
            {!data.encryption_ready ? (
              <div className="banner banner-error">CREDENTIALS_ENCRYPTION_KEY is not set on the backend, so keys cannot be saved.</div>
            ) : null}
            {data.exchanges.map((row) => {
              const form = formFor(row.exchange);
              const tone = STATUS_TONE[row.verify_status ?? ""] ?? "neutral";
              const fee = data.taker_fee_overrides_bps[row.exchange];
              return (
                <section key={row.exchange} className={`overview-card admin-card ${row.accepts_keys ? "" : "admin-card-muted"}`}>
                  <div className="overview-card-header">
                    <strong>{row.display_name}</strong>
                    {row.configured ? (
                      <span className={`quality-badge quality-${tone}`}>{row.verify_status ?? "saved"} · key {row.key_hint}</span>
                    ) : (
                      <span className="subtle">{row.accepts_keys ? "No key" : "Public data"}</span>
                    )}
                  </div>
                  <p className="subtle">{row.benefit}</p>
                  {row.verify_message ? <p className={tone === "danger" ? "negative" : undefined}>{row.verify_message}</p> : null}
                  {fee != null ? <p className="subtle">Active taker fee in calculations: {(fee / 100).toFixed(4)}%</p> : null}

                  {row.accepts_keys ? (
                    <form
                      className="admin-key-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void save(row.exchange);
                      }}
                    >
                      <label className="control">
                        <span className="subtle">API key</span>
                        <input value={form.api_key} onChange={(event) => updateForm(row.exchange, "api_key", event.target.value)} autoComplete="off" spellCheck={false} />
                      </label>
                      <label className="control">
                        <span className="subtle">API secret</span>
                        <input type="password" value={form.api_secret} onChange={(event) => updateForm(row.exchange, "api_secret", event.target.value)} autoComplete="new-password" />
                      </label>
                      {row.exchange === "coinswitch" ? (
                        <label className="control">
                          <span className="subtle">CoinSwitch exchange code</span>
                          <input value={form.exchange} onChange={(event) => updateForm(row.exchange, "exchange", event.target.value)} />
                        </label>
                      ) : null}
                      <div className="button-row">
                        <button type="submit" className="action-button" disabled={busy === row.exchange || !form.api_key || !form.api_secret || !data.encryption_ready}>
                          {busy === row.exchange ? "Verifying…" : row.configured ? "Replace & verify" : "Save & verify"}
                        </button>
                        {row.configured ? (
                          <>
                            <button
                              type="button"
                              className="action-button secondary-button"
                              disabled={busy === row.exchange}
                              onClick={() => void run(row.exchange, () => request(`/admin/credentials/${row.exchange}/verify`, { method: "POST" }))}
                            >
                              Re-verify
                            </button>
                            <button
                              type="button"
                              className="action-button secondary-button"
                              disabled={busy === row.exchange}
                              onClick={() => {
                                if (confirmRemove !== row.exchange) {
                                  setConfirmRemove(row.exchange);
                                  return;
                                }
                                setConfirmRemove(null);
                                void run(row.exchange, () => request(`/admin/credentials/${row.exchange}`, { method: "DELETE" }));
                              }}
                            >
                              {confirmRemove === row.exchange ? "Click again to remove" : "Remove key"}
                            </button>
                          </>
                        ) : null}
                      </div>
                    </form>
                  ) : null}
                </section>
              );
            })}
          </div>
        )}
      </aside>
    </div>
  );
}
