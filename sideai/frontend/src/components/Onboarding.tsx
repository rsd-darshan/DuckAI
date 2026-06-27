import { useState, useEffect, useCallback } from "react";
import { useUser } from "@clerk/clerk-react";
import { fetchPermissionHealth, type PermissionHealth } from "../hooks/useBackend";

const CLERK_ENABLED = Boolean(
  (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined)?.trim()
);

type Step = "welcome" | "screen" | "accessibility" | "ai-key" | "done";
interface PermissionState { screen: "unknown" | "granted" | "denied"; accessibility: "unknown" | "granted" | "denied"; }
interface Props { onComplete: () => void; clerkEnabled?: boolean; }

export function Onboarding({ onComplete, clerkEnabled = CLERK_ENABLED }: Props) {
  const [step, setStep] = useState<Step>("welcome");
  const [perms, setPerms] = useState<PermissionState>({ screen: "unknown", accessibility: "unknown" });
  const [permDetail, setPermDetail] = useState<PermissionHealth | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [managedInfo, setManagedInfo] = useState<{ daily_limit: number; managed_mode: boolean } | null>(null);

  const applyHealth = useCallback((d: PermissionHealth) => {
    setPermDetail(d);
    setPerms({
      screen: d.screen_recording?.ok === true ? "granted" : "denied",
      accessibility: d.accessibility?.ok === true ? "granted" : "denied",
    });
  }, []);

  const checkPermissions = useCallback(async () => {
    try {
      const d = await fetchPermissionHealth();
      applyHealth(d);
    } catch {
      setPerms({ screen: "unknown", accessibility: "unknown" });
      setPermDetail(null);
    }
  }, [applyHealth]);

  useEffect(() => {
    void checkPermissions();
    fetchDeviceInfo();
  }, [checkPermissions]);

  async function fetchDeviceInfo() {
    try {
      const r = await fetch("http://127.0.0.1:8000/api/device/info");
      if (r.ok) {
        const d = await r.json();
        setManagedInfo({ daily_limit: d.daily_limit ?? 50, managed_mode: d.managed_mode });
      }
    } catch (_) {}
  }

  async function openScreenPrivacy() {
    if (window.sideai?.openScreenPrivacySettings) await window.sideai.openScreenPrivacySettings();
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      await checkPermissions();
      const h = await fetchPermissionHealth().catch(() => null);
      if (h?.screen_recording?.ok) break;
    }
  }

  async function openAccessibility() {
    if (window.sideai?.openAccessibilitySettings) await window.sideai.openAccessibilitySettings();
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      await checkPermissions();
      const h = await fetchPermissionHealth().catch(() => null);
      if (h?.accessibility?.ok) break;
    }
  }

  async function saveApiKey() {
    if (!apiKey.trim()) { next(); return; }
    setSaving(true);
    try {
      await fetch("http://127.0.0.1:8000/api/settings/user_api_key", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: apiKey.trim() }),
      });
    } catch (_) {}
    setSaving(false);
    next();
  }

  function next() {
    const flow: Step[] = ["welcome", "screen", "accessibility", "ai-key", "done"];
    const idx = flow.indexOf(step);
    if (idx < flow.length - 1) setStep(flow[idx + 1]);
  }

  async function finish() {
    if (window.sideai?.onboardingDone) await window.sideai.onboardingDone();
    onComplete();
  }

  const STEPS: Step[] = ["welcome", "screen", "accessibility", "ai-key"];
  const stepIdx = STEPS.indexOf(step);
  const screenHint = permDetail?.screen_recording?.hint;

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-hidden" style={{ background: "#09090B", color: "#F4F4F5" }}>
      {step !== "done" && (
        <div className="flex justify-center gap-1.5 pt-6 pb-2">
          {STEPS.map((s, i) => (
            <div
              key={s}
              className="rounded-full transition-all duration-300"
              style={{
                width: s === step ? "20px" : "6px",
                height: "6px",
                background: i < stepIdx ? "#6366F1" : s === step ? "#6366F1" : "#27272A",
              }}
            />
          ))}
        </div>
      )}

      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        {step === "welcome" && <WelcomeStep managedInfo={managedInfo} onNext={next} />}
        {step === "screen" && (
          <PermissionStep
            icon="🖥"
            title="Screen Recording"
            description="DuckAI reads your screen for context-aware help. Electron captures when the panel is collapsed; Python/Tesseract also run in the background."
            status={perms.screen}
            detail={screenHint}
            grantLabel="Open Screen Recording Settings"
            onGrant={openScreenPrivacy}
            onRecheck={checkPermissions}
            onSkip={next}
            onNext={next}
          />
        )}
        {step === "accessibility" && (
          <PermissionStep
            icon="⌨"
            title="Accessibility"
            description='Allows "Write It" to type AI-generated text into any app. You can skip and enable later.'
            status={perms.accessibility}
            detail={permDetail?.accessibility?.hint}
            grantLabel="Open Accessibility Settings"
            onGrant={openAccessibility}
            onRecheck={checkPermissions}
            onSkip={next}
            onNext={next}
            optional
          />
        )}
        {step === "ai-key" && (
          <ApiKeyStep apiKey={apiKey} saving={saving} onApiKeyChange={setApiKey} onSave={saveApiKey} onSkip={next} />
        )}
        {step === "done" && (clerkEnabled ? <DoneStepClerk onFinish={finish} /> : <DoneStepLocal onFinish={finish} />)}
      </div>
    </div>
  );
}

const card: React.CSSProperties = { background: "#18181B", border: "1px solid #27272A", borderRadius: "16px" };
const btnPrimary: React.CSSProperties = { background: "#6366F1", color: "#fff", border: "none", borderRadius: "12px", padding: "12px 20px", fontSize: "14px", fontWeight: 600, cursor: "pointer", width: "100%", transition: "opacity 150ms" };
const btnSecondary: React.CSSProperties = { background: "#18181B", color: "#A1A1AA", border: "1px solid #27272A", borderRadius: "12px", padding: "12px 20px", fontSize: "14px", fontWeight: 500, cursor: "pointer", flex: 1, transition: "opacity 150ms" };

function WelcomeStep({ managedInfo, onNext }: { managedInfo: { daily_limit: number; managed_mode: boolean } | null; onNext: () => void }) {
  return (
    <div className="flex flex-col items-center gap-6 w-full max-w-[280px]">
      <div style={{ fontSize: "56px", lineHeight: 1 }}>🦆</div>
      <div>
        <h1 style={{ fontSize: "22px", fontWeight: 700, margin: "0 0 8px", color: "#F4F4F5" }}>Welcome to DuckAI</h1>
        <p style={{ fontSize: "13px", color: "#71717A", lineHeight: 1.6, margin: 0 }}>
          Your always-on AI side panel. It reads your screen and helps you work faster — no copy-pasting.
        </p>
      </div>
      {managedInfo?.managed_mode && (
        <div style={{ ...card, padding: "12px 16px", textAlign: "left", width: "100%" }}>
          <p style={{ margin: 0, fontSize: "12px", color: "#818CF8" }}>
            <strong>Free tier active</strong> · {managedInfo.daily_limit} AI messages/day included.
          </p>
        </div>
      )}
      <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "8px" }}>
        {["Context-aware chat", "Web search & templates", "Slack, GitHub & Calendar", "Your data stays local"].map((f) => (
          <div key={f} style={{ display: "flex", alignItems: "center", gap: "10px", fontSize: "13px", color: "#A1A1AA" }}>
            <span style={{ color: "#34D399", fontSize: "12px" }}>✓</span>
            {f}
          </div>
        ))}
      </div>
      <button style={btnPrimary} onClick={onNext}>Get started →</button>
    </div>
  );
}

function PermissionStep({ icon, title, description, status, detail, grantLabel, onGrant, onRecheck, onSkip, onNext, optional }: {
  icon: string; title: string; description: string;
  status: "unknown" | "granted" | "denied";
  detail?: string;
  grantLabel: string; onGrant: () => void; onRecheck: () => void; onSkip: () => void; onNext: () => void; optional?: boolean;
}) {
  const granted = status === "granted";
  return (
    <div className="flex flex-col items-center gap-5 w-full max-w-[280px]">
      <div style={{ fontSize: "48px", lineHeight: 1 }}>{icon}</div>
      <div>
        <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 8px", color: "#F4F4F5" }}>{title}</h2>
        <p style={{ fontSize: "13px", color: "#71717A", lineHeight: 1.6, margin: 0 }}>{description}</p>
      </div>
      {granted ? (
        <div style={{ ...card, padding: "10px 16px", width: "100%", display: "flex", alignItems: "center", gap: "8px", justifyContent: "center" }}>
          <span style={{ color: "#34D399", fontWeight: 600 }}>✓ Permission granted</span>
        </div>
      ) : (
        <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "8px" }}>
          {detail && (
            <p style={{ fontSize: "11px", color: "#A1A1AA", lineHeight: 1.5, margin: 0, textAlign: "left" }}>{detail}</p>
          )}
          <button style={btnPrimary} onClick={onGrant}>{grantLabel}</button>
          <button style={{ ...btnSecondary, width: "100%", fontSize: "12px" }} onClick={onRecheck}>
            I've granted it — check again
          </button>
        </div>
      )}
      <div style={{ display: "flex", gap: "10px", width: "100%" }}>
        {optional && <button style={btnSecondary} onClick={onSkip}>Skip</button>}
        <button
          style={{ ...btnPrimary, flex: 1, opacity: (status === "denied" && !optional) ? 0.35 : 1, cursor: (status === "denied" && !optional) ? "not-allowed" : "pointer" }}
          disabled={status === "denied" && !optional}
          onClick={onNext}
        >
          Continue
        </button>
      </div>
    </div>
  );
}

function ApiKeyStep({ apiKey, saving, onApiKeyChange, onSave, onSkip }: {
  apiKey: string; saving: boolean;
  onApiKeyChange: (v: string) => void;
  onSave: () => void; onSkip: () => void;
}) {
  const inputStyle: React.CSSProperties = { ...card, borderRadius: "10px", padding: "10px 12px", fontSize: "13px", color: "#F4F4F5", width: "100%", outline: "none", fontFamily: "inherit", background: "#111113" };
  return (
    <div className="flex flex-col items-center gap-5 w-full max-w-[280px]">
      <div style={{ fontSize: "48px", lineHeight: 1 }}>🔑</div>
      <div>
        <h2 style={{ fontSize: "20px", fontWeight: 700, margin: "0 0 8px", color: "#F4F4F5" }}>HuggingFace Token (optional)</h2>
        <p style={{ fontSize: "13px", color: "#71717A", lineHeight: 1.6, margin: 0 }}>
          Free plan uses HF → NVIDIA → Groq. Add <code style={{ fontSize: "11px" }}>HF_TOKEN</code> in backend <code style={{ fontSize: "11px" }}>.env</code> or paste here.
        </p>
      </div>
      <input type="password" value={apiKey} onChange={(e) => onApiKeyChange(e.target.value)} placeholder="hf_..." style={inputStyle} />
      <div style={{ display: "flex", gap: "10px", width: "100%" }}>
        <button style={btnSecondary} onClick={onSkip}>Skip</button>
        <button style={{ ...btnPrimary, flex: 1, opacity: saving ? 0.5 : 1 }} onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : apiKey.trim() ? "Save & continue" : "Continue"}
        </button>
      </div>
    </div>
  );
}

function DoneStepLocal({ onFinish }: { onFinish: () => void }) {
  return (
    <div className="flex flex-col items-center gap-5 w-full max-w-[280px]">
      <div style={{ fontSize: "56px", lineHeight: 1 }}>🎉</div>
      <div>
        <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "0 0 8px", color: "#F4F4F5" }}>You're all set!</h2>
        <p style={{ fontSize: "13px", color: "#71717A", lineHeight: 1.6, margin: 0 }}>
          Press <strong style={{ color: "#F4F4F5" }}>⌘⇧A</strong> anytime to show DuckAI. Collapse the panel to refresh screen context.
        </p>
      </div>
      <div style={{ ...card, padding: "12px 16px", width: "100%", fontSize: "12px", color: "#818CF8" }}>
        Local mode · all data stays on this device
      </div>
      <button style={btnPrimary} onClick={onFinish}>Open DuckAI →</button>
    </div>
  );
}

function DoneStepClerk({ onFinish }: { onFinish: () => void }) {
  const { isSignedIn, user } = useUser();
  return (
    <div className="flex flex-col items-center gap-5 w-full max-w-[280px]">
      <div style={{ fontSize: "56px", lineHeight: 1 }}>🎉</div>
      <div>
        <h2 style={{ fontSize: "22px", fontWeight: 700, margin: "0 0 8px", color: "#F4F4F5" }}>You're all set!</h2>
        <p style={{ fontSize: "13px", color: "#71717A", lineHeight: 1.6, margin: 0 }}>
          Press <strong style={{ color: "#F4F4F5" }}>⌘⇧A</strong> anytime to show DuckAI. Collapse the panel to refresh screen context.
        </p>
      </div>
      <div style={{ ...card, padding: "12px 16px", width: "100%", fontSize: "12px", color: isSignedIn ? "#34D399" : "#818CF8" }}>
        {isSignedIn
          ? <span>✓ Signed in as <strong>{user?.primaryEmailAddress?.emailAddress}</strong></span>
          : <span>Local mode · Sign in from Settings to enable cloud sync</span>}
      </div>
      <button style={btnPrimary} onClick={onFinish}>Open DuckAI →</button>
    </div>
  );
}
