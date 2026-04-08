import { ShieldCheck, Users, Lock, Database } from 'lucide-react'

const cards = [
  {
    title: 'Admin auth boundary',
    description: 'Separate admin JWTs, refresh cookies, and route guards are in place for the `/admin` workspace.',
    icon: ShieldCheck,
  },
  {
    title: 'Dedicated identity model',
    description: 'IT accounts are isolated from officer accounts so the console can evolve without buckle-ID coupling.',
    icon: Users,
  },
  {
    title: 'Protected entry only',
    description: 'Only authenticated admin sessions can access the console shell. Officer sessions are explicitly blocked.',
    icon: Lock,
  },
  {
    title: 'Ready for later phases',
    description: 'Overview, activity, database, and system modules are scaffolded and can be connected next.',
    icon: Database,
  },
]

export default function AdminOverviewPage() {
  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[2rem] border border-border/70 bg-card p-6 shadow-[0_24px_70px_rgba(10,19,51,0.08)]">
        <div className="max-w-3xl space-y-3">
          <div className="inline-flex rounded-full border border-slate-300/50 bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
            Phase 1 Ready
          </div>
          <h2 className="text-3xl font-semibold tracking-tight">Admin shell foundation is now isolated from the officer app.</h2>
          <p className="text-base leading-7 text-muted-foreground">
            This phase establishes the secure entry point, dedicated admin session model, and the `/admin` workspace skeleton. Later phases will attach real observability data to these modules.
          </p>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {cards.map(({ title, description, icon: Icon }) => (
          <article key={title} className="rounded-[1.5rem] border border-border/70 bg-card p-5">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-900 text-white dark:bg-white dark:text-slate-900">
              <Icon className="h-5 w-5" />
            </div>
            <h3 className="mt-4 text-lg font-semibold">{title}</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
          </article>
        ))}
      </section>
    </div>
  )
}
