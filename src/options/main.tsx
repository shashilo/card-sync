import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AlertTriangle, Save } from "lucide-react";
import { applyProviderPreset, providerPreset, requestCustomProviderPermission } from "../shared/providers";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../shared/settings";
import type { ExtensionSettings } from "../shared/types";
import "./styles.css";

function OptionsApp(): JSX.Element {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preset = providerPreset(settings.provider.provider);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  async function persist(): Promise<void> {
    setError(null);
    const granted = await requestCustomProviderPermission(settings.provider);
    if (!granted) {
      setError("Chrome host permission was not granted for that custom AI endpoint.");
      return;
    }
    await saveSettings(settings);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  }

  return (
    <main className="options">
      <section className="header">
        <p>CardSync POC</p>
        <h1>Settings</h1>
      </section>

      <section className="panel">
        <label>
          AI provider
          <select
            value={settings.provider.provider}
            onChange={(event) =>
              setSettings({
                ...settings,
                provider: applyProviderPreset(settings.provider, event.target.value as ExtensionSettings["provider"]["provider"])
              })
            }
          >
            <option value="mock">Mock/page-text only</option>
            <option value="openai">OpenAI / ChatGPT API</option>
            <option value="openrouter">OpenRouter</option>
            <option value="anthropic">Anthropic Claude</option>
            <option value="custom-openai-compatible">Custom OpenAI-compatible</option>
          </select>
          <span>{preset.help}</span>
        </label>

        <label>
          API key
          <input
            type="password"
            value={settings.provider.apiKey}
            onChange={(event) => setSettings({ ...settings, provider: { ...settings.provider, apiKey: event.target.value } })}
            disabled={settings.provider.provider === "mock"}
            placeholder={preset.keyPlaceholder}
          />
          <span>Stored locally in Chrome, never in CardSync infrastructure.</span>
        </label>

        <label>
          Base URL
          <input
            value={settings.provider.baseUrl}
            disabled={preset.baseUrlReadonly}
            onChange={(event) => setSettings({ ...settings, provider: { ...settings.provider, baseUrl: event.target.value } })}
          />
        </label>

        <label>
          Model
          <input
            value={settings.provider.model}
            onChange={(event) => setSettings({ ...settings, provider: { ...settings.provider, model: event.target.value } })}
          />
        </label>

        {error ? (
          <div className="error">
            <AlertTriangle size={16} />
            {error}
          </div>
        ) : null}

        <div className="grid">
          <label>
            Scan cadence ms
            <input
              min={200}
              step={50}
              type="number"
              value={settings.scanCadenceMs}
              onChange={(event) => setSettings({ ...settings, scanCadenceMs: Number(event.target.value) })}
            />
          </label>

          <label>
            Stable after ms
            <input
              min={400}
              step={50}
              type="number"
              value={settings.identifyStableAfterMs}
              onChange={(event) => setSettings({ ...settings, identifyStableAfterMs: Number(event.target.value) })}
            />
          </label>
        </div>

        <label>
          Suggested max bid: {settings.maxBidPercent}% of the reference price
          <input
            type="range"
            min={10}
            max={100}
            step={1}
            value={settings.maxBidPercent}
            onChange={(event) => setSettings({ ...settings, maxBidPercent: Number(event.target.value) })}
          />
          <span>Uses the latest sold comp when available, otherwise the configured price guide or provisional estimate.</span>
        </label>

        <label className="checkRow">
          <input
            type="checkbox"
            checked={settings.allowAiEstimatedValues}
            onChange={(event) => setSettings({ ...settings, allowAiEstimatedValues: event.target.checked })}
          />
          Allow clearly labeled AI provisional values before comp-backed data arrives
        </label>

        <button type="button" onClick={persist}>
          <Save size={16} />
          {saved ? "Saved" : "Save settings"}
        </button>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <OptionsApp />
  </React.StrictMode>
);
