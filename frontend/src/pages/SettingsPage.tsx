import React, { useEffect, useState } from 'react'
import { ArchiveRestore, FolderArchive, Plus, Save, Settings2, ShieldCheck, SlidersHorizontal, Trash2, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { caseAPI, settingsAPI } from '../components/lib/apis'
import SystemDiagnosticsPanel from '../components/settings/SystemDiagnosticsPanel'
import type { CustomOSINTProviderConfig } from '../lib/osintApi'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

interface Config {
  parsing: {
    separator: 'auto' | ',' | ';' | '\t' | '|'
    badLines: 'skip' | 'warn' | 'error'
    dateFormat: 'auto' | 'DD/MM/YYYY' | 'YYYY-MM-DD'
  }
  persistence: {
    insertToDB: boolean
  }
  privacy: {
    maskNumbers: boolean
    maskIMSI: boolean
    maskIMEI: boolean
  }
  charts: {
    showTimeline: boolean
    showTopCallers: boolean
    showHeatmap: boolean
    showNetworkGraph: boolean
  }
  operator: 'VODAFONE' | 'JIO' | 'AIRTEL' | 'BSNL'
  osint: {
    providers: CustomOSINTProviderConfig[]
  }
}

interface ArchivedCase {
  id: number
  case_name: string
  case_number: string
  operator?: string | null
  priority?: string | null
  updated_at?: string | null
  is_evidence_locked?: boolean | null
  canArchive?: boolean
  canDelete?: boolean
}

const createProvider = (): CustomOSINTProviderConfig => ({
  id: `osint_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  name: '',
  apiUrl: '',
  token: '',
  enabled: true,
  method: 'GET',
  queryParam: 'query',
  tokenHeader: 'Authorization',
  tokenPrefix: 'Bearer',
})

const defaultConfig: Config = {
  parsing: { separator: 'auto', badLines: 'skip', dateFormat: 'auto' },
  persistence: { insertToDB: true },
  privacy: { maskNumbers: false, maskIMSI: false, maskIMEI: false },
  charts: { showTimeline: true, showTopCallers: true, showHeatmap: true, showNetworkGraph: true },
  operator: 'VODAFONE',
  osint: { providers: [] },
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {})
const asBoolean = (value: unknown, fallback: boolean) => typeof value === 'boolean' ? value : fallback
const asString = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback

const normalizeProvider = (value: unknown): CustomOSINTProviderConfig | null => {
  const row = asRecord(value)
  const name = asString(row.name).trim()
  const apiUrl = asString(row.apiUrl).trim()
  const id = asString(row.id).trim() || `osint_${Math.random().toString(36).slice(2, 10)}`

  if (!name && !apiUrl) return null

  return {
    id,
    name,
    apiUrl,
    token: asString(row.token),
    enabled: asBoolean(row.enabled, true),
    method: asString(row.method, 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET',
    queryParam: asString(row.queryParam, 'query'),
    tokenHeader: asString(row.tokenHeader, 'Authorization'),
    tokenPrefix: typeof row.tokenPrefix === 'string' ? row.tokenPrefix : 'Bearer',
  }
}

const normalizeConfig = (loaded: Record<string, unknown>): Config => {
  const parsing = asRecord(loaded.parsing)
  const persistence = asRecord(loaded.persistence)
  const privacy = asRecord(loaded.privacy)
  const charts = asRecord(loaded.charts)
  const osint = asRecord(loaded.osint)
  const providerRows = Array.isArray(osint.providers) ? osint.providers : []

  return {
    parsing: {
      separator: (['auto', ',', ';', '\t', '|'] as const).includes(parsing.separator as Config['parsing']['separator'])
        ? (parsing.separator as Config['parsing']['separator'])
        : defaultConfig.parsing.separator,
      badLines: (['skip', 'warn', 'error'] as const).includes(parsing.badLines as Config['parsing']['badLines'])
        ? (parsing.badLines as Config['parsing']['badLines'])
        : defaultConfig.parsing.badLines,
      dateFormat: (['auto', 'DD/MM/YYYY', 'YYYY-MM-DD'] as const).includes(parsing.dateFormat as Config['parsing']['dateFormat'])
        ? (parsing.dateFormat as Config['parsing']['dateFormat'])
        : defaultConfig.parsing.dateFormat,
    },
    persistence: {
      insertToDB: asBoolean(persistence.insertToDB, defaultConfig.persistence.insertToDB),
    },
    privacy: {
      maskNumbers: asBoolean(privacy.maskNumbers, defaultConfig.privacy.maskNumbers),
      maskIMSI: asBoolean(privacy.maskIMSI, defaultConfig.privacy.maskIMSI),
      maskIMEI: asBoolean(privacy.maskIMEI, defaultConfig.privacy.maskIMEI),
    },
    charts: {
      showTimeline: asBoolean(charts.showTimeline, defaultConfig.charts.showTimeline),
      showTopCallers: asBoolean(charts.showTopCallers, defaultConfig.charts.showTopCallers),
      showHeatmap: asBoolean(charts.showHeatmap, defaultConfig.charts.showHeatmap),
      showNetworkGraph: asBoolean(charts.showNetworkGraph, defaultConfig.charts.showNetworkGraph),
    },
    operator: (['VODAFONE', 'JIO', 'AIRTEL', 'BSNL'] as const).includes(loaded.operator as Config['operator'])
      ? (loaded.operator as Config['operator'])
      : defaultConfig.operator,
    osint: {
      providers: providerRows.map(normalizeProvider).filter((provider): provider is CustomOSINTProviderConfig => Boolean(provider)),
    },
  }
}

function SettingSwitch({
  id,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-[1.25rem] border border-border/70 bg-card/60 p-4">
      <div className="space-y-1">
        <Label htmlFor={id} className="text-sm font-medium">{label}</Label>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

export const Settings: React.FC = () => {
  const [config, setConfig] = useState<Config>(defaultConfig)
  const [status, setStatus] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [archivedCases, setArchivedCases] = useState<ArchivedCase[]>([])
  const [archiveLoading, setArchiveLoading] = useState(true)
  const [archiveAction, setArchiveAction] = useState<{ caseId: number | null; type: 'reopen' | 'delete' | null }>({
    caseId: null,
    type: null,
  })

  useEffect(() => {
    ;(async () => {
      try {
        const loaded = await settingsAPI.get()
        setConfig(normalizeConfig(loaded))
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        setStatus(`Failed to load settings: ${message}`)
      }
    })()

    void loadArchivedCases()
  }, [])

  const loadArchivedCases = async () => {
    try {
      setArchiveLoading(true)
      const response = await caseAPI.list({ status: 'archived', limit: 100 })
      setArchivedCases(response.items || [])
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(`Failed to load archived cases: ${message}`)
      setArchivedCases([])
    } finally {
      setArchiveLoading(false)
    }
  }

  const save = async () => {
    try {
      setSaving(true)
      setStatus('Saving...')
      await settingsAPI.save(config as unknown as Record<string, unknown>)
      setStatus('Settings saved successfully')
      toast.success('Settings saved successfully')
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      const fullMessage = `Error saving settings: ${message}`
      setStatus(fullMessage)
      toast.error(fullMessage)
    } finally {
      setSaving(false)
    }
  }

  const setValue = (path: string, value: unknown) => {
    setConfig((prev) => {
      const copy: Config = { ...prev }
      const parts = path.split('.')
      let current: Record<string, unknown> = copy as unknown as Record<string, unknown>
      for (let index = 0; index < parts.length - 1; index += 1) {
        const key = parts[index]
        const existing = current[key]
        current[key] = typeof existing === 'object' && existing !== null ? { ...(existing as Record<string, unknown>) } : {}
        current = current[key] as Record<string, unknown>
      }
      current[parts[parts.length - 1]] = value
      return copy
    })
  }

  const updateProvider = (id: string, patch: Partial<CustomOSINTProviderConfig>) => {
    setConfig((prev) => ({
      ...prev,
      osint: {
        providers: prev.osint.providers.map((provider) => provider.id === id ? { ...provider, ...patch } : provider),
      },
    }))
  }

  const addProvider = () => {
    setConfig((prev) => ({
      ...prev,
      osint: {
        providers: [...prev.osint.providers, createProvider()],
      },
    }))
  }

  const removeProvider = (id: string) => {
    setConfig((prev) => ({
      ...prev,
      osint: {
        providers: prev.osint.providers.filter((provider) => provider.id !== id),
      },
    }))
  }

  const handleReopenCase = async (archivedCase: ArchivedCase) => {
    if (!archivedCase.canArchive || archivedCase.is_evidence_locked) return

    const confirmed = window.confirm(`Open ${archivedCase.case_name} again and move it back into active cases?`)
    if (!confirmed) return

    try {
      setArchiveAction({ caseId: archivedCase.id, type: 'reopen' })
      await caseAPI.reopen(String(archivedCase.id))
      toast.success(`${archivedCase.case_name} is active again.`)
      await loadArchivedCases()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(message)
    } finally {
      setArchiveAction({ caseId: null, type: null })
    }
  }

  const handleDeleteArchivedCase = async (archivedCase: ArchivedCase) => {
    if (!archivedCase.canDelete || archivedCase.is_evidence_locked) return

    const confirmed = window.confirm(`Delete ${archivedCase.case_name} permanently from archive?`)
    if (!confirmed) return

    try {
      setArchiveAction({ caseId: archivedCase.id, type: 'delete' })
      await caseAPI.remove(String(archivedCase.id))
      toast.success(`${archivedCase.case_name} was deleted from archive.`)
      await loadArchivedCases()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(message)
    } finally {
      setArchiveAction({ caseId: null, type: null })
    }
  }

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden rounded-[2rem] border-border/70 shadow-[0_24px_70px_rgba(10,19,51,0.12)]">
        <CardHeader className="border-b border-border/70 bg-transparent pb-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-3">
              <Badge className="w-fit rounded-full border border-shakti-300/25 bg-shakti-50 text-shakti-700 dark:border-shakti-400/20 dark:bg-shakti-500/10 dark:text-shakti-200">
                Settings Console
              </Badge>
              <div className="flex items-start gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-[1.25rem] bg-gradient-to-br from-shakti-500 to-blue-500 text-white shadow-lg shadow-shakti-600/20">
                  <Settings2 className="h-7 w-7" />
                </div>
                <div>
                  <CardTitle className="text-3xl tracking-tight">CDR Analysis Settings</CardTitle>
                  <CardDescription className="mt-2 max-w-3xl text-base leading-7">
                    Tune parsing, privacy, OSINT providers, chart defaults, and diagnostics without changing backend configuration contracts.
                  </CardDescription>
                </div>
              </div>
            </div>

            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
              <Badge variant="secondary" className="rounded-full">{status || 'Ready'}</Badge>
              <Button type="button" onClick={save} disabled={saving} className="rounded-2xl">
                <Save className="h-4 w-4" />
                {saving ? 'Saving...' : 'Save Settings'}
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-6 p-6 sm:p-8">
          {status.startsWith('Failed') || status.startsWith('Error') ? (
            <Alert variant="destructive" className="rounded-[1.25rem]">
              <AlertTitle>Settings warning</AlertTitle>
              <AlertDescription>{status}</AlertDescription>
            </Alert>
          ) : null}

          <SystemDiagnosticsPanel />

          <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
            <Card className="rounded-[1.5rem] border-border/70">
              <CardHeader className="pb-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-shakti-500/10 text-shakti-700 dark:text-shakti-300">
                    <SlidersHorizontal className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-xl">Core Configuration</CardTitle>
                    <CardDescription>Shared defaults that drive parsing, persistence, privacy, and chart presentation.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Accordion type="multiple" defaultValue={['parsing', 'privacy', 'charts', 'defaults']} className="w-full">
                  <AccordionItem value="parsing" className="border-border/70">
                    <AccordionTrigger className="py-4 text-base font-semibold">Parsing</AccordionTrigger>
                    <AccordionContent className="space-y-4 pt-2">
                      <div className="grid gap-4 md:grid-cols-3">
                        <div className="space-y-2">
                          <Label>Separator</Label>
                          <Select value={config.parsing.separator} onValueChange={(value: Config['parsing']['separator']) => setValue('parsing.separator', value)}>
                            <SelectTrigger className="h-11 w-full rounded-xl">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="auto">Auto-Detect</SelectItem>
                              <SelectItem value=",">Comma ,</SelectItem>
                              <SelectItem value=";">Semicolon ;</SelectItem>
                              <SelectItem value="\t">Tab</SelectItem>
                              <SelectItem value="|">Pipe |</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2">
                          <Label>Bad Lines</Label>
                          <Select value={config.parsing.badLines} onValueChange={(value: Config['parsing']['badLines']) => setValue('parsing.badLines', value)}>
                            <SelectTrigger className="h-11 w-full rounded-xl">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="skip">Skip</SelectItem>
                              <SelectItem value="warn">Warn</SelectItem>
                              <SelectItem value="error">Error</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2">
                          <Label>Date Format</Label>
                          <Select value={config.parsing.dateFormat} onValueChange={(value: Config['parsing']['dateFormat']) => setValue('parsing.dateFormat', value)}>
                            <SelectTrigger className="h-11 w-full rounded-xl">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="auto">Auto</SelectItem>
                              <SelectItem value="DD/MM/YYYY">DD/MM/YYYY</SelectItem>
                              <SelectItem value="YYYY-MM-DD">YYYY-MM-DD</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="persistence" className="border-border/70">
                    <AccordionTrigger className="py-4 text-base font-semibold">Persistence</AccordionTrigger>
                    <AccordionContent className="pt-2">
                      <SettingSwitch
                        id="insert-to-db"
                        label="Insert parsed records into database"
                        description="Keeps the current ingestion behavior but makes the toggle easier to understand and safer to review."
                        checked={config.persistence.insertToDB}
                        onCheckedChange={(checked) => setValue('persistence.insertToDB', checked)}
                      />
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="privacy" className="border-border/70">
                    <AccordionTrigger className="py-4 text-base font-semibold">Privacy</AccordionTrigger>
                    <AccordionContent className="space-y-4 pt-2">
                      <SettingSwitch
                        id="mask-numbers"
                        label="Mask phone numbers"
                        description="Reduce exposure of full phone numbers in rendered analysis views."
                        checked={config.privacy.maskNumbers}
                        onCheckedChange={(checked) => setValue('privacy.maskNumbers', checked)}
                      />
                      <SettingSwitch
                        id="mask-imsi"
                        label="Mask IMSI"
                        description="Hide sensitive subscriber identity values in the UI where possible."
                        checked={config.privacy.maskIMSI}
                        onCheckedChange={(checked) => setValue('privacy.maskIMSI', checked)}
                      />
                      <SettingSwitch
                        id="mask-imei"
                        label="Mask IMEI"
                        description="Reduce exposure of device identifiers in reports and visualizations."
                        checked={config.privacy.maskIMEI}
                        onCheckedChange={(checked) => setValue('privacy.maskIMEI', checked)}
                      />
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="charts" className="border-border/70">
                    <AccordionTrigger className="py-4 text-base font-semibold">Charts</AccordionTrigger>
                    <AccordionContent className="space-y-4 pt-2">
                      <SettingSwitch
                        id="show-timeline"
                        label="Timeline charts"
                        description="Enable timeline visual summaries across analysis modules."
                        checked={config.charts.showTimeline}
                        onCheckedChange={(checked) => setValue('charts.showTimeline', checked)}
                      />
                      <SettingSwitch
                        id="show-top-callers"
                        label="Top callers"
                        description="Show caller concentration summaries in supported analytics views."
                        checked={config.charts.showTopCallers}
                        onCheckedChange={(checked) => setValue('charts.showTopCallers', checked)}
                      />
                      <SettingSwitch
                        id="show-heatmap"
                        label="Heatmap"
                        description="Enable geographic and density-style hotspot visualizations."
                        checked={config.charts.showHeatmap}
                        onCheckedChange={(checked) => setValue('charts.showHeatmap', checked)}
                      />
                      <SettingSwitch
                        id="show-network-graph"
                        label="Network graph"
                        description="Allow network relationship graph modules to render by default."
                        checked={config.charts.showNetworkGraph}
                        onCheckedChange={(checked) => setValue('charts.showNetworkGraph', checked)}
                      />
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="defaults" className="border-border/70">
                    <AccordionTrigger className="py-4 text-base font-semibold">Defaults</AccordionTrigger>
                    <AccordionContent className="pt-2">
                      <div className="space-y-2">
                        <Label>Default Operator</Label>
                        <Select value={config.operator} onValueChange={(value: Config['operator']) => setValue('operator', value)}>
                          <SelectTrigger className="h-11 w-full rounded-xl">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="VODAFONE">Vodafone Idea</SelectItem>
                            <SelectItem value="JIO">Reliance Jio</SelectItem>
                            <SelectItem value="AIRTEL">Bharti Airtel</SelectItem>
                            <SelectItem value="BSNL">BSNL</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </CardContent>
            </Card>

            <Card className="rounded-[1.5rem] border-border/70">
              <CardHeader className="pb-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
                    <ShieldCheck className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-xl">OSINT Providers</CardTitle>
                    <CardDescription>Custom read-only lookup providers surfaced as tabs in the OSINT tools area.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Badge variant="secondary" className="rounded-full">
                    {config.osint.providers.length} configured
                  </Badge>
                  <Button type="button" variant="outline" className="rounded-2xl" onClick={addProvider}>
                    <Plus className="h-4 w-4" />
                    Add Provider
                  </Button>
                </div>

                {config.osint.providers.length === 0 ? (
                  <Alert className="rounded-[1.25rem]">
                    <Wrench className="h-4 w-4" />
                    <AlertTitle>No custom providers yet</AlertTitle>
                    <AlertDescription>
                      Add an OSINT provider here to expose it as a new frontend tab without changing the backend route structure.
                    </AlertDescription>
                  </Alert>
                ) : null}

                <div className="space-y-4">
                  {config.osint.providers.map((provider, index) => (
                    <Card key={provider.id} className="rounded-[1.25rem] border-border/70 bg-card/60">
                      <CardContent className="space-y-4 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold">Provider #{index + 1}</div>
                            <div className="text-xs text-muted-foreground">{provider.name || 'Unnamed provider'}</div>
                          </div>
                          <Button type="button" variant="ghost" className="rounded-xl text-red-600 dark:text-red-400" onClick={() => removeProvider(provider.id)}>
                            <Trash2 className="h-4 w-4" />
                            Remove
                          </Button>
                        </div>

                        <div className="grid gap-4">
                          <div className="space-y-2">
                            <Label>Tab Name</Label>
                            <Input
                              value={provider.name || ''}
                              onChange={(event) => updateProvider(provider.id, { name: event.target.value })}
                              placeholder="e.g. VirusTotal Custom"
                              className="h-11 rounded-xl"
                            />
                          </div>

                          <div className="space-y-2">
                            <Label>API URL</Label>
                            <Input
                              type="url"
                              value={provider.apiUrl || ''}
                              onChange={(event) => updateProvider(provider.id, { apiUrl: event.target.value })}
                              placeholder="https://api.example.com/search"
                              className="h-11 rounded-xl"
                            />
                          </div>

                          <div className="space-y-2">
                            <Label>API Token</Label>
                            <Input
                              value={provider.token || ''}
                              onChange={(event) => updateProvider(provider.id, { token: event.target.value })}
                              placeholder="Token / API key"
                              className="h-11 rounded-xl"
                            />
                          </div>

                          <div className="grid gap-4 md:grid-cols-2">
                            <div className="space-y-2">
                              <Label>Method</Label>
                              <Select value={provider.method || 'GET'} onValueChange={(value: string) => updateProvider(provider.id, { method: value === 'POST' ? 'POST' : 'GET' })}>
                                <SelectTrigger className="h-11 w-full rounded-xl">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="GET">GET</SelectItem>
                                  <SelectItem value="POST">POST</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>

                            <div className="space-y-2">
                              <Label>Query Param</Label>
                              <Input
                                value={provider.queryParam || 'query'}
                                onChange={(event) => updateProvider(provider.id, { queryParam: event.target.value })}
                                placeholder="query"
                                className="h-11 rounded-xl"
                              />
                            </div>
                          </div>

                          <div className="grid gap-4 md:grid-cols-2">
                            <div className="space-y-2">
                              <Label>Token Header</Label>
                              <Input
                                value={provider.tokenHeader || 'Authorization'}
                                onChange={(event) => updateProvider(provider.id, { tokenHeader: event.target.value })}
                                placeholder="Authorization"
                                className="h-11 rounded-xl"
                              />
                            </div>

                            <div className="space-y-2">
                              <Label>Token Prefix</Label>
                              <Input
                                value={provider.tokenPrefix ?? 'Bearer'}
                                onChange={(event) => updateProvider(provider.id, { tokenPrefix: event.target.value })}
                                placeholder="Bearer"
                                className="h-11 rounded-xl"
                              />
                            </div>
                          </div>

                          <SettingSwitch
                            id={`provider-enabled-${provider.id}`}
                            label="Provider enabled"
                            description="Enabled providers appear in the OSINT screen."
                            checked={provider.enabled !== false}
                            onCheckedChange={(checked) => updateProvider(provider.id, { enabled: checked })}
                          />
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card className="rounded-[1.5rem] border-border/70">
            <CardHeader className="pb-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-700 dark:text-amber-300">
                  <FolderArchive className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle className="text-xl">Archived Cases</CardTitle>
                  <CardDescription>Review archived cases here and either open them again or delete them permanently.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {archiveLoading ? (
                <div className="rounded-[1.25rem] border border-border/70 bg-card/60 px-4 py-6 text-sm text-muted-foreground">
                  Loading archived cases...
                </div>
              ) : archivedCases.length === 0 ? (
                <Alert className="rounded-[1.25rem]">
                  <FolderArchive className="h-4 w-4" />
                  <AlertTitle>No archived cases</AlertTitle>
                  <AlertDescription>
                    Archived cases will appear here once a case is closed and moved to archive.
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="space-y-3">
                  {archivedCases.map((archivedCase) => (
                    <Card key={archivedCase.id} className="rounded-[1.25rem] border-border/70 bg-card/60">
                      <CardContent className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between">
                        <div className="space-y-1">
                          <div className="text-base font-semibold">{archivedCase.case_name}</div>
                          <div className="text-sm text-muted-foreground">
                            {archivedCase.case_number}
                            {archivedCase.operator ? ` • ${archivedCase.operator}` : ''}
                            {archivedCase.updated_at ? ` • Updated ${new Date(archivedCase.updated_at).toLocaleDateString()}` : ''}
                          </div>
                          <div className="flex flex-wrap gap-2 pt-1">
                            <Badge className="status-archived rounded-full">archived</Badge>
                            <Badge variant="secondary" className="rounded-full capitalize">{archivedCase.priority || 'normal'}</Badge>
                            {archivedCase.is_evidence_locked ? <Badge className="status-locked rounded-full">Evidence Locked</Badge> : null}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-3">
                          {archivedCase.canArchive ? (
                            <Button
                              type="button"
                              variant="outline"
                              className="rounded-2xl border-emerald-300/60 bg-emerald-50/80 text-emerald-700 hover:bg-emerald-100/90 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200 dark:hover:bg-emerald-500/20"
                              onClick={() => void handleReopenCase(archivedCase)}
                              disabled={archiveAction.caseId === archivedCase.id || Boolean(archivedCase.is_evidence_locked)}
                              title={archivedCase.is_evidence_locked ? 'Evidence lock prevents opening this case again.' : 'Move this case back to active cases'}
                            >
                              <ArchiveRestore className="h-4 w-4" />
                              {archiveAction.caseId === archivedCase.id && archiveAction.type === 'reopen' ? 'Opening...' : 'Open Again'}
                            </Button>
                          ) : null}

                          {archivedCase.canDelete ? (
                            <Button
                              type="button"
                              variant="outline"
                              className="rounded-2xl border-red-300/60 bg-red-50/80 text-red-700 hover:bg-red-100/90 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200 dark:hover:bg-red-500/20"
                              onClick={() => void handleDeleteArchivedCase(archivedCase)}
                              disabled={archiveAction.caseId === archivedCase.id || Boolean(archivedCase.is_evidence_locked)}
                              title={archivedCase.is_evidence_locked ? 'Evidence lock prevents deleting this case.' : 'Delete this archived case permanently'}
                            >
                              <Trash2 className="h-4 w-4" />
                              {archiveAction.caseId === archivedCase.id && archiveAction.type === 'delete' ? 'Deleting...' : 'Delete'}
                            </Button>
                          ) : null}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </CardContent>
      </Card>
    </div>
  )
}
