import { useState } from "react";
import type { TemplateItem } from "../hooks/useBackend";

interface TemplateLibraryProps {
  items: TemplateItem[];
  onRunTemplate: (prompt: string) => void;
  onCreateTemplate: (name: string, prompt: string) => Promise<void> | void;
  onDeleteTemplate: (templateId: string) => Promise<void> | void;
  onImportTemplates: (items: Array<Partial<TemplateItem>>) => Promise<void> | void;
}

export function TemplateLibrary({
  items,
  onRunTemplate,
  onCreateTemplate,
  onDeleteTemplate,
  onImportTemplates,
}: TemplateLibraryProps) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);

  const runTemplateWithInputs = (template: TemplateItem) => {
    let output = template.prompt || "";
    const schema = template.input_schema || [];
    for (const field of schema) {
      const key = String(field.name || "").trim();
      if (!key) continue;
      const userValue = window.prompt(`Input: ${key}`, String(field.default ?? "")) ?? "";
      output = output.split(`{{${key}}}`).join(userValue);
    }
    onRunTemplate(output);
  };

  return (
    <section className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 p-3 border-b border-panel-border bg-panel-bg-elevated space-y-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Template name"
          className="w-full rounded-lg border border-panel-border bg-panel-surface px-2.5 py-2 text-xs text-[color:var(--panel-text)] placeholder-panel-muted"
        />
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Template prompt"
          rows={2}
          className="w-full rounded-lg border border-panel-border bg-panel-surface px-2.5 py-2 text-xs text-[color:var(--panel-text)] placeholder-panel-muted"
        />
        <button
          type="button"
          onClick={async () => {
            if (!name.trim() || !prompt.trim()) return;
            setError(null);
            await onCreateTemplate(name.trim(), prompt.trim());
            setName("");
            setPrompt("");
          }}
          className="text-xs rounded-md border border-panel-accent/60 px-2.5 py-1.5 text-panel-accent hover:bg-panel-accent/10"
        >
          Save template
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              const blob = new Blob([JSON.stringify(items, null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "sideai_templates.json";
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="text-[10px] rounded-md border border-panel-border px-2 py-1 text-panel-muted hover:text-slate-200"
          >
            Export JSON
          </button>
          <label className="text-[10px] rounded-md border border-panel-border px-2 py-1 text-panel-muted hover:text-slate-200 cursor-pointer">
            Import JSON
            <input
              type="file"
              accept="application/json"
              className="hidden"
              onChange={async (e) => {
                setError(null);
                try {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const text = await file.text();
                  const parsed = JSON.parse(text);
                  if (!Array.isArray(parsed)) throw new Error("File must contain a JSON array of templates");
                  // Basic validation: every entry needs at least a name and prompt
                  const invalid = parsed.filter((t) => !t?.name?.trim() || !t?.prompt?.trim());
                  if (invalid.length > 0) throw new Error(`${invalid.length} entries are missing name or prompt`);
                  // Warn about duplicates that already exist
                  const existingNames = new Set(items.map((t) => t.name.trim().toLowerCase()));
                  const dupes = parsed.filter((t) => existingNames.has(String(t.name || "").trim().toLowerCase()));
                  if (dupes.length > 0) {
                    const ok = window.confirm(
                      `${dupes.length} template(s) already exist with the same name and will be imported as duplicates. Continue?`
                    );
                    if (!ok) return;
                  }
                  await onImportTemplates(parsed);
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Import failed");
                } finally {
                  e.currentTarget.value = "";
                }
              }}
            />
          </label>
        </div>
        {error && <p className="text-[11px] text-red-300">{error}</p>}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
        {items.length === 0 && <p className="text-[11px] text-panel-muted p-2">No templates yet.</p>}
        {items.map((t) => (
          <div key={t.id} className="w-full text-left rounded-lg border border-panel-border bg-panel-surface p-2">
            <button type="button" onClick={() => runTemplateWithInputs(t)} className="w-full text-left">
              <p className="text-xs font-medium text-[color:var(--panel-text)]">{t.name}</p>
              <p className="text-[11px] text-panel-muted">{t.prompt.slice(0, 140)}</p>
            </button>
            {!t.is_built_in && (
              <button
                type="button"
                onClick={() => onDeleteTemplate(t.id)}
                className="mt-2 text-[10px] rounded border border-panel-border px-2 py-1 text-panel-muted hover:text-slate-200"
              >
                Delete
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
