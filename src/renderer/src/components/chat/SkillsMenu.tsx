import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Plus,
  Sparkles,
  Loader2,
  Command,
  MessageSquare,
  Settings2,
  Check,
  Cable
} from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useSkillsStore } from '@renderer/stores/skills-store'
import { useChannelStore } from '@renderer/stores/channel-store'
import { useMcpStore } from '@renderer/stores/mcp-store'
import { useUIStore } from '@renderer/stores/ui-store'
import { listCommands, type CommandCatalogItem } from '@renderer/lib/commands/command-loader'

interface SkillsMenuProps {
  onSelectSkill: (skillName: string) => void
  onSelectCommand?: (commandName: string) => void
  disabled?: boolean
  projectId?: string | null
}

export function SkillsMenu({
  onSelectSkill,
  onSelectCommand,
  disabled = false,
  projectId
}: SkillsMenuProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const [open, setOpen] = React.useState(false)
  const [commands, setCommands] = React.useState<CommandCatalogItem[]>([])
  const [commandsLoading, setCommandsLoading] = React.useState(false)
  const skills = useSkillsStore((s) => s.skills)
  const loading = useSkillsStore((s) => s.loading)
  const loadSkills = useSkillsStore((s) => s.loadSkills)

  // Channel state
  const channels = useChannelStore((s) => s.channels)
  const activeChannelIdsByProject = useChannelStore((s) => s.activeChannelIdsByProject)
  const activeChannelIds = activeChannelIdsByProject[projectId ?? '__global__'] ?? []
  const toggleActiveChannel = useChannelStore((s) => s.toggleActiveChannel)
  const loadChannels = useChannelStore((s) => s.loadChannels)
  const loadProviders = useChannelStore((s) => s.loadProviders)
  const configuredChannels = React.useMemo(
    () =>
      channels.filter(
        (p) => p.enabled && (!projectId ? true : p.projectId === projectId)
      ),
    [channels, projectId]
  )
  const openSettingsPage = useUIStore((s) => s.openSettingsPage)

  // MCP state
  const mcpServers = useMcpStore((s) => s.servers)
  const activeMcpIdsByProject = useMcpStore((s) => s.activeMcpIdsByProject)
  const activeMcpIds = activeMcpIdsByProject[projectId ?? '__global__'] ?? []
  const toggleActiveMcp = useMcpStore((s) => s.toggleActiveMcp)
  const loadMcpServers = useMcpStore((s) => s.loadServers)
  const mcpStatuses = useMcpStore((s) => s.serverStatuses)
  const mcpTools = useMcpStore((s) => s.serverTools)
  const connectedMcpServers = React.useMemo(
    () =>
      mcpServers.filter(
        (s) => s.enabled && mcpStatuses[s.id] === 'connected' && (!projectId ? true : s.projectId === projectId)
      ),
    [mcpServers, mcpStatuses, projectId]
  )

  // Load skills, channels, MCP servers, and commands when menu opens
  React.useEffect(() => {
    if (!open) return

    loadSkills()
    loadProviders()
    loadChannels()
    loadMcpServers()

    let cancelled = false
    setCommandsLoading(true)
    void listCommands()
      .then((items) => {
        if (cancelled) return
        setCommands(items)
      })
      .finally(() => {
        if (cancelled) return
        setCommandsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, loadSkills, loadChannels, loadProviders, loadMcpServers])

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <DropdownMenuTrigger asChild>
              <Button
                data-tour="composer-plus"
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 rounded-lg"
                disabled={disabled}
              >
                <Plus className="size-4" />
              </Button>
            </DropdownMenuTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t('skills.addActions')}</TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>{t('skills.addToChat')}</DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Command className="mr-2 size-4" />
              <span>{t('skills.commandsLabel')}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="w-64 max-h-80 overflow-y-auto">
                <DropdownMenuLabel>
                  {t('skills.availableCommands', { defaultValue: '可用命令' })}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {commandsLoading ? (
                  <div className="flex items-center justify-center py-4 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin mr-1.5" />
                    {t('skills.loadingCommands', { defaultValue: '加载命令中...' })}
                  </div>
                ) : commands.length === 0 ? (
                  <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                    <p>{t('skills.noCommands', { defaultValue: '未发现命令' })}</p>
                    <p className="mt-1 text-[10px] opacity-70">~/.open-cowork/commands/</p>
                  </div>
                ) : (
                  commands.map((command) => (
                    <DropdownMenuItem
                      key={command.name}
                      onClick={() => {
                        onSelectCommand?.(command.name)
                        setOpen(false)
                      }}
                      className="flex flex-col items-start gap-1 py-2"
                    >
                      <span className="font-medium">/{command.name}</span>
                      {command.summary && (
                        <span className="text-xs text-muted-foreground line-clamp-2">
                          {command.summary}
                        </span>
                      )}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Sparkles className="mr-2 size-4" />
              <span>{t('skills.skillsLabel')}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="w-64 max-h-80 overflow-y-auto">
                <DropdownMenuLabel>{t('skills.availableSkills')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {loading ? (
                  <div className="flex items-center justify-center py-4 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin mr-1.5" />
                    {t('skills.loadingSkills')}
                  </div>
                ) : skills.length === 0 ? (
                  <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                    <p>{t('skills.noSkills')}</p>
                    <p className="mt-1 text-[10px] opacity-70">~/.open-cowork/skills/</p>
                  </div>
                ) : (
                  skills.map((skill) => (
                    <DropdownMenuItem
                      key={skill.name}
                      onClick={() => onSelectSkill(skill.name)}
                      className="flex flex-col items-start gap-1 py-2"
                    >
                      <span className="font-medium">{skill.name}</span>
                      <span className="text-xs text-muted-foreground line-clamp-2">
                        {skill.description}
                      </span>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <MessageSquare className="mr-2 size-4" />
              <span>{t('skills.channelsLabel', 'Channels')}</span>
              {activeChannelIds.length > 0 && (
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {activeChannelIds.length}
                </span>
              )}
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="w-56 max-h-80 overflow-y-auto">
                <DropdownMenuLabel>
                  {t('skills.availableChannels', 'Available Channels')}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {configuredChannels.length === 0 ? (
                  <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                    <p>{t('skills.noChannels', 'No channels configured')}</p>
                    <p className="mt-1 text-[10px] opacity-70">
                      {t('skills.configureInSettings', 'Add channels in Settings → channles')}
                    </p>
                  </div>
                ) : (
                  configuredChannels.map((channel) => {
                    const isActive = activeChannelIds.includes(channel.id)
                    return (
                      <DropdownMenuItem
                        key={channel.id}
                        onSelect={(e) => {
                          e.preventDefault()
                          toggleActiveChannel(channel.id, projectId)
                        }}
                        className="flex items-center gap-2 py-1.5 cursor-pointer"
                      >
                        <span
                          className={`flex items-center justify-center size-4 rounded border ${
                            isActive
                              ? 'bg-primary border-primary text-primary-foreground'
                              : 'border-muted-foreground/30'
                          }`}
                        >
                          {isActive && <Check className="size-3" />}
                        </span>
                        <span className="flex-1 truncate text-xs">{channel.name}</span>
                        <span className="text-[10px] text-muted-foreground">{channel.type}</span>
                      </DropdownMenuItem>
                    )
                  })
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    setOpen(false)
                    openSettingsPage('channel')
                  }}
                  className="text-xs"
                >
                  <Settings2 className="mr-2 size-3.5" />
                  {t('skills.configureChannels', 'Configure...')}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Cable className="mr-2 size-4" />
              <span>{t('skills.mcpLabel', 'MCP Servers')}</span>
              {activeMcpIds.length > 0 && (
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {activeMcpIds.length}
                </span>
              )}
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="w-56 max-h-80 overflow-y-auto">
                <DropdownMenuLabel>
                  {t('skills.availableMcps', 'Connected MCP Servers')}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {connectedMcpServers.length === 0 ? (
                  <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                    <p>{t('skills.noMcps', 'No MCP servers connected')}</p>
                    <p className="mt-1 text-[10px] opacity-70">
                      {t('skills.configureMcps', 'Add servers in Settings → MCP')}
                    </p>
                  </div>
                ) : (
                  connectedMcpServers.map((srv) => {
                    const isActive = activeMcpIds.includes(srv.id)
                    const toolCount = mcpTools[srv.id]?.length ?? 0
                    return (
                      <DropdownMenuItem
                        key={srv.id}
                        onSelect={(e) => {
                          e.preventDefault()
                          toggleActiveMcp(srv.id, projectId)
                        }}
                        className="flex items-center gap-2 py-1.5 cursor-pointer"
                      >
                        <span
                          className={`flex items-center justify-center size-4 rounded border ${
                            isActive
                              ? 'bg-primary border-primary text-primary-foreground'
                              : 'border-muted-foreground/30'
                          }`}
                        >
                          {isActive && <Check className="size-3" />}
                        </span>
                        <span className="flex-1 truncate text-xs">{srv.name}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {toolCount} tool{toolCount !== 1 ? 's' : ''}
                        </span>
                      </DropdownMenuItem>
                    )
                  })
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    setOpen(false)
                    openSettingsPage('mcp')
                  }}
                  className="text-xs"
                >
                  <Settings2 className="mr-2 size-3.5" />
                  {t('skills.configureMcpServers', 'Configure...')}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
