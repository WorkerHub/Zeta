import { Check } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'
import { THEME_COLORS, type ThemeColor } from '../lib/theme-color'

// The dot of each preset is its own 600 tone (index.css §2.1 swatch tokens), so the row shows
// every preset at once, whichever one is active.
const SWATCH_CLASS: Record<ThemeColor, string> = {
  terracotta: 'bg-swatch-terracotta',
  ocean: 'bg-swatch-ocean',
  teal: 'bg-swatch-teal',
  forest: 'bg-swatch-forest',
  grape: 'bg-swatch-grape',
  rose: 'bg-swatch-rose',
  royal: 'bg-swatch-royal',
  violet: 'bg-swatch-violet',
  tangerine: 'bg-swatch-tangerine',
  cyan: 'bg-swatch-cyan',
  magenta: 'bg-swatch-magenta',
  emerald: 'bg-swatch-emerald',
}

const LABEL_KEY: Record<ThemeColor, string> = {
  terracotta: 'theme_color.terracotta',
  ocean: 'theme_color.ocean',
  teal: 'theme_color.teal',
  forest: 'theme_color.forest',
  grape: 'theme_color.grape',
  rose: 'theme_color.rose',
  royal: 'theme_color.royal',
  violet: 'theme_color.violet',
  tangerine: 'theme_color.tangerine',
  cyan: 'theme_color.cyan',
  magenta: 'theme_color.magenta',
  emerald: 'theme_color.emerald',
}

/**
 * Brand colour preset picker: native radios sharing one name (so keyboard arrows move through the
 * presets), drawn as dots — the active one ringed in the live brand colour with a check inside.
 * Applying is immediate: there is no save button, the parent writes it through `useThemeColor`.
 */
export default function ThemeColorPicker({
  value,
  onChange,
}: {
  value: ThemeColor
  onChange: (color: ThemeColor) => void
}) {
  const { t } = useLocale()

  return (
    <div className="flex flex-wrap items-center gap-3">
      {THEME_COLORS.map((color) => {
        const selected = color === value
        const label = t(LABEL_KEY[color])
        return (
          <label key={color} title={label} className="relative flex h-9 w-9 cursor-pointer items-center justify-center">
            <input
              type="radio"
              name="theme-color"
              value={color}
              checked={selected}
              aria-label={label}
              onChange={() => onChange(color)}
              className="peer sr-only"
            />
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full text-white ring-2 ring-transparent ring-offset-2 ring-offset-ink-0 transition-colors duration-(--duration-base) ease-(--ease-standard) peer-checked:ring-brand-600 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-600 dark:peer-checked:ring-brand-400 dark:peer-focus-visible:outline-brand-400 ${SWATCH_CLASS[color]}`}
            >
              {selected && <Check size={14} strokeWidth={3} aria-hidden="true" />}
            </span>
          </label>
        )
      })}
    </div>
  )
}
