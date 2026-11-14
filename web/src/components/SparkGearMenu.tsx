import { Settings } from 'lucide-react'
import { useLocale } from '../hooks/useLocale'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './DropdownMenu'
import type { SparkProfile } from '../types'

// The RadioGroup needs a concrete value for "no profile"; an id never equals this sentinel.
const DEFAULT_VALUE = '__default__'

interface Props {
  profiles: SparkProfile[]
  selectedProfileId: string | null
  onSelectProfile: (profileId: string | null) => void
  onOpenManage: () => void
  onOpenInstanceConfig: () => void
  /** Whether the "instance config…" entry is shown (manage/admin, SPEC §7.2). */
  canManageInstance: boolean
  /** The gear button's own sizing/placement classes (desktop 46×46, mobile 40×40). */
  triggerClassName?: string
}

/**
 * The Spark gear menu (§7.2): a single-select profile list ("default" + the caller's own profiles,
 * current one checked), then "manage configs…" (always, ≥ read) and "instance config…" (manage/admin
 * only, opening #56's dialog).
 */
export default function SparkGearMenu({
  profiles,
  selectedProfileId,
  onSelectProfile,
  onOpenManage,
  onOpenInstanceConfig,
  canManageInstance,
  triggerClassName = '',
}: Props) {
  const { t } = useLocale()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={triggerClassName}
          aria-label={t('spark.gear_label')}
          title={t('spark.gear_label')}
        >
          <Settings size={15} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuRadioGroup
          value={selectedProfileId ?? DEFAULT_VALUE}
          onValueChange={(v) => onSelectProfile(v === DEFAULT_VALUE ? null : v)}
        >
          <DropdownMenuRadioItem value={DEFAULT_VALUE}>{t('spark.default_profile')}</DropdownMenuRadioItem>
          {profiles.map((p) => (
            <DropdownMenuRadioItem key={p.id} value={p.id}>
              {p.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenManage}>{t('spark.manage_configs')}</DropdownMenuItem>
        {canManageInstance && (
          <DropdownMenuItem onSelect={onOpenInstanceConfig}>{t('spark.instance_config')}</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
