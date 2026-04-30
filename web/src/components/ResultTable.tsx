interface Props {
  rows: Record<string, unknown>[]
}

export default function ResultTable({ rows }: Props) {
  if (rows.length === 0) {
    return <p className="text-sm text-zinc-500 py-4 text-center">No rows returned</p>
  }

  const columns = Object.keys(rows[0] ?? {})

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full text-sm font-mono">
        <thead>
          <tr className="bg-zinc-800/50 border-b border-zinc-800">
            {columns.map((col) => (
              <th key={col} className="text-left px-3 py-2 text-xs font-medium text-zinc-400 whitespace-nowrap">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
              {columns.map((col) => {
                const val = row[col]
                return (
                  <td key={col} className="px-3 py-2 text-xs text-zinc-300 whitespace-nowrap max-w-[300px] truncate">
                    {val === null ? (
                      <span className="text-zinc-600 italic">NULL</span>
                    ) : typeof val === 'object' ? (
                      <span className="text-amber-400">{JSON.stringify(val)}</span>
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
