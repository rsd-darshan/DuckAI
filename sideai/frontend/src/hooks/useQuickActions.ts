import { useCallback, useState } from "react";

const STORAGE_KEY = "sideai_quick_actions";
const ACTIVE_PACK_KEY = "sideai_active_pack";

export interface QuickAction {
  label: string;
  prompt: string;
}

export type QuickPackId = "coding" | "student" | "sales" | "support" | "social" | "custom";

export const QUICK_ACTION_PACKS: Record<Exclude<QuickPackId, "custom">, QuickAction[]> = {
  coding: [
    { label: "Find bug", prompt: "Find likely bugs in what is on my screen and propose fixes." },
    { label: "Refactor", prompt: "Refactor this code into a cleaner version with reasons." },
    { label: "Explain code", prompt: "Explain this code in simple terms." },
  ],
  student: [
    { label: "Study summary", prompt: "Turn this into concise study notes." },
    { label: "Quiz me", prompt: "Create 5 quiz questions from this content." },
    { label: "Teach simply", prompt: "Explain this topic like I am a beginner." },
  ],
  sales: [
    { label: "Follow-up", prompt: "Draft a concise, warm follow-up message." },
    { label: "Value props", prompt: "Extract key value points and objections from this." },
    { label: "Next steps", prompt: "Write a clear next-steps message." },
  ],
  support: [
    { label: "Empathetic reply", prompt: "Draft an empathetic support response." },
    { label: "Troubleshoot", prompt: "List troubleshooting steps from this issue." },
    { label: "Escalation note", prompt: "Draft an internal escalation summary." },
  ],
  social: [
    { label: "Short reply", prompt: "Write a short and friendly reply for this message." },
    { label: "Engaging post", prompt: "Rewrite this into an engaging social post." },
    { label: "Polish tone", prompt: "Make this sound natural and confident." },
  ],
};

const DEFAULT_ACTIONS: QuickAction[] = [
  { label: "Summarize", prompt: "Summarize what's on my screen." },
  { label: "Explain", prompt: "Explain what I'm looking at." },
  { label: "Help", prompt: "I'm stuck. Can you help?" },
];

function loadStored(): QuickAction[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as QuickAction[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (_) {}
  return DEFAULT_ACTIONS;
}

function loadPack(): QuickPackId {
  try {
    const raw = localStorage.getItem(ACTIVE_PACK_KEY) as QuickPackId | null;
    if (raw && (raw in QUICK_ACTION_PACKS || raw === "custom")) return raw;
  } catch (_) {}
  return "custom";
}

export function useQuickActions() {
  const [actions, setActions] = useState<QuickAction[]>(loadStored);
  const [activePack, setActivePack] = useState<QuickPackId>(loadPack);

  const save = useCallback((next: QuickAction[]) => {
    setActions(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (_) {}
  }, []);

  const reset = useCallback(() => save([...DEFAULT_ACTIONS]), [save]);

  const setPack = useCallback((pack: QuickPackId) => {
    setActivePack(pack);
    try {
      localStorage.setItem(ACTIVE_PACK_KEY, pack);
    } catch (_) {}
  }, []);

  const visibleActions = activePack === "custom" ? actions : QUICK_ACTION_PACKS[activePack];

  return { actions, save, reset, activePack, setPack, visibleActions };
}
