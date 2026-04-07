import { useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, CalendarRange, FileText, FolderOpenDot, UploadCloud, X } from 'lucide-react'
import { toast } from 'sonner'
import { caseAPI } from '../components/lib/apis'
import { MultiStepLoader } from '@/components/ui/aceternity/multi-step-loader'
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
import { Textarea } from '@/components/ui/textarea'
import { ingestCaseUploads, type CaseUploadFailure, type CaseUploadSlotKey } from '../lib/caseFileIngestion'

const loadingStates = [
  { text: 'Initializing Workspace...' },
  { text: 'Securing Credentials...' },
  { text: 'Linking Operator Configs...' },
  { text: 'Minting Case ID...' },
  { text: 'Finalizing...' },
]

const OPERATORS = ['Jio', 'Airtel', 'Vi (Vodafone Idea)', 'BSNL', 'MTNL', 'Other']
const CASE_TYPES = ['Cyber Crime', 'Financial Fraud', 'Drug Trafficking', 'Missing Person', 'Terrorism', 'Other']

interface UploadSlot {
  key: CaseUploadSlotKey
  label: string
  icon: string
  desc: string
  color: string
  files: File[]
}

const INITIAL_UPLOADS: UploadSlot[] = [
  { key: 'cdr', label: 'Upload CDR', icon: '📞', desc: 'Call Detail Records', color: 'from-blue-500 to-blue-600', files: [] },
  { key: 'sdr', label: 'Upload SDR', icon: '👤', desc: 'Subscriber Detail Records', color: 'from-emerald-500 to-emerald-600', files: [] },
  { key: 'ipdr', label: 'Upload IPDR', icon: '🌐', desc: 'IP Detail Records', color: 'from-violet-500 to-violet-600', files: [] },
  { key: 'tower', label: 'Upload Tower Dump', icon: '📡', desc: 'Tower Dump Data', color: 'from-amber-500 to-amber-600', files: [] },
  { key: 'ild', label: 'Upload ILD', icon: '🌍', desc: 'International Long Distance', color: 'from-rose-500 to-rose-600', files: [] },
]

function generateCaseNumber(caseName: string): string {
  if (!caseName.trim()) return ''
  const prefix = caseName
    .split(' ')
    .map((word) => word[0]?.toUpperCase())
    .filter(Boolean)
    .join('')
    .slice(0, 3)
  const year = new Date().getFullYear()
  const random = String(Math.floor(Math.random() * 9999)).padStart(4, '0')
  return `${prefix || 'CAS'}-${year}-${random}`
}

export default function CreateCasePage() {
  const navigate = useNavigate()

  const [caseName, setCaseName] = useState('')
  const [caseNumber, setCaseNumber] = useState('')
  const [operator, setOperator] = useState('')
  const [caseType, setCaseType] = useState('')
  const [priority, setPriority] = useState('medium')
  const [firNumber, setFirNumber] = useState('')
  const [investigationDetails, setInvestigationDetails] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [uploads, setUploads] = useState<UploadSlot[]>(INITIAL_UPLOADS.map((upload) => ({ ...upload, files: [] })))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [uploadProgress, setUploadProgress] = useState<Record<string, string>>({})

  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  const handleNameChange = useCallback((value: string) => {
    setCaseName(value)
    if (value.trim().length >= 2) {
      setCaseNumber(generateCaseNumber(value))
    } else {
      setCaseNumber('')
    }
  }, [])

  const handleFileSelect = (key: string, newFiles: FileList | null) => {
    if (!newFiles || newFiles.length === 0) return
    setUploads((prev) =>
      prev.map((upload) =>
        upload.key === key
          ? { ...upload, files: [...upload.files, ...Array.from(newFiles)] }
          : upload
      )
    )
  }

  const removeFile = (key: string, fileIndex: number) => {
    setUploads((prev) =>
      prev.map((upload) =>
        upload.key === key
          ? { ...upload, files: upload.files.filter((_, index) => index !== fileIndex) }
          : upload
      )
    )
  }

  const handleDrop = (key: string, event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    handleFileSelect(key, event.dataTransfer.files)
  }

  const getTotalFileCount = () => uploads.reduce((sum, upload) => sum + upload.files.length, 0)

  const uploadFilesToCase = async (caseId: number): Promise<CaseUploadFailure[]> =>
    ingestCaseUploads({
      caseId,
      operator,
      uploads,
      onProgress: (slotKey, message) => {
        setUploadProgress((prev) => ({ ...prev, [slotKey]: message }))
      },
    })

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()

    if (!caseName.trim()) {
      setError('Case name is required')
      return
    }

    setLoading(true)
    setError('')
    setUploadProgress({})

    try {
      const newCase = await caseAPI.create({
        caseName,
        caseNumber: caseNumber || undefined,
        operator,
        caseType,
        priority,
        firNumber,
        investigationDetails,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      })
      const caseId = newCase.id || newCase.case?.id

      let uploadFailures: CaseUploadFailure[] = []
      if (getTotalFileCount() > 0 && caseId) {
        uploadFailures = await uploadFilesToCase(caseId)
        uploadFailures.forEach((failure) => {
          console.error(`Upload error for ${failure.fileName}:`, failure.message)
          toast.error(failure.message)
        })
      }

      if (uploadFailures.length > 0) {
        toast.warning(`Case created with ${uploadFailures.length} upload issue${uploadFailures.length > 1 ? 's' : ''}. Review the upload messages.`)
      } else {
        toast.success('Case created successfully')
      }
      navigate(`/case/${caseId}`)
    } catch (submitError: any) {
      const message = submitError.message || 'Failed to create case'
      setError(message)
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <MultiStepLoader loadingStates={loadingStates} loading={loading} duration={1000} />

      <div className="mx-auto max-w-6xl space-y-6 py-6">
        <div className="flex items-center justify-between gap-4">
          <Button type="button" variant="ghost" className="rounded-2xl px-0 text-base" onClick={() => navigate('/dashboard')}>
            ← Back to Dashboard
          </Button>
          <Badge className="rounded-full border border-shakti-300/25 bg-shakti-50 text-shakti-700 dark:border-shakti-400/20 dark:bg-shakti-500/10 dark:text-shakti-200">
            Unified intake
          </Badge>
        </div>

        <Card className="overflow-hidden rounded-[2rem] border-border/70 shadow-[0_24px_70px_rgba(10,19,51,0.12)]">
          <CardHeader className="border-b border-border/70 bg-gradient-to-r from-shakti-500/5 via-blue-500/5 to-transparent pb-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-3">
                <Badge className="w-fit rounded-full border border-shakti-300/25 bg-shakti-50 text-shakti-700 dark:border-shakti-400/20 dark:bg-shakti-500/10 dark:text-shakti-200">
                  Case Intake
                </Badge>
                <div className="flex items-start gap-4">
                  <div className="flex h-14 w-14 items-center justify-center rounded-[1.25rem] bg-gradient-to-br from-shakti-500 to-blue-500 text-white shadow-lg shadow-shakti-600/20">
                    <FolderOpenDot className="h-7 w-7" />
                  </div>
                  <div>
                    <CardTitle className="text-3xl tracking-tight">Create New Case</CardTitle>
                    <CardDescription className="mt-2 max-w-2xl text-base leading-7">
                      Register a new investigation workspace, capture key metadata, and ingest telecom datasets so analytics are ready as soon as the case opens.
                    </CardDescription>
                  </div>
                </div>
              </div>

              <div className="grid gap-3 rounded-[1.5rem] border border-border/70 bg-background/70 p-4 text-sm sm:min-w-[240px]">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Selected uploads</span>
                  <Badge variant="secondary" className="rounded-full">{getTotalFileCount()}</Badge>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Priority</span>
                  <Badge className="rounded-full capitalize">{priority}</Badge>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Operator</span>
                  <span className="font-medium">{operator || 'Not set'}</span>
                </div>
              </div>
            </div>
          </CardHeader>

          <CardContent className="p-6 sm:p-8">
            <form onSubmit={handleSubmit} className="space-y-8">
              {error ? (
                <Alert variant="destructive" className="rounded-[1.25rem]">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Unable to create case</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}

              <section className="grid gap-4 lg:grid-cols-3">
                <Card className="rounded-[1.5rem] border-border/70 lg:col-span-2">
                  <CardHeader className="pb-4">
                    <CardTitle className="text-xl">Case Details</CardTitle>
                    <CardDescription>Core metadata used by the existing case creation workflow.</CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-5">
                    <div className="grid gap-5 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="case-name">Case Name</Label>
                        <Input
                          id="case-name"
                          value={caseName}
                          onChange={(event) => handleNameChange(event.target.value)}
                          placeholder="e.g. Mumbai Cyber Fraud 2026"
                          className="h-11 rounded-xl"
                          required
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="case-number">Case Number</Label>
                        <Input
                          id="case-number"
                          value={caseNumber}
                          readOnly
                          placeholder="Auto-generated from case name"
                          className="h-11 rounded-xl bg-muted/60 text-muted-foreground"
                        />
                      </div>
                    </div>

                    <div className="grid gap-5 sm:grid-cols-3">
                      <div className="space-y-2">
                        <Label htmlFor="operator-select">Telecom Operator</Label>
                        <Select value={operator} onValueChange={setOperator}>
                          <SelectTrigger id="operator-select" className="h-11 w-full rounded-xl">
                            <SelectValue placeholder="Select operator" />
                          </SelectTrigger>
                          <SelectContent>
                            {OPERATORS.map((item) => (
                              <SelectItem key={item} value={item}>{item}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="case-type-select">Case Type</Label>
                        <Select value={caseType} onValueChange={setCaseType}>
                          <SelectTrigger id="case-type-select" className="h-11 w-full rounded-xl">
                            <SelectValue placeholder="Select type" />
                          </SelectTrigger>
                          <SelectContent>
                            {CASE_TYPES.map((item) => (
                              <SelectItem key={item} value={item}>{item}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="priority-select">Priority</Label>
                        <Select value={priority} onValueChange={setPriority}>
                          <SelectTrigger id="priority-select" className="h-11 w-full rounded-xl">
                            <SelectValue placeholder="Select priority" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="low">Low</SelectItem>
                            <SelectItem value="medium">Medium</SelectItem>
                            <SelectItem value="high">High</SelectItem>
                            <SelectItem value="critical">Critical</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="fir-number">FIR Number</Label>
                      <Input
                        id="fir-number"
                        value={firNumber}
                        onChange={(event) => setFirNumber(event.target.value)}
                        placeholder="e.g. FIR/2026/0042"
                        className="h-11 rounded-xl"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="investigation-details">Investigation Details</Label>
                      <Textarea
                        id="investigation-details"
                        value={investigationDetails}
                        onChange={(event) => setInvestigationDetails(event.target.value)}
                        placeholder="Describe the investigation context, suspects, objectives, and notes..."
                        className="min-h-32 rounded-[1.25rem]"
                      />
                    </div>
                  </CardContent>
                </Card>

                <Card className="rounded-[1.5rem] border-border/70">
                  <CardHeader className="pb-4">
                    <CardTitle className="text-xl">Date Filters</CardTitle>
                    <CardDescription>Optional telecom record filtering window.</CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-5">
                    <div className="space-y-2">
                      <Label htmlFor="start-date">Start Date</Label>
                      <div className="relative">
                        <CalendarRange className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          id="start-date"
                          type="date"
                          value={startDate}
                          onChange={(event) => setStartDate(event.target.value)}
                          className="h-11 rounded-xl pl-10"
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="end-date">End Date</Label>
                      <div className="relative">
                        <CalendarRange className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          id="end-date"
                          type="date"
                          value={endDate}
                          onChange={(event) => setEndDate(event.target.value)}
                          className="h-11 rounded-xl pl-10"
                        />
                      </div>
                    </div>

                    <div className="rounded-[1.25rem] border border-border/70 bg-muted/40 p-4 text-sm text-muted-foreground">
                      These dates travel with the case metadata and help frame the telecom review window for investigators.
                    </div>
                  </CardContent>
                </Card>
              </section>

              <section className="space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-xl font-semibold tracking-tight">Upload Telecom Data</h2>
                    <p className="text-sm text-muted-foreground">
                      Optional. You can still create the case now and upload files later from the case workspace.
                    </p>
                  </div>
                  <Badge variant="secondary" className="w-fit rounded-full">
                    {getTotalFileCount() > 0 ? `${getTotalFileCount()} selected` : 'No files selected'}
                  </Badge>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  {uploads.map((slot) => (
                    <Card
                      key={slot.key}
                      className="group cursor-pointer rounded-[1.5rem] border-border/70 transition-all hover:-translate-y-0.5 hover:shadow-card-hover"
                      onDragOver={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                      }}
                      onDrop={(event) => handleDrop(slot.key, event)}
                      onClick={() => fileInputRefs.current[slot.key]?.click()}
                    >
                      <CardContent className="p-5">
                        <div className="flex items-start gap-4">
                          <div className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-[1.25rem] bg-gradient-to-br ${slot.color} text-2xl text-white shadow-lg`}>
                            {slot.icon}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <h3 className="text-base font-semibold">{slot.label}</h3>
                                <p className="mt-1 text-sm text-muted-foreground">
                                  {slot.desc} • CSV, XLSX, XLS
                                </p>
                              </div>
                              <Badge variant="outline" className="rounded-full">
                                {slot.files.length}
                              </Badge>
                            </div>

                            <div className="mt-4 rounded-[1.25rem] border border-dashed border-border/80 bg-muted/30 px-4 py-5 text-sm text-muted-foreground">
                              <div className="flex items-center gap-3">
                                <UploadCloud className="h-4 w-4 text-shakti-600 dark:text-shakti-300" />
                                Drag and drop files here or click to browse.
                              </div>
                            </div>

                            {slot.files.length > 0 ? (
                              <div className="mt-4 flex flex-wrap gap-2">
                                {slot.files.map((file, index) => (
                                  <span
                                    key={`${slot.key}-${file.name}-${index}`}
                                    className="inline-flex items-center gap-2 rounded-full border border-shakti-300/25 bg-shakti-50 px-3 py-1 text-xs text-shakti-700 dark:border-shakti-400/20 dark:bg-shakti-500/10 dark:text-shakti-200"
                                  >
                                    <FileText className="h-3.5 w-3.5" />
                                    <span className="max-w-[180px] truncate">{file.name}</span>
                                    <button
                                      type="button"
                                      onClick={(event) => {
                                        event.stopPropagation()
                                        removeFile(slot.key, index)
                                      }}
                                      className="rounded-full text-shakti-700/70 transition hover:text-red-500 dark:text-shakti-200/70"
                                      aria-label={`Remove ${file.name}`}
                                    >
                                      <X className="h-3.5 w-3.5" />
                                    </button>
                                  </span>
                                ))}
                              </div>
                            ) : null}

                            {uploadProgress[slot.key] ? (
                              <p className="mt-3 text-xs font-medium text-shakti-600 dark:text-shakti-300">
                                {uploadProgress[slot.key]}
                              </p>
                            ) : null}
                          </div>
                        </div>

                        <input
                          type="file"
                          ref={(element) => {
                            fileInputRefs.current[slot.key] = element
                          }}
                          className="hidden"
                          accept=".csv,.xlsx,.xls"
                          multiple
                          onChange={(event) => {
                            handleFileSelect(slot.key, event.target.files)
                            event.target.value = ''
                          }}
                        />
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </section>

              <div className="flex flex-col gap-3 border-t border-border/70 pt-6 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-muted-foreground">
                  Uploaded files are classified, normalized, and inserted into the analytics tables during case creation.
                </p>
                <div className="flex items-center gap-3">
                  <Button type="button" variant="outline" className="rounded-2xl" onClick={() => navigate('/dashboard')} disabled={loading}>
                    Cancel
                  </Button>
                  <Button type="submit" className="rounded-2xl px-6" disabled={loading}>
                    {loading
                      ? (getTotalFileCount() > 0 ? 'Creating Case & Uploading...' : 'Creating Case...')
                      : (getTotalFileCount() > 0 ? `Create Case & Upload ${getTotalFileCount()} File${getTotalFileCount() > 1 ? 's' : ''}` : 'Create Case')}
                  </Button>
                </div>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </>
  )
}
