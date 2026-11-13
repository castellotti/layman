import type { ClientMessage } from '../../../lib/ws-protocol.js';
import type { LaymanConfig } from '../../../lib/types.js';
import { SectionTitle, SectionIntro, StringListRow, Code } from './primitives.js';

const NO_ACTIVITY = { memoryPaths: [] as string[], memoryServers: [] as string[] };

/**
 * What the Memory station covers beyond Claude Code's own memory folder, which always counts.
 * Stations are worked out when shown, never stored, so a change here re-files all history at once.
 * Mirrors ActivityConfigSchema on the server.
 */
export function ActivitySection({ config, onSend }: { config: LaymanConfig; onSend: (msg: ClientMessage) => void }) {
  const activity = config.activity ?? NO_ACTIVITY;
  // The server deep-merges `activity`, so sending one list keeps the other.
  const set = (updates: Partial<typeof activity>) => onSend({ type: 'config:update', config: { activity: { ...activity, ...updates } } });
  return (
    <>
      <SectionTitle>Stations</SectionTitle>
      <SectionIntro>
        Each event in Logs is filed under the kind of work it is: You, Model, Memory, Files, Shell, Network, Browser, Agents,
        Skills or Guard. Claude Code&rsquo;s memory folder (<Code>~/.claude/projects/&hellip;/memory/</Code>)
        is always Memory; name more here. Changes apply to every session, past ones included.
      </SectionIntro>
      <StringListRow
        label="Memory paths"
        placeholder="~/notes/"
        list={activity.memoryPaths ?? []}
        onChange={(memoryPaths) => set({ memoryPaths })}
        help={<>
          A file call on a path containing one of these is Memory. <Code>~/notes/</Code> and
          your home folder written out are the same. Include the slashes: <Code>notes</Code> alone
          would also match <Code>footnotes</Code>.
        </>}
      />
      <StringListRow
        label="Memory servers"
        placeholder="memory"
        list={activity.memoryServers ?? []}
        onChange={(memoryServers) => set({ memoryServers })}
        help="MCP servers whose tools are Memory, by their name as configured in the harness (a Claude Code plugin's server by its own name)."
      />
    </>
  );
}
