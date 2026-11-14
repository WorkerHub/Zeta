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
  /** §7.4: a global admin or an exact `manage` grant — the same right the API requires. */
  canManageInstance: boolean
  onOpenInstanceConfig: () => void
  /** The gear button's own sizing/placement classes (desktop 46×46, mobile 40×40). */
  triggerClassName?: string
}

/**
 * The Spark gear menu (§7.2): a single-select profile list ("default" + the caller's own profiles,
 * current one checked), "manage configs…" (always, ≥ read) and — for a global admin or a `manage`
 * grant — "instance config…" (§7.4). The instance entry only renders when the caller may open that
 * dialog, so it is never a control that does nothing.
 */
export default function SparkGearMenu({
  profiles,
  selectedProfileId,
  onSelectProfile,
  onOpenManage,
  canManageInstance,
  onOpenInstanceConfig,
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
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onOpenInstanceConfig}>{t('spark.instance_config')}</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
