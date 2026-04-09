import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CaseView from './CaseView'

const getCaseMock = vi.fn()
const getTimelineMock = vi.fn()
const archiveCaseMock = vi.fn()
const removeCaseMock = vi.fn()
const listFilesMock = vi.fn()
const getRecordCountMock = vi.fn()
const removeFileMock = vi.fn()
const ingestCaseUploadsMock = vi.fn()

const cdrAnalysisRenderMock = vi.fn()
const ipdrAnalysisRenderMock = vi.fn()

vi.mock('../components/lib/apis', () => ({
  caseAPI: {
    get: (...args: unknown[]) => getCaseMock(...args),
    getTimeline: (...args: unknown[]) => getTimelineMock(...args),
    archive: (...args: unknown[]) => archiveCaseMock(...args),
    remove: (...args: unknown[]) => removeCaseMock(...args),
  },
  fileAPI: {
    listByCase: (...args: unknown[]) => listFilesMock(...args),
    remove: (...args: unknown[]) => removeFileMock(...args),
  },
  recordCountAPI: {
    getCountByCase: (...args: unknown[]) => getRecordCountMock(...args),
  },
}))

vi.mock('../lib/caseFileIngestion', () => ({
  ingestCaseUploads: (...args: unknown[]) => ingestCaseUploadsMock(...args),
}))

vi.mock('../components/analysis/CDRAdvancedAnalysis', () => ({
  AdvancedAnalytics: (props: { onBack?: () => void; fileCount?: number }) => {
    cdrAnalysisRenderMock(props)
    return (
      <div>
        <div>Mock CDR Analysis</div>
        <div>CDR files: {props.fileCount ?? 0}</div>
        <button type="button" onClick={props.onBack}>
          Mock Back
        </button>
      </div>
    )
  },
}))

vi.mock('../components/analysis/IPDRAnalytics', () => ({
  default: (props: { fileCount?: number }) => {
    ipdrAnalysisRenderMock(props)
    return <div>Mock IPDR Analysis ({props.fileCount ?? 0})</div>
  },
}))

vi.mock('../components/analysis/SDRSearch', () => ({
  SDRSearch: () => <div>Mock SDR Analysis</div>,
}))

vi.mock('../components/analysis/TowerDumpAnalysis', () => ({
  TowerDumpAnalysis: () => <div>Mock Tower Analysis</div>,
}))

vi.mock('../components/analysis/ILDAnalysis', () => ({
  ILDAnalysis: () => <div>Mock ILD Analysis</div>,
}))

describe('CaseView', () => {
  beforeEach(() => {
    getCaseMock.mockReset()
    getTimelineMock.mockReset()
    archiveCaseMock.mockReset()
    removeCaseMock.mockReset()
    listFilesMock.mockReset()
    getRecordCountMock.mockReset()
    removeFileMock.mockReset()
    ingestCaseUploadsMock.mockReset()
    cdrAnalysisRenderMock.mockReset()
    ipdrAnalysisRenderMock.mockReset()

    getCaseMock.mockResolvedValue({
      id: 42,
      case_name: 'Analysis Only Case',
      case_number: 'CASE-42',
      case_type: 'telecom',
      fir_number: 'FIR-42',
      status: 'active',
      priority: 'high',
      operator: 'Jio',
      investigation_details: 'Focused case',
      start_date: '2026-04-01',
      end_date: '2026-04-08',
      is_evidence_locked: false,
      canArchive: true,
      canDelete: true,
      file_count: 4,
      created_at: '2026-04-08T00:00:00.000Z',
      created_by_name: 'Inspector Rao',
    })
    listFilesMock.mockResolvedValue([
      { id: 1, original_name: 'cdr-main.csv', file_type: 'cdr', detected_type: 'cdr', uploaded_at: '2026-04-08T00:00:00.000Z' },
      { id: 2, original_name: 'ipdr-a.csv', file_type: 'ipdr', detected_type: 'ipdr', uploaded_at: '2026-04-08T00:00:00.000Z' },
      { id: 3, original_name: 'ipdr-b.csv', file_type: 'ipdr', detected_type: 'ipdr', uploaded_at: '2026-04-08T00:00:00.000Z' },
      { id: 4, original_name: 'tower.csv', file_type: 'tower', detected_type: 'tower_dump', uploaded_at: '2026-04-08T00:00:00.000Z' },
    ])
    getRecordCountMock.mockResolvedValue(12)
    getTimelineMock.mockResolvedValue({
      events: [
        {
          source: 'cdr',
          event_time: '2026-04-08T10:30:00.000Z',
          title: 'Mocked Timeline Event',
          details: {
            file_id: 29,
            operator: 'VODAFONE',
            duration_sec: 10,
          },
        },
      ],
      limit: 250,
    })
    removeFileMock.mockResolvedValue({ fileId: 1, deleted: true, deletedRecords: 125, deletedType: 'cdr' })
    ingestCaseUploadsMock.mockResolvedValue([])
    archiveCaseMock.mockResolvedValue({ message: 'Case archived' })
    removeCaseMock.mockResolvedValue({ message: 'Case deleted' })
    vi.stubGlobal('confirm', vi.fn(() => true))
  })

  const renderAt = (initialEntry: string) =>
    render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/case/:id" element={<CaseView />} />
          <Route path="/case/:id/:dataType" element={<CaseView />} />
          <Route path="/dashboard" element={<div>Dashboard Route</div>} />
        </Routes>
      </MemoryRouter>
    )

  it('opens the module route directly in CDR analysis without upload toggles and supports back navigation', async () => {
    renderAt('/case/42/cdr')

    expect(await screen.findByText('Mock CDR Analysis')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^upload$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^analysis$/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /mock back/i }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Data & Analysis' })).toBeInTheDocument()
      expect(screen.queryByText('Mock CDR Analysis')).not.toBeInTheDocument()
    })
  })

  it('passes the module-specific file count into IPDR analysis', async () => {
    renderAt('/case/42/ipdr')

    expect(await screen.findByText('Mock IPDR Analysis (2)')).toBeInTheDocument()
    expect(ipdrAnalysisRenderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fileCount: 2,
      })
    )
  })

  it('groups case files by telecom tab inside the Files workspace', async () => {
    renderAt('/case/42')

    expect(await screen.findByRole('button', { name: /files \(4\)/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /files \(4\)/i }))

    expect(await screen.findByText('cdr-main.csv')).toBeInTheDocument()
    expect(screen.queryByText('ipdr-a.csv')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /upload cdr/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /ipdr \(2\)/i }))

    expect(await screen.findByText('ipdr-a.csv')).toBeInTheDocument()
    expect(screen.getByText('ipdr-b.csv')).toBeInTheDocument()
    expect(screen.queryByText('cdr-main.csv')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /upload ipdr/i })).toBeInTheDocument()
  })

  it('renders the timeline feed without the old 3D perspective hover classes', async () => {
    const { container } = renderAt('/case/42')

    fireEvent.click(await screen.findByRole('button', { name: /^timeline$/i }))

    expect(await screen.findByText('Mocked Timeline Event')).toBeInTheDocument()
    expect(screen.getByText(/VODAFONE/i)).toBeInTheDocument()
    expect(getTimelineMock).toHaveBeenCalledWith('42')
    expect(container.innerHTML).not.toContain('perspective(')
  })

  it('archives a case from the overview header and refreshes the status badge', async () => {
    getCaseMock
      .mockResolvedValueOnce({
        id: 42,
        case_name: 'Analysis Only Case',
        case_number: 'CASE-42',
        case_type: 'telecom',
        fir_number: 'FIR-42',
        status: 'active',
        priority: 'high',
        operator: 'Jio',
        investigation_details: 'Focused case',
        start_date: '2026-04-01',
        end_date: '2026-04-08',
        is_evidence_locked: false,
        canArchive: true,
        canDelete: true,
        file_count: 4,
        created_at: '2026-04-08T00:00:00.000Z',
        created_by_name: 'Inspector Rao',
      })
      .mockResolvedValueOnce({
        id: 42,
        case_name: 'Analysis Only Case',
        case_number: 'CASE-42',
        case_type: 'telecom',
        fir_number: 'FIR-42',
        status: 'archived',
        priority: 'high',
        operator: 'Jio',
        investigation_details: 'Focused case',
        start_date: '2026-04-01',
        end_date: '2026-04-08',
        is_evidence_locked: false,
        canArchive: true,
        canDelete: true,
        file_count: 4,
        created_at: '2026-04-08T00:00:00.000Z',
        created_by_name: 'Inspector Rao',
      })

    renderAt('/case/42')

    fireEvent.click(await screen.findByRole('button', { name: /close case/i }))

    await waitFor(() => {
      expect(archiveCaseMock).toHaveBeenCalledWith('42')
      expect(screen.getByText(/archived/i)).toBeInTheDocument()
    })
  })

  it('deletes a case from the overview header and redirects to the dashboard', async () => {
    renderAt('/case/42')

    fireEvent.click(await screen.findByRole('button', { name: /delete case/i }))

    await waitFor(() => {
      expect(removeCaseMock).toHaveBeenCalledWith('42')
      expect(screen.getByText('Dashboard Route')).toBeInTheDocument()
    })
  })
})
