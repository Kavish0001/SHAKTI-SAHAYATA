import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Dashboard from './Dashboard'
import { useAuthStore } from '../stores/authStore'
import { TooltipProvider } from '@/components/ui/tooltip'

const getStatsMock = vi.fn()
const listCasesMock = vi.fn()
const archiveCaseMock = vi.fn()
const removeCaseMock = vi.fn()
const navigateMock = vi.fn()

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => navigateMock,
  }
})

vi.mock('../components/lib/apis', () => ({
  dashboardAPI: {
    getStats: () => getStatsMock(),
  },
  caseAPI: {
    list: (...args: unknown[]) => listCasesMock(...args),
    archive: (...args: unknown[]) => archiveCaseMock(...args),
    remove: (...args: unknown[]) => removeCaseMock(...args),
  },
}))

describe('Dashboard', () => {
  beforeEach(() => {
    getStatsMock.mockReset()
    listCasesMock.mockReset()
    archiveCaseMock.mockReset()
    removeCaseMock.mockReset()
    navigateMock.mockReset()
    vi.stubGlobal('confirm', vi.fn(() => true))
    useAuthStore.setState({
      authStatus: 'authenticated',
      token: 'token-123',
      user: {
        id: 2,
        buckleId: 'BK-9999',
        email: 'admin@police.gov.in',
        fullName: 'Priya Patel',
        role: 'super_admin',
      },
      session: null,
    })
  })

  it('loads dashboard stats and cases', async () => {
    getStatsMock.mockResolvedValue({
      totalCases: 1,
      activeCases: 1,
      totalFiles: 3,
      recentCases: [],
    })
    listCasesMock.mockResolvedValue({
      items: [
        {
          id: 2,
          case_name: 'Test Case Alpha',
          case_number: 'TCA-2026-8423',
          status: 'open',
          priority: 'medium',
          operator: 'Jio',
          file_count: 3,
          updated_at: '2026-04-06T00:00:00.000Z',
          canArchive: true,
          canDelete: true,
          is_evidence_locked: false,
        },
      ],
      pagination: { page: 1, pageSize: 50, total: 1 },
    })

    render(
      <TooltipProvider>
        <MemoryRouter>
          <Dashboard />
        </MemoryRouter>
      </TooltipProvider>
    )

    await waitFor(() => {
      expect(screen.getByText(/your investigations/i)).toBeInTheDocument()
      expect(screen.getByText('Test Case Alpha')).toBeInTheDocument()
      expect(screen.getByText(/TCA-2026-8423/i)).toBeInTheDocument()
    })
  })

  it('archives a case from the dashboard card without triggering card navigation', async () => {
    getStatsMock.mockResolvedValue({
      totalCases: 1,
      activeCases: 1,
      totalFiles: 3,
      recentCases: [],
    })
    listCasesMock
      .mockResolvedValueOnce({
        items: [
          {
            id: 2,
            case_name: 'Test Case Alpha',
            case_number: 'TCA-2026-8423',
            status: 'open',
            priority: 'medium',
            operator: 'Jio',
            file_count: 3,
            updated_at: '2026-04-06T00:00:00.000Z',
            canArchive: true,
            canDelete: true,
            is_evidence_locked: false,
          },
        ],
        pagination: { page: 1, pageSize: 50, total: 1 },
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: 2,
            case_name: 'Test Case Alpha',
            case_number: 'TCA-2026-8423',
            status: 'archived',
            priority: 'medium',
            operator: 'Jio',
            file_count: 3,
            updated_at: '2026-04-06T00:00:00.000Z',
            canArchive: true,
            canDelete: true,
            is_evidence_locked: false,
          },
        ],
        pagination: { page: 1, pageSize: 50, total: 1 },
      })
    archiveCaseMock.mockResolvedValue({ message: 'Case archived' })

    render(
      <TooltipProvider>
        <MemoryRouter>
          <Dashboard />
        </MemoryRouter>
      </TooltipProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: /close case/i }))

    await waitFor(() => {
      expect(archiveCaseMock).toHaveBeenCalledWith('2')
      expect(screen.getAllByText(/archived/i)[0]).toBeInTheDocument()
    })

    expect(navigateMock).not.toHaveBeenCalledWith('/case/2')
  })
})
