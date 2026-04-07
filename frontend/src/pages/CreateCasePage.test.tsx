import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CreateCasePage from './CreateCasePage'

const navigateMock = vi.fn()
const createCaseMock = vi.fn()
const ingestCaseUploadsMock = vi.fn()

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => navigateMock,
  }
})

vi.mock('../components/lib/apis', () => ({
  caseAPI: {
    create: (...args: unknown[]) => createCaseMock(...args),
  },
}))

vi.mock('../lib/caseFileIngestion', () => ({
  ingestCaseUploads: (...args: unknown[]) => ingestCaseUploadsMock(...args),
}))

const fillRequiredFields = async () => {
  fireEvent.change(screen.getByPlaceholderText(/mumbai cyber fraud 2026/i), {
    target: { value: 'Mobile Readiness Case' },
  })

  fireEvent.click(screen.getByRole('combobox', { name: /telecom operator/i }))
  fireEvent.click(await screen.findByRole('option', { name: 'Jio' }))

  fireEvent.click(screen.getByRole('combobox', { name: /case type/i }))
  fireEvent.click(await screen.findByRole('option', { name: 'Cyber Crime' }))

  fireEvent.change(screen.getByLabelText(/fir number/i), {
    target: { value: 'FIR/2026/0042' },
  })

  fireEvent.change(screen.getByLabelText(/investigation details/i), {
    target: { value: 'Investigating coordinated telecom fraud activity.' },
  })

  fireEvent.change(screen.getByLabelText(/start date/i), {
    target: { value: '2026-04-01' },
  })

  fireEvent.change(screen.getByLabelText(/end date/i), {
    target: { value: '2026-04-08' },
  })
}

describe('CreateCasePage', () => {
  beforeEach(() => {
    createCaseMock.mockReset()
    navigateMock.mockReset()
    ingestCaseUploadsMock.mockReset()
    ingestCaseUploadsMock.mockResolvedValue([])
  })

  it('blocks submission, shows validation errors, and preserves selected files when required fields are missing', async () => {
    render(
      <MemoryRouter>
        <CreateCasePage />
      </MemoryRouter>
    )

    const fileInputs = document.querySelectorAll('input[type="file"]')
    const cdrInput = fileInputs[0] as HTMLInputElement
    const selectedFile = new File(['cdr-data'], 'cdr-a.csv', { type: 'text/csv' })

    fireEvent.change(screen.getByPlaceholderText(/mumbai cyber fraud 2026/i), {
      target: { value: 'Mobile Readiness Case' },
    })
    fireEvent.change(cdrInput, { target: { files: [selectedFile] } })
    fireEvent.click(screen.getByRole('button', { name: /create case & upload 1 file/i }))

    expect(await screen.findByText(/complete all required case details/i)).toBeInTheDocument()
    expect(screen.getByText(/select a telecom operator/i)).toBeInTheDocument()
    expect(screen.getByText(/fir number is required/i)).toBeInTheDocument()
    expect(screen.getByText(/investigation details are required/i)).toBeInTheDocument()
    expect(screen.getByText(/start date is required/i)).toBeInTheDocument()
    expect(screen.getByText(/end date is required/i)).toBeInTheDocument()
    expect(screen.getByText('cdr-a.csv')).toBeInTheDocument()
    expect(createCaseMock).not.toHaveBeenCalled()
    expect(ingestCaseUploadsMock).not.toHaveBeenCalled()
  })

  it('blocks submission when end date is earlier than start date', async () => {
    render(
      <MemoryRouter>
        <CreateCasePage />
      </MemoryRouter>
    )

    await fillRequiredFields()

    fireEvent.change(screen.getByLabelText(/start date/i), {
      target: { value: '2026-04-10' },
    })
    fireEvent.change(screen.getByLabelText(/end date/i), {
      target: { value: '2026-04-08' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^create case$/i }))

    expect(await screen.findByText(/end date cannot be earlier than start date/i)).toBeInTheDocument()
    expect(createCaseMock).not.toHaveBeenCalled()
  })

  it('creates a case and preserves multi-file upload flow once all required fields are present', async () => {
    createCaseMock.mockResolvedValue({ id: 101 })

    render(
      <MemoryRouter>
        <CreateCasePage />
      </MemoryRouter>
    )

    await fillRequiredFields()

    const fileInputs = document.querySelectorAll('input[type="file"]')
    const cdrInput = fileInputs[0] as HTMLInputElement
    const files = [
      new File(['cdr-one'], 'cdr-a.csv', { type: 'text/csv' }),
      new File(['cdr-two'], 'cdr-b.csv', { type: 'text/csv' }),
    ]

    fireEvent.change(cdrInput, { target: { files } })
    fireEvent.click(screen.getByRole('button', { name: /create case & upload 2 files/i }))

    await waitFor(() => {
      expect(createCaseMock).toHaveBeenCalled()
      expect(ingestCaseUploadsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          caseId: 101,
          operator: 'Jio',
          uploads: expect.arrayContaining([
            expect.objectContaining({
              key: 'cdr',
              files: expect.arrayContaining(files),
            }),
          ]),
        })
      )
      expect(navigateMock).toHaveBeenCalledWith('/case/101')
    })
  })
})
