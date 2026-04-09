import { useState, useEffect, lazy, Suspense, useMemo, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { caseAPI, fileAPI, recordCountAPI } from '../components/lib/apis';
import { ingestCaseUploads, type CaseUploadSlotKey } from '../lib/caseFileIngestion';
import { useCaseContextStore } from '../stores/caseContextStore';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const DATA_TYPES = [
  { key: 'cdr', label: 'CDR', icon: '📞', desc: 'Call Detail Records' },
  { key: 'ipdr', label: 'IPDR', icon: '🌐', desc: 'IP Detail Records' },
  { key: 'sdr', label: 'SDR', icon: '👤', desc: 'Subscriber Detail Records' },
  { key: 'tower', label: 'Tower Dump', icon: '📡', desc: 'Tower Dump Records' },
  { key: 'ild', label: 'ILD', icon: '🌍', desc: 'International Long Distance' },
];

const tiltCardClass =
  'transition-[transform,box-shadow,border-color] duration-200 ease-out hover:-translate-y-1 hover:shadow-[0_18px_38px_rgba(10,19,51,0.14)]';

const tiltShellClass =
  'transition-shadow duration-200 ease-out hover:shadow-[0_16px_34px_rgba(10,19,51,0.10)]';

const timelineCardClass =
  'transition-[border-color,box-shadow,background-color] duration-200 ease-out hover:border-slate-300/80 hover:shadow-md dark:hover:border-slate-700/80';

const CDRAdvancedAnalysis = lazy(() => import('../components/analysis/CDRAdvancedAnalysis').then(m => ({ default: m.AdvancedAnalytics })));
// IPDRAnalytics already has a default export
const IPDRAnalytics = lazy(() => import('../components/analysis/IPDRAnalytics'));
const SDRSearch = lazy(() => import('../components/analysis/SDRSearch').then(m => ({ default: m.SDRSearch })));
const TowerDumpAnalysis = lazy(() => import('../components/analysis/TowerDumpAnalysis').then(m => ({ default: m.TowerDumpAnalysis })));
const ILDAnalysis = lazy(() => import('../components/analysis/ILDAnalysis').then(m => ({ default: m.ILDAnalysis })));

interface CaseData {
  id: number;
  case_name: string;
  case_number: string;
  case_type: string;
  fir_number: string;
  status: string;
  priority: string;
  operator: string;
  investigation_details: string;
  start_date: string;
  end_date: string;
  is_evidence_locked: boolean;
  file_count: number;
  created_at: string;
  created_by_name: string;
  canArchive?: boolean;
  canDelete?: boolean;
}

interface TimelineEvent {
  source: string;
  event_time: string | null;
  title: string;
  details: Record<string, unknown>;
}

const DATA_TYPE_FILE_ALIASES: Record<string, string[]> = {
  cdr: ['cdr'],
  ipdr: ['ipdr'],
  sdr: ['sdr'],
  tower: ['tower', 'tower_dump', 'tower dump'],
  ild: ['ild'],
};

const FILE_TAB_ORDER = ['cdr', 'ipdr', 'sdr', 'tower', 'ild'] as const;
type FileTabKey = (typeof FILE_TAB_ORDER)[number];

const FILE_TAB_LABELS: Record<FileTabKey, string> = {
  cdr: 'CDR',
  ipdr: 'IPDR',
  sdr: 'SDR',
  tower: 'Tower Dump',
  ild: 'ILD',
};

const EMPTY_FILE_ACTION_STATE = {
  uploadingTab: null as FileTabKey | null,
  deletingFileId: null as number | null,
};

const normalizeFileType = (file: any): FileTabKey | null => {
  const rawType = `${file?.detected_type || file?.expected_type || file?.file_type || ''}`.trim().toLowerCase();
  if (!rawType) return null;
  if (DATA_TYPE_FILE_ALIASES.tower.includes(rawType)) return 'tower';
  if (FILE_TAB_ORDER.includes(rawType as FileTabKey)) return rawType as FileTabKey;
  return null;
};

const getDefaultFileTab = (files: any[]): FileTabKey => {
  const counts = FILE_TAB_ORDER.reduce<Record<FileTabKey, number>>((acc, key) => {
    acc[key] = 0;
    return acc;
  }, { cdr: 0, ipdr: 0, sdr: 0, tower: 0, ild: 0 });

  files.forEach((file) => {
    const normalized = normalizeFileType(file);
    if (normalized) counts[normalized] += 1;
  });

  return FILE_TAB_ORDER.find((key) => counts[key] > 0) || 'cdr';
};

export default function CaseView() {
  const { id, dataType } = useParams();
  const navigate = useNavigate();
  const [caseData, setCaseData] = useState<CaseData | null>(null);
  const [files, setFiles] = useState<any[]>([]);
  const [recordCounts, setRecordCounts] = useState<Record<string, number>>({});
  const [activeTab, setActiveTab] = useState('overview');
  const [selectedFileTab, setSelectedFileTab] = useState<FileTabKey | null>(null);
  const [loading, setLoading] = useState(true);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [{ uploadingTab, deletingFileId }, setFileActionState] = useState(EMPTY_FILE_ACTION_STATE);
  const [fileActionMessage, setFileActionMessage] = useState('');
  const [caseActionState, setCaseActionState] = useState<'archive' | 'delete' | null>(null);
  const setActiveCase = useCaseContextStore((state) => state.setActiveCase);
  const fileInputRefs = useRef<Record<FileTabKey, HTMLInputElement | null>>({
    cdr: null,
    ipdr: null,
    sdr: null,
    tower: null,
    ild: null,
  });

  useEffect(() => {
    void loadCase();
    void loadFiles();
    void loadRecordCounts();
  }, [id]);

  // If a dataType is present in the URL, switch to Data tab
  useEffect(() => {
    if (dataType) {
      setActiveTab('data');
    }
  }, [dataType]);

  useEffect(() => {
    if (!caseData) return;
    setActiveCase({
      id: String(caseData.id),
      caseName: caseData.case_name,
      caseNumber: caseData.case_number,
      firNumber: caseData.fir_number,
      caseType: caseData.case_type,
      operator: caseData.operator,
      status: caseData.status,
      createdAt: caseData.created_at,
      hasFiles: Number(caseData.file_count || 0) > 0,
      locked: true
    });
  }, [caseData, setActiveCase]);

  useEffect(() => {
    if (activeTab !== 'timeline' || !id) return;
    let cancelled = false;

    const loadTimeline = async () => {
      try {
        setTimelineLoading(true);
        const data = await caseAPI.getTimeline(String(id));
        if (!cancelled) {
          setTimeline(Array.isArray(data?.events) ? data.events : []);
        }
      } catch (error) {
        console.error(error);
        if (!cancelled) {
          setTimeline([]);
        }
      } finally {
        if (!cancelled) {
          setTimelineLoading(false);
        }
      }
    };

    void loadTimeline();
    return () => {
      cancelled = true;
    };
  }, [activeTab, id]);

  const loadCase = async () => {
    try {
      if (!id) return;
      const data = await caseAPI.get(String(id));
      setCaseData(data);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  const loadFiles = async () => {
    try {
      if (!id) return;
      const rows = await fileAPI.listByCase(String(id));
      setFiles(rows);
    } catch (err) { console.error(err); }
  };

  const loadRecordCounts = async () => {
    const counts: Record<string, number> = {};
    for (const dt of DATA_TYPES) {
      try {
        if (!id) continue;
        counts[dt.key] = await recordCountAPI.getCountByCase(
          dt.key as 'cdr' | 'ipdr' | 'sdr' | 'tower' | 'ild',
          String(id)
        );
      } catch { counts[dt.key] = 0; }
    }
    setRecordCounts(counts);
  };

  const refreshCaseWorkspace = async () => {
    await Promise.all([loadCase(), loadFiles(), loadRecordCounts()]);
  };

  const getPriorityClass = (p: string) => {
    const map: Record<string, string> = { critical: 'priority-critical', high: 'priority-high', medium: 'priority-medium', low: 'priority-low' };
    return map[p] || '';
  };

  const getStatusClass = (s: string) => {
    const map: Record<string, string> = { open: 'status-open', active: 'status-active', closed: 'status-closed', archived: 'status-archived', locked: 'status-locked' };
    return map[s] || '';
  };

  const getModuleFileCount = (moduleKey: string) => {
    const aliases = DATA_TYPE_FILE_ALIASES[moduleKey] || [moduleKey];
    return files.filter((file) => {
      const rawType = `${file?.detected_type || file?.expected_type || file?.file_type || ''}`.trim().toLowerCase();
      return aliases.includes(rawType);
    }).length;
  };

  const filesByType = useMemo(() => {
    return FILE_TAB_ORDER.reduce<Record<FileTabKey, any[]>>((acc, key) => {
      acc[key] = files.filter((file) => normalizeFileType(file) === key);
      return acc;
    }, { cdr: [], ipdr: [], sdr: [], tower: [], ild: [] });
  }, [files]);

  useEffect(() => {
    if (selectedFileTab) return;
    if (loading) return;
    setSelectedFileTab(getDefaultFileTab(files));
  }, [files, loading, selectedFileTab]);

  const activeFiles = selectedFileTab ? filesByType[selectedFileTab] : [];

  const handleUploadIntoFileTab = async (tabKey: FileTabKey, selectedFiles: FileList | null) => {
    if (!caseData || !selectedFiles || selectedFiles.length === 0) return;

    const incomingFiles = Array.from(selectedFiles);
    setFileActionState({ uploadingTab: tabKey, deletingFileId: null });
    setFileActionMessage(`Preparing ${incomingFiles.length} ${FILE_TAB_LABELS[tabKey]} file${incomingFiles.length > 1 ? 's' : ''}...`);

    try {
      const failures = await ingestCaseUploads({
        caseId: caseData.id,
        operator: caseData.operator || '',
        uploads: [
          {
            key: tabKey as CaseUploadSlotKey,
            label: FILE_TAB_LABELS[tabKey],
            files: incomingFiles,
          },
        ],
        onProgress: (_slotKey, message) => {
          setFileActionMessage(message);
        },
      });

      await refreshCaseWorkspace();
      setSelectedFileTab(tabKey);

      if (failures.length > 0) {
        failures.forEach((failure) => toast.error(failure.message));
        toast.warning(`${failures.length} ${FILE_TAB_LABELS[tabKey]} upload issue${failures.length > 1 ? 's' : ''} need review.`);
        setFileActionMessage(`Completed with ${failures.length} upload issue${failures.length > 1 ? 's' : ''}.`);
      } else {
        toast.success(`${incomingFiles.length} ${FILE_TAB_LABELS[tabKey]} file${incomingFiles.length > 1 ? 's' : ''} uploaded successfully.`);
        setFileActionMessage(`${incomingFiles.length} ${FILE_TAB_LABELS[tabKey]} file${incomingFiles.length > 1 ? 's were' : ' was'} uploaded and ingested successfully.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to upload files';
      setFileActionMessage(message);
      toast.error(message);
    } finally {
      setFileActionState(EMPTY_FILE_ACTION_STATE);
    }
  };

  const handleDeleteFile = async (file: any) => {
    if (!caseData) return;

    const confirmed = window.confirm(
      `Delete ${file.original_name || file.file_name} and all linked analysis records from this case?`
    );

    if (!confirmed) return;

    setFileActionState({ uploadingTab: null, deletingFileId: Number(file.id) });
    setFileActionMessage(`Deleting ${file.original_name || file.file_name}...`);

    try {
      const result = await fileAPI.remove(file.id);
      await refreshCaseWorkspace();
      setFileActionMessage(`${file.original_name || file.file_name} was removed from the case.`);
      toast.success(
        `Removed ${file.original_name || file.file_name} and ${Number(result.deletedRecords || 0).toLocaleString()} linked record${Number(result.deletedRecords || 0) === 1 ? '' : 's'}.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete file';
      setFileActionMessage(message);
      toast.error(message);
    } finally {
      setFileActionState(EMPTY_FILE_ACTION_STATE);
    }
  };

  const handleArchiveCase = async () => {
    if (!caseData || !caseData.canArchive || caseData.is_evidence_locked || caseData.status === 'archived') return;

    const confirmed = window.confirm(`Archive ${caseData.case_name} and move it out of the active investigation workspace?`);
    if (!confirmed) return;

    setCaseActionState('archive');

    try {
      await caseAPI.archive(String(caseData.id));
      await refreshCaseWorkspace();
      toast.success(`${caseData.case_name} was moved to archive.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to archive case';
      toast.error(message);
    } finally {
      setCaseActionState(null);
    }
  };

  const handleDeleteCase = async () => {
    if (!caseData || !caseData.canDelete || caseData.is_evidence_locked) return;

    const confirmed = window.confirm(`Delete ${caseData.case_name} permanently? This will remove the case and its linked workspace data.`);
    if (!confirmed) return;

    setCaseActionState('delete');

    try {
      await caseAPI.remove(String(caseData.id));
      toast.success(`${caseData.case_name} was deleted.`);
      navigate('/dashboard');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete case';
      toast.error(message);
    } finally {
      setCaseActionState(null);
    }
  };

  const renderCaseLifecycleActions = (compact = false) => {
    if (!caseData || (!caseData.canArchive && !caseData.canDelete)) return null;

    const sharedClassName = compact ? 'h-8 rounded-full px-3 text-xs font-semibold' : 'h-9 rounded-full px-4 text-sm font-semibold';
    const disabledByLock = Boolean(caseData.is_evidence_locked);

    return (
      <>
        {caseData.canArchive && caseData.status !== 'archived' ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleArchiveCase()}
            disabled={caseActionState !== null || disabledByLock}
            title={disabledByLock ? 'Evidence lock prevents case archival.' : 'Move this case to archive'}
            className={`${sharedClassName} border-amber-300/70 bg-amber-50/85 text-amber-700 hover:bg-amber-100/90 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200 dark:hover:bg-amber-500/20`}
          >
            {caseActionState === 'archive' ? 'Closing...' : 'Close Case'}
          </Button>
        ) : null}
        {caseData.canDelete ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleDeleteCase()}
            disabled={caseActionState !== null || disabledByLock}
            title={disabledByLock ? 'Evidence lock prevents case deletion.' : 'Delete this case permanently'}
            className={`${sharedClassName} border-red-300/70 bg-red-50/85 text-red-700 hover:bg-red-100/90 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200 dark:hover:bg-red-500/20`}
          >
            {caseActionState === 'delete' ? 'Deleting...' : 'Delete Case'}
          </Button>
        ) : null}
      </>
    );
  };

  /** Render the selected data type's analysis component */
  const renderDataTypeView = () => {
    if (!dataType || !caseData) return null;

    const caseId = String(caseData.id);
    const caseName = caseData.case_name;
    const operator = caseData.operator || '';
    const moduleFileCount = getModuleFileCount(dataType);
    const onBack = () => navigate(`/case/${id}`);

    return (
      <div className="data-type-view">
        <Suspense
          fallback={
            <div className="mx-auto max-w-3xl rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/80">
              <div className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700 dark:text-blue-300">
                SHAKTI SAHAYATA
              </div>
              <h3 className="mt-3 text-2xl font-black text-slate-900 dark:text-white">
                Loading {dataType.toUpperCase()} analysis
              </h3>
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
                Preparing charts, records, and analysis widgets for this case module.
              </p>
              <div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                <div className="h-full w-1/2 animate-pulse rounded-full bg-blue-600 dark:bg-blue-400" />
              </div>
              <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
                {['Case header remains available', 'Files and chat stay usable', 'Heavy charts load only when needed'].map((item) => (
                  <div
                    key={item}
                    className="rounded-2xl border border-slate-200 bg-slate-50/90 px-4 py-3 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-300"
                  >
                    {item}
                  </div>
                ))}
              </div>
            </div>
          }
        >
          <>
            {dataType === 'cdr' && (
              <CDRAdvancedAnalysis caseId={caseId} caseName={caseName} operator={operator} fileCount={moduleFileCount} onBack={onBack} />
            )}
            {dataType === 'ipdr' && (
              <IPDRAnalytics caseId={caseId} caseName={caseName} operator={operator} parsedData={[]} fileCount={moduleFileCount} onBack={onBack} />
            )}
            {dataType === 'sdr' && (
              <SDRSearch caseId={caseId} />
            )}
            {dataType === 'tower' && (
              <TowerDumpAnalysis caseId={caseId} caseName={caseName} operator={operator} fileCount={moduleFileCount} onBack={onBack} />
            )}
            {dataType === 'ild' && (
              <ILDAnalysis caseId={caseId} caseName={caseName} operator={operator} fileCount={moduleFileCount} onBack={onBack} />
            )}
          </>
        </Suspense>
      </div>
    );
  };

  const renderDefaultTabContent = () => {
    if (!caseData) return null;

    if (activeTab === 'overview') {
      return (
        <div className={tiltShellClass}>
        <Card className="rounded-[1.75rem] border-border/70 bg-white/50 shadow-xl dark:bg-slate-900/50">
          <CardContent className="space-y-6 p-6 sm:p-8">
            {caseData.investigation_details && (
              <div className="case-section">
                <h3 className="mb-2 text-xl font-bold">Investigation Details</h3>
                <p className="text-slate-700 dark:text-slate-300">{caseData.investigation_details}</p>
              </div>
            )}
            <div className="case-section">
              <h3 className="mb-4 text-xl font-bold">Record Summary</h3>
              <div className="record-summary-grid grid grid-cols-2 gap-4 md:grid-cols-5">
                {DATA_TYPES.map((dt) => (
                  <div
                    key={dt.key}
                    className={cn(
                      'record-summary-card flex flex-col items-center rounded-xl border border-slate-200/70 bg-slate-50 p-4 shadow-sm dark:border-slate-700/60 dark:bg-slate-800',
                      tiltCardClass
                    )}
                  >
                    <span className="record-icon mb-2 text-3xl">{dt.icon}</span>
                    <span className="record-count text-2xl font-semibold">{recordCounts[dt.key] || 0}</span>
                    <span className="record-label text-sm text-slate-500">{dt.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
        </div>
      );
    }

    if (activeTab === 'data') {
      return (
        <div className={tiltShellClass}>
        <Card className="rounded-[1.75rem] border-border/70 bg-white/50 shadow-xl dark:bg-slate-900/50">
          <CardContent className="p-6 sm:p-8">
            <div className="case-data-grid grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
              {DATA_TYPES.map((dt) => (
                <Link
                  key={dt.key}
                  to={`/case/${id}/${dt.key}`}
                  className={cn(
                    'data-type-card flex items-center rounded-xl border border-slate-200/70 bg-slate-50 p-6 shadow-sm dark:border-slate-700/60 dark:bg-slate-800',
                    tiltCardClass
                  )}
                >
                  <div className="data-type-icon mr-4 text-4xl">{dt.icon}</div>
                  <div className="data-type-info flex-1">
                    <h3 className="text-lg font-bold">{dt.label}</h3>
                    <p className="text-sm text-slate-500">{dt.desc}</p>
                    <span className="data-type-count mt-2 block text-sm text-shakti-600 dark:text-shakti-400">{recordCounts[dt.key] || 0} records</span>
                  </div>
                  <div className="data-type-arrow text-slate-400">→</div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
        </div>
      );
    }

    if (activeTab === 'timeline') {
      return (
        <div className={tiltShellClass}>
        <Card className="rounded-[1.75rem] border-border/70 bg-white/50 shadow-xl dark:bg-slate-900/50">
          <CardContent className="p-6 sm:p-8">
            <div className="case-section">
              <h3 className="mb-4 text-xl font-bold">Investigation Timeline</h3>
              {timelineLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-20 w-full rounded-2xl" />
                  <Skeleton className="h-20 w-full rounded-2xl" />
                  <Skeleton className="h-20 w-full rounded-2xl" />
                </div>
              ) : timeline.length === 0 ? (
                <p className="no-data text-slate-500">No timeline events found yet for this case.</p>
              ) : (
                <div className="space-y-4">
                  {timeline.map((event, index) => (
                    <div
                      key={`${event.source}-${event.title}-${index}`}
                      className={cn(
                        'rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900',
                        timelineCardClass
                      )}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-md font-semibold text-slate-900 dark:text-white">{event.title}</p>
                          <p className="mt-1 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">{event.source}</p>
                        </div>
                        <p className="rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                          {event.event_time ? new Date(event.event_time).toLocaleString() : 'Timestamp unavailable'}
                        </p>
                      </div>
                      <pre className="mt-4 max-h-[24rem] overflow-auto rounded-lg bg-slate-50 p-4 text-xs whitespace-pre-wrap break-words text-slate-700 dark:bg-slate-950 dark:text-slate-300">
                        {JSON.stringify(event.details || {}, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
        </div>
      );
    }

    return (
      <div className={tiltShellClass}>
      <Card className="rounded-[1.75rem] border-border/70 bg-white/50 shadow-xl dark:bg-slate-900/50">
        <CardContent className="p-6 sm:p-8">
          <div className="case-files">
            <div className="case-section space-y-6">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <h3 className="text-xl font-bold">Case Files</h3>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    Review telecom uploads by type, add new evidence files, or remove files from this workspace.
                  </p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 shadow-sm dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-300">
                  {caseData.is_evidence_locked
                    ? 'Evidence lock is active, so uploads and deletions are disabled.'
                    : 'Uploads here ingest immediately and refresh analysis counts for the selected telecom tab.'}
                </div>
              </div>

              <div className="flex flex-wrap gap-3 rounded-[1.5rem] border border-border/70 bg-card/70 p-3">
                {FILE_TAB_ORDER.map((tabKey) => (
                  <button
                    key={tabKey}
                    type="button"
                    onClick={() => setSelectedFileTab(tabKey)}
                    className={cn(
                      'rounded-2xl px-5 py-3 text-sm font-semibold transition-all',
                      selectedFileTab === tabKey
                        ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                        : 'text-slate-500 hover:-translate-y-0.5 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                    )}
                  >
                    {FILE_TAB_LABELS[tabKey]} ({filesByType[tabKey].length})
                  </button>
                ))}
              </div>

              <div className="rounded-[1.5rem] border border-slate-200 bg-white/80 p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950/50">
                <div className="flex flex-col gap-4 border-b border-slate-200 pb-5 dark:border-slate-800 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h4 className="text-lg font-semibold text-slate-900 dark:text-white">
                      {selectedFileTab ? FILE_TAB_LABELS[selectedFileTab] : 'Files'}
                    </h4>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                      {activeFiles.length > 0
                        ? `${activeFiles.length} file${activeFiles.length === 1 ? '' : 's'} linked to this telecom module.`
                        : `No ${selectedFileTab ? FILE_TAB_LABELS[selectedFileTab] : 'selected'} files have been added to this case yet.`}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => selectedFileTab && fileInputRefs.current[selectedFileTab]?.click()}
                      disabled={!selectedFileTab || !!uploadingTab || !!deletingFileId || caseData.is_evidence_locked}
                      className="rounded-2xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200 dark:disabled:bg-slate-800 dark:disabled:text-slate-500"
                    >
                      {uploadingTab && selectedFileTab === uploadingTab ? 'Uploading...' : `Upload ${selectedFileTab ? FILE_TAB_LABELS[selectedFileTab] : ''}`}
                    </button>
                    {FILE_TAB_ORDER.map((tabKey) => (
                      <input
                        key={tabKey}
                        ref={(element) => {
                          fileInputRefs.current[tabKey] = element;
                        }}
                        type="file"
                        accept=".csv,.xlsx,.xls"
                        multiple
                        className="hidden"
                        onChange={(event) => {
                          void handleUploadIntoFileTab(tabKey, event.target.files);
                          event.target.value = '';
                        }}
                      />
                    ))}
                  </div>
                </div>

                {fileActionMessage ? (
                  <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900/70 dark:text-slate-300">
                    {fileActionMessage}
                  </div>
                ) : null}

                {activeFiles.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-300 px-6 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                    <p className="font-medium text-slate-700 dark:text-slate-200">
                      No {selectedFileTab ? FILE_TAB_LABELS[selectedFileTab] : 'selected'} files are available for this case yet.
                    </p>
                    <p className="mt-2">
                      Add one or more files from this tab to ingest them directly into the case workspace.
                    </p>
                  </div>
                ) : (
                  <div className="mt-5 overflow-x-auto">
                    <table className="files-table w-full border-collapse text-left">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800">
                          <th className="p-3">File Name</th>
                          <th className="p-3">Declared Type</th>
                          <th className="p-3">Detected Type</th>
                          <th className="p-3">Status</th>
                          <th className="p-3">Accepted / Rejected</th>
                          <th className="p-3">Records</th>
                          <th className="p-3">Uploaded</th>
                          <th className="p-3 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeFiles.map((file: any) => (
                          <tr key={file.id} className="border-b border-slate-100 dark:border-slate-800/50">
                            <td className="p-3 font-medium">{file.original_name || file.file_name}</td>
                            <td className="p-3">
                              <span className="rounded bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">
                                {file.file_type || 'Unknown'}
                              </span>
                            </td>
                            <td className="p-3 text-slate-600 dark:text-slate-400">{file.detected_type || '-'}</td>
                            <td className="p-3">
                              <span className={`badge status-${file.parse_status}`}>{file.classification_result || file.parse_status || 'pending'}</span>
                            </td>
                            <td className="p-3 text-slate-600 dark:text-slate-400">{`${file.rows_accepted || 0} / ${file.rows_rejected || 0}`}</td>
                            <td className="p-3 text-slate-600 dark:text-slate-400">{Number(file.record_count || 0) > 0 ? Number(file.record_count).toLocaleString() : '-'}</td>
                            <td className="p-3 text-sm text-slate-500">{new Date(file.uploaded_at).toLocaleDateString()}</td>
                            <td className="p-3">
                              <div className="flex justify-end">
                                <button
                                  type="button"
                                  onClick={() => void handleDeleteFile(file)}
                                  disabled={deletingFileId === Number(file.id) || !!uploadingTab || caseData.is_evidence_locked}
                                  className="rounded-xl border border-red-200 px-3 py-2 text-sm font-semibold text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400 dark:border-red-900/70 dark:text-red-300 dark:hover:bg-red-950/30 dark:disabled:border-slate-700 dark:disabled:text-slate-600"
                                >
                                  {deletingFileId === Number(file.id) ? 'Deleting...' : 'Delete'}
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Card className="rounded-[2rem] border-border/70">
          <CardContent className="space-y-5 p-6">
            <Skeleton className="h-5 w-48 rounded-xl" />
            <Skeleton className="h-12 w-80 rounded-2xl" />
            <div className="flex flex-wrap gap-3">
              <Skeleton className="h-8 w-24 rounded-full" />
              <Skeleton className="h-8 w-24 rounded-full" />
              <Skeleton className="h-8 w-32 rounded-full" />
            </div>
          </CardContent>
        </Card>

        <Skeleton className="h-12 w-full rounded-2xl" />
        <Skeleton className="h-[34rem] w-full rounded-[2rem]" />
      </div>
    )
  }
  if (!caseData) return <div className="page-error">Case not found. <button onClick={() => navigate('/dashboard')}>Back to Dashboard</button></div>;

  // If a dataType is selected, show the dedicated view
  if (dataType) {
    return (
      <div className="case-view">
        {/* Minimal header */}
        <div className="case-header compact">
          <div className="case-header-top">
            <div>
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbLink asChild>
                      <button type="button" onClick={() => navigate('/dashboard')}>Dashboard</button>
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbLink asChild>
                      <button type="button" onClick={() => navigate(`/case/${id}`)}>{caseData.case_number}</button>
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>{DATA_TYPES.find(d => d.key === dataType)?.label || dataType.toUpperCase()}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
              <h1 className="case-title">{caseData.case_name}</h1>
            </div>
            <div className="case-header-badges flex flex-wrap items-center justify-end gap-2">
              <Badge className={`${getStatusClass(caseData.status)} rounded-full`}>{caseData.status}</Badge>
              <Badge className={`${getPriorityClass(caseData.priority)} rounded-full`}>{caseData.priority}</Badge>
              {caseData.is_evidence_locked && <Badge className="status-locked rounded-full">Locked</Badge>}
              {renderCaseLifecycleActions(true)}
            </div>
          </div>
        </div>
        {renderDataTypeView()}
      </div>
    );
  }

  // Default case view with tabs
  return (
    <div className="case-view">
      {/* Case Header */}
      <div className="case-header">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <button type="button" onClick={() => navigate('/dashboard')}>Dashboard</button>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{caseData.case_number}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="case-header-top">
          <button className="btn-back" onClick={() => navigate('/dashboard')}>← Back</button>
          <div className="case-header-badges flex flex-wrap items-center justify-end gap-2">
            <Badge className={`${getStatusClass(caseData.status)} rounded-full`}>{caseData.status}</Badge>
            <Badge className={`${getPriorityClass(caseData.priority)} rounded-full`}>{caseData.priority}</Badge>
            {caseData.is_evidence_locked && <Badge className="status-locked rounded-full">Evidence Locked</Badge>}
            {renderCaseLifecycleActions()}
          </div>
        </div>
        <h1 className="case-title">{caseData.case_name}</h1>
        <div className="case-meta">
          <span>📋 {caseData.case_number}</span>
          {caseData.operator && <span>📶 {caseData.operator}</span>}
          {caseData.fir_number && <span>📝 FIR: {caseData.fir_number}</span>}
          <span>👤 {caseData.created_by_name}</span>
          <span>📅 {new Date(caseData.created_at).toLocaleDateString()}</span>
        </div>
      </div>

      <div className="mt-6 space-y-5">
        <div className="flex flex-wrap gap-3 rounded-[1.5rem] border border-border/70 bg-card/70 p-3">
          {[
            { key: 'overview', label: 'Overview' },
            { key: 'data', label: 'Data & Analysis' },
            { key: 'timeline', label: 'Timeline' },
            { key: 'files', label: `Files (${files.length})` },
          ].map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'rounded-2xl px-5 py-3 text-base font-semibold transition-all',
                activeTab === tab.key
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                  : 'text-slate-500 hover:-translate-y-0.5 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {renderDefaultTabContent()}
      </div>
    </div>
  );
}
