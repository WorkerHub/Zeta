import { useLocale } from '../hooks/useLocale'

interface Props {
  rows: Record<string, unknown>[]
}

export default function ResultTable({ rows }: Props) {
  const { t } = useLocale()
  if (rows.length === 0) {
    return <p className="text-body text-ink-500 py-4 text-center">{t('results.no_rows')}</p>
  }

  const columns = Array.from(new Set(rows.flatMap((r) => Object.keys(r))))

  return (
    <div className="overflow-x-auto rounded-lg border border-ink-200 shadow-sm">
      <table className="w-full text-caption font-mono tnum">
        <thead>
          <tr className="bg-ink-100/50 border-b border-ink-200">
            {columns.map((col) => (
              <th
                key={col}
                className="text-left px-3 py-2 text-label text-ink-500 whitespace-nowrap"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              // biome-ignore lint/suspicious/noArrayIndexKey: result rows have no stable id; position is their identity
              key={i}
              className="border-b border-ink-100 hover:bg-ink-50 transition-colors duration-(--duration-fast) ease-(--ease-standard)"
            >
              {columns.map((col) => {
                const val = row[col]
                return (
                  <td
                    key={col}
                    className="px-3 py-2 text-caption text-ink-700 whitespace-nowrap max-w-[300px] truncate"
                  >
                    {val === null || val === undefined ? (
                      <span className="text-ink-400 italic">NULL</span>
                    ) : typeof val === 'object' ? (
                      <span className="text-warning-600">{JSON.stringify(val)}</span>
                    ) : (
                      String(val)
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
