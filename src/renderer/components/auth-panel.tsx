import { useEffect, useRef, useState } from "react";
import {
  startOAuthFlowAsync,
  openSystemBrowser,
  setApiKey,
  setAuthTokens,
  persistOAuthTokens,
  persistApiKey,
} from "../services/claude-client";

interface AuthPanelProps {
  onAuthenticated: () => void;
}

export function AuthPanel({ onAuthenticated }: AuthPanelProps) {
  const [mode, setMode] = useState<"idle" | "authenticating" | "paste-key">("idle");
  const [apiKey, setLocalKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => { abortRef.current?.(); };
  }, []);

  const handleLogin = async () => {
    setMode("authenticating");
    setError(null);
    try {
      const { url, completion, abort } = await startOAuthFlowAsync();
      abortRef.current = abort;
      openSystemBrowser(url);
      const tokens = await completion;
      abortRef.current = null;
      persistOAuthTokens(tokens);
      setAuthTokens(tokens);
      onAuthenticated();
    } catch (err: any) {
      abortRef.current = null;
      if (err.message !== "Authentication cancelled.") {
        setError(err.message || "Login failed");
      }
      setMode("idle");
    }
  };

  const handlePasteKey = () => {
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    persistApiKey(trimmed);
    setApiKey(trimmed);
    onAuthenticated();
  };

  if (mode === "paste-key") {
    return (
      <div className="flai-auth__input">
        <div className="flai-auth__hint">
          Paste your API key from{" "}
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">console.anthropic.com</a>
        </div>
        <div className="flai-auth__row">
          <input
            type="password"
            className="flai-auth__field"
            placeholder="sk-ant-..."
            value={apiKey}
            onChange={(e) => setLocalKey(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handlePasteKey(); }}
          />
          <button type="button" className="flai-btn flai-btn--primary" onClick={handlePasteKey} disabled={!apiKey.trim()}>
            Save
          </button>
        </div>
        <button type="button" className="flai-btn flai-btn--link" onClick={() => setMode("idle")}>Back</button>
      </div>
    );
  }

  if (mode === "authenticating") {
    return (
      <div className="flai-auth__input flai-auth__input--center">
        <div className="flai-loading">
          <span className="flai-spinner"><span /><span /><span /></span>
          Waiting for browser authentication...
        </div>
        {error && <div className="flai-error">{error}</div>}
        <button type="button" className="flai-btn flai-btn--link" onClick={() => { abortRef.current?.(); setMode("idle"); }}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flai-auth__input flai-auth__input--center">
      <div className="flai-auth__hint">
        Authenticate to enable AI-powered analysis
      </div>
      {error && <div className="flai-error">{error}</div>}
      <div className="flai-auth__row">
        <button type="button" className="flai-btn flai-btn--primary" onClick={handleLogin}>
          Login with Claude
        </button>
        <button type="button" className="flai-btn flai-btn--link" onClick={() => setMode("paste-key")}>
          or paste API key
        </button>
      </div>
    </div>
  );
}
