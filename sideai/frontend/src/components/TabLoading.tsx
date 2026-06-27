/** Consistent skeleton while lazy tab chunks load. */
export function TabLoading({ title }: { title: string }) {
  return (
    <div className="flex-1 min-h-0 flex flex-col" aria-busy="true" aria-label={`Loading ${title}`}>
      <div className="shrink-0 px-3 py-2.5 border-b border-panel-border bg-panel-bg-elevated/60 backdrop-blur-sm">
        <div className="h-4 w-24 rounded-md bg-panel-border/80 motion-safe:animate-pulse" />
      </div>
      <div className="flex-1 min-h-0 p-4 space-y-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="rounded-xl border border-panel-border bg-panel-surface/60 p-4 space-y-2 motion-safe:animate-pulse"
            style={{ animationDelay: `${i * 100}ms` }}
          >
            <div className="h-3 w-1/3 rounded bg-panel-border/90" />
            <div className="h-3 w-full rounded bg-panel-border/70" />
            <div className="h-3 w-5/6 rounded bg-panel-border/60" />
          </div>
        ))}
      </div>
    </div>
  );
}
