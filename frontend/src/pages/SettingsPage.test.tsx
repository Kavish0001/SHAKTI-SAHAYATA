import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Settings } from './SettingsPage'

const getSettingsMock = vi.fn()
const saveSettingsMock = vi.fn()
const listCasesMock = vi.fn()
const reopenCaseMock = vi.fn()
const removeCaseMock = vi.fn()

vi.mock('../components/lib/apis', () => ({
  settingsAPI: {
    get: () => getSettingsMock(),
    save: (...args: unknown[]) => saveSettingsMock(...args),
  },
  caseAPI: {
    list: (...args: unknown[]) => listCasesMock(...args),
    reopen: (...args: unknown[]) => reopenCaseMock(...args),
    remove: (...args: unknown[]) => removeCaseMock(...args),
  },
}))

vi.mock('../components/settings/SystemDiagnosticsPanel', () => ({
  default: () => <div>Diagnostics Panel</div>,
}))

describe('Settings archive section', () => {
  beforeEach(() => {
    getSettingsMock.mockReset()
    saveSettingsMock.mockReset()
    listCasesMock.mockReset()
    reopenCaseMock.mockReset()
    removeCaseMock.mockReset()
    getSettingsMock.mockResolvedValue({})
    listCasesMock.mockResolvedValue({
      items: [
        {
          id: 22,
          case_name: 'Archived Fraud Case',
          case_number: 'ARC-2026-0022',
          operator: 'Jio',
          priority: 'high',
          updated_at: '2026-04-08T00:00:00.000Z',
          is_evidence_locked: false,
          canArchive: true,
          canDelete: true,
        },
      ],
      pagination: { page: 1, pageSize: 100, total: 1 },
    })
    reopenCaseMock.mockResolvedValue({ message: 'Case reopened' })
    removeCaseMock.mockResolvedValue({ message: 'Case deleted' })
    vi.stubGlobal('confirm', vi.fn(() => true))
  })

  it('shows archived cases and can reopen one', async () => {
    render(<Settings />)

    expect(await screen.findByText('Archived Cases')).toBeInTheDocument()
    expect(await screen.findByText('Archived Fraud Case')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /open again/i }))

    await waitFor(() => {
      expect(reopenCaseMock).toHaveBeenCalledWith('22')
    })
  })
})
