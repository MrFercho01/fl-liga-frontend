import type { ReactNode } from 'react'

interface ListSectionControlsProps {
  left: ReactNode
  summary: string
  className?: string
}

interface PaginationControlsProps {
  currentPage: number
  totalPages: number
  onPrev: () => void
  onNext: () => void
  className?: string
}

export const ListSectionControls = ({ left, summary, className = '' }: ListSectionControlsProps) => {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-2 rounded border border-white/10 bg-slate-900/40 px-2 py-2 ${className}`.trim()}>
      <div className="flex items-center gap-2">{left}</div>
      <p className="text-[11px] text-slate-300">{summary}</p>
    </div>
  )
}

export const PaginationControls = ({
  currentPage,
  totalPages,
  onPrev,
  onNext,
  className = '',
}: PaginationControlsProps) => {
  return (
    <div className={`flex items-center justify-end gap-2 rounded border border-white/10 bg-slate-900/40 px-2 py-2 ${className}`.trim()}>
      <button
        type="button"
        onClick={onPrev}
        disabled={currentPage <= 1}
        className="rounded border border-white/20 bg-white/5 px-2 py-1 text-[11px] font-semibold text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Anterior
      </button>
      <span className="text-[11px] text-slate-300">Página {currentPage} de {totalPages}</span>
      <button
        type="button"
        onClick={onNext}
        disabled={currentPage >= totalPages}
        className="rounded border border-white/20 bg-white/5 px-2 py-1 text-[11px] font-semibold text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Siguiente
      </button>
    </div>
  )
}
