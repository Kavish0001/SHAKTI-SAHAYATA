type AdminPlaceholderPageProps = {
  title: string
  description: string
}

export default function AdminPlaceholderPage({ title, description }: AdminPlaceholderPageProps) {
  return (
    <div className="rounded-[2rem] border border-dashed border-border/70 bg-card/60 p-8 shadow-sm">
      <div className="max-w-2xl space-y-3">
        <div className="inline-flex rounded-full border border-blue-300/30 bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-blue-700 dark:border-blue-400/20 dark:bg-blue-500/10 dark:text-blue-300">
          Phase 1 Placeholder
        </div>
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        <p className="text-base leading-7 text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
