import React, { useState, useCallback } from 'react'
import {
  fetchIPDetails,
  fetchPhoneDetails,
  fetchDomainDetails,
  checkBreach,
  crawlUrls,
  type OSINTApiResult,
  type CrawlResult,
} from '../../lib/osintApi'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

type TabId = 'phone' | 'ip' | 'social' | 'domain' | 'crawler'

interface TabDef {
  id: TabId
  label: string
  icon: string
  placeholder: string
}

const TABS: TabDef[] = [
  { id: 'phone', label: 'Phone Lookup', icon: 'phone_in_talk', placeholder: '+91XXXXXXXXXX or 10-digit number' },
  { id: 'ip', label: 'IP Lookup', icon: 'public', placeholder: 'e.g. 8.8.8.8 or 2001:4860:4860::8888' },
  { id: 'social', label: 'Breach Check', icon: 'security', placeholder: 'Email or phone number' },
  { id: 'domain', label: 'Domain Whois', icon: 'dns', placeholder: 'e.g. google.com' },
  { id: 'crawler', label: 'URL Crawler', icon: 'travel_explore', placeholder: 'https://example.com (one per line, max 5)' },
]

const DataRow: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="grid gap-2 rounded-[1rem] border border-border/70 bg-card/60 px-4 py-3 sm:grid-cols-[180px_1fr] sm:items-start">
    <span className="text-sm font-medium capitalize text-muted-foreground">{label}</span>
    <span className="text-sm font-semibold break-words">{String(value ?? '—')}</span>
  </div>
)

const renderObjectData = (data: Record<string, unknown>, prefix = '') => {
  return Object.entries(data).map(([key, value]) => {
    if (value === null || value === undefined) return null
    if (typeof value === 'object' && !Array.isArray(value)) return null
    const displayKey = prefix ? `${prefix}.${key}` : key
    return <DataRow key={displayKey} label={displayKey.replace(/_/g, ' ')} value={String(value)} />
  })
}

export const OSINTTools: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabId>('phone')
  const [query, setQuery] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [result, setResult] = useState<OSINTApiResult | null>(null)
  const [crawlResults, setCrawlResults] = useState<CrawlResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const currentTab = TABS.find((tab) => tab.id === activeTab)!

  const handleTabChange = useCallback((tabId: TabId) => {
    setActiveTab(tabId)
    setQuery('')
    setResult(null)
    setCrawlResults([])
    setError(null)
  }, [])

  const handleSearch = useCallback(async () => {
    const trimmed = query.trim()
    if (!trimmed) return

    setIsLoading(true)
    setResult(null)
    setCrawlResults([])
    setError(null)

    try {
      switch (activeTab) {
        case 'phone':
          setResult(await fetchPhoneDetails(trimmed))
          break
        case 'ip':
          setResult(await fetchIPDetails(trimmed))
          break
        case 'social':
          setResult(await checkBreach(trimmed))
          break
        case 'domain':
          setResult(await fetchDomainDetails(trimmed))
          break
        case 'crawler':
          setCrawlResults(await crawlUrls(trimmed.split('\n').map((url) => url.trim()).filter(Boolean)))
          break
      }
    } catch (lookupError) {
      setError((lookupError as Error).message || 'Lookup failed')
    } finally {
      setIsLoading(false)
    }
  }, [query, activeTab])

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey && activeTab !== 'crawler') {
      event.preventDefault()
      handleSearch()
    }
  }, [handleSearch, activeTab])

  const renderResults = () => {
    if (error) {
      return (
        <Alert variant="destructive" className="rounded-[1.25rem]">
          <span className="material-symbols-outlined">error</span>
          <AlertTitle>Lookup failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )
    }

    if (activeTab === 'crawler' && crawlResults.length > 0) {
      return (
        <div className="grid gap-4">
          {crawlResults.map((crawlResult, index) => (
            <Card key={`crawl-${index}`} className="rounded-[1.5rem] border-border/70">
              <CardContent className="space-y-4 p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <a href={crawlResult.url} target="_blank" rel="noopener noreferrer" className="truncate text-sm font-semibold text-shakti-700 hover:underline dark:text-shakti-300">
                      {crawlResult.url}
                    </a>
                    <p className="mt-1 text-base font-medium">{crawlResult.title || 'No title available'}</p>
                  </div>
                  <Badge className={crawlResult.status === 'ok' ? 'rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-300' : 'rounded-full bg-red-500/10 text-red-600 dark:text-red-300'}>
                    {crawlResult.status === 'ok' ? 'Crawled' : 'Failed'}
                  </Badge>
                </div>
                <p className="text-sm leading-7 text-muted-foreground">{crawlResult.snippet || 'No snippet available.'}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )
    }

    if (!result) {
      return (
        <Card className="rounded-[1.5rem] border-border/70 border-dashed">
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            Run a lookup to view results here. Existing OSINT request behavior remains unchanged.
          </CardContent>
        </Card>
      )
    }

    if (!result.success) {
      return (
        <Alert variant="destructive" className="rounded-[1.25rem]">
          <span className="material-symbols-outlined">warning</span>
          <AlertTitle>Source returned an error</AlertTitle>
          <AlertDescription>{result.error || 'Lookup failed'}</AlertDescription>
        </Alert>
      )
    }

    const data = result.data as Record<string, unknown>
    if (!data) return null

    return (
      <Card className="rounded-[1.5rem] border-border/70">
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-xl">Results from {result.source}</CardTitle>
              <CardDescription>Structured data rendered in the refreshed frontend shell.</CardDescription>
            </div>
            <Badge variant="secondary" className="rounded-full">{currentTab.label}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {activeTab === 'social' && data.breaches ? (
            <>
              <DataRow label="Breaches Found" value={String(data.breach_count ?? 0)} />
              {Array.isArray(data.breaches) && (data.breaches as Array<{ name: string; date: string; count: number; description: string }>).map((breach, index) => (
                <Card key={`breach-${index}`} className="rounded-[1.25rem] border-red-500/20 bg-red-500/5">
                  <CardContent className="space-y-2 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="text-sm font-semibold text-red-700 dark:text-red-300">{breach.name}</div>
                      <Badge className="rounded-full bg-red-500/10 text-red-600 dark:text-red-300">{breach.count?.toLocaleString()} records</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">Date: {breach.date}</p>
                    <p className="text-sm leading-7 text-muted-foreground">{breach.description}</p>
                  </CardContent>
                </Card>
              ))}
            </>
          ) : activeTab === 'domain' ? (
            <>
              <DataRow label="Handle" value={data.handle as string} />
              <DataRow label="Registrar" value={data.registrar as string} />
              <DataRow label="Status" value={data.status as string} />
              <DataRow label="Events" value={data.events as string} />
            </>
          ) : (
            renderObjectData(data)
          )}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden rounded-[2rem] border-border/70 shadow-[0_24px_70px_rgba(10,19,51,0.12)]">
        <CardHeader className="border-b border-border/70 bg-transparent pb-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-3">
              <Badge className="w-fit rounded-full border border-shakti-300/25 bg-shakti-50 text-shakti-700 dark:border-shakti-400/20 dark:bg-shakti-500/10 dark:text-shakti-200">
                OSINT Investigation Tools
              </Badge>
              <div>
                <CardTitle className="text-3xl tracking-tight">Open-source intelligence workspace</CardTitle>
                <CardDescription className="mt-2 max-w-3xl text-base leading-7">
                  On-premise lookup tools for phone, IP, breach, domain, and URL intelligence. This refresh updates only the visual layer and state handling.
                </CardDescription>
              </div>
            </div>
            <Badge variant="secondary" className="rounded-full">Zero cloud egress</Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-6 p-6 sm:p-8">
          <div className="flex flex-wrap gap-2">
            {TABS.map((tab) => (
              <Button
                key={tab.id}
                type="button"
                variant={activeTab === tab.id ? 'default' : 'outline'}
                className={cn(
                  'rounded-2xl',
                  activeTab === tab.id && 'bg-shakti-600 text-white hover:bg-shakti-700'
                )}
                onClick={() => handleTabChange(tab.id)}
              >
                <span className="material-symbols-outlined text-base">{tab.icon}</span>
                {tab.label}
              </Button>
            ))}
          </div>

          <Card className="rounded-[1.5rem] border-border/70">
            <CardContent className="space-y-4 p-5">
              {activeTab === 'crawler' ? (
                <Textarea
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={currentTab.placeholder}
                  className="min-h-28 rounded-[1.25rem]"
                  disabled={isLoading}
                />
              ) : (
                <Input
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={currentTab.placeholder}
                  className="h-12 rounded-[1.25rem]"
                  disabled={isLoading}
                />
              )}

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  {activeTab === 'crawler'
                    ? 'Enter one URL per line. The existing crawl logic and limits are unchanged.'
                    : 'Press Enter to run the lookup, or use the search button.'}
                </p>
                <Button type="button" onClick={handleSearch} disabled={isLoading || !query.trim()} className="rounded-2xl">
                  <span className="material-symbols-outlined text-base">{isLoading ? 'hourglass_top' : 'search'}</span>
                  {isLoading ? 'Searching...' : 'Search'}
                </Button>
              </div>
            </CardContent>
          </Card>

          <ScrollArea className="max-h-[720px] rounded-[1.5rem]">
            <div className="space-y-4 pr-4">
              {renderResults()}
            </div>
          </ScrollArea>

          <Alert className="rounded-[1.25rem]">
            <span className="material-symbols-outlined">info</span>
            <AlertTitle>Operational note</AlertTitle>
            <AlertDescription>
              All lookups are performed on-premise. Phone validation and breach checks may use simulated data in this environment.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  )
}

export default OSINTTools
