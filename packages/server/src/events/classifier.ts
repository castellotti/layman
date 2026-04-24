export function classifyRisk(
  toolName: string,
  toolInput: Record<string, unknown>
): 'low' | 'medium' | 'high' {
  // Read-only tools are always low risk
  if (['Read', 'Glob', 'Grep', 'WebSearch'].includes(toolName)) return 'low';

  // Write/Edit to files: medium (reversible but modifies state)
  if (['Write', 'Edit'].includes(toolName)) return 'medium';

  // Agent spawning: medium (resource usage, but contained)
  if (toolName === 'Agent') return 'medium';

  // WebFetch: medium (external network call)
  if (toolName === 'WebFetch') return 'medium';

  // Bash commands need deeper inspection
  if (toolName === 'Bash') {
    const cmd = (toolInput as { command?: string }).command ?? '';
    return classifyBashRisk(cmd);
  }

  // MCP tools: medium by default (unknown behavior)
  if (toolName.startsWith('mcp__')) return 'medium';

  return 'medium';
}

export function classifyBashRisk(command: string): 'low' | 'medium' | 'high' {
  // HIGH risk patterns
  const highRiskPatterns = [
    /\brm\s+(-[rf]+\s+)?\//, // rm from root
    /\brm\s+-[^\s]*r[^\s]*f\b/, // rm -rf variants
    /\brm\s+-[^\s]*f[^\s]*r\b/, // rm -fr variants
    /\bsudo\b/, // Elevated privileges
    /\bcurl\b.*\|\s*(bash|sh|zsh)\b/, // Pipe to shell
    /\bwget\b.*\|\s*(bash|sh|zsh)\b/, // Pipe to shell
    /\bchmod\s+[0-7]*7[0-7]*\b/, // World-writable permissions
    /\bgit\s+push\s+.*--force\b/, // Force push
    /\bgit\s+push\s+.*-f\b/, // Force push shorthand
    /\bgit\s+reset\s+--hard\b/, // Hard reset
    /\b(DROP|DELETE\s+FROM|TRUNCATE)\b/i, // SQL destruction
    /\bmkfs\b/, // Disk formatting
    /\bfdisk\b/, // Disk partitioning
    /\bpasswd\b/, // Password change
    /\buseradd\b/, // User management
    /\buserdel\b/, // User management
    /\biptables\b/, // Firewall
    /\bufw\b/, // Firewall
    /\bsystemctl\s+(start|stop|enable|disable)\b/, // Service management
    />\s*\/etc\//, // Write to system paths
    />\s*\/usr\//, // Write to system paths
    /\beval\b.*\$/, // Dynamic execution with variable
    /\bexec\b.*\$/, // Dynamic execution with variable
    /\bkill\s+-9\b/, // Force kill
    /\bchown\s+-R\b.*\s+\//, // Recursive ownership change at root
  ];

  if (highRiskPatterns.some((p) => p.test(command))) return 'high';

  // MEDIUM risk patterns
  const mediumRiskPatterns = [
    /\bnpm\s+install\b/, // Package install
    /\bnpm\s+i\b/, // Package install shorthand
    /\bpip\s+install\b/, // Package install
    /\bcargo\s+install\b/, // Package install
    /\byarn\s+add\b/, // Package install
    /\bpnpm\s+add\b/, // Package install
    /\bnpx\s/, // Ad-hoc package execution
    /\bbunx\s/, // Ad-hoc package execution
    /\bcurl\b/, // Downloads / network calls
    /\bwget\b/, // Downloads
    /\bgit\s+push\b/, // Push (non-force)
    /\bgit\s+checkout\b/, // Git state changes
    /\bgit\s+reset\b/, // Git state changes
    /\brm\s/, // Any rm
    /\bmv\s/, // Move/rename
    /\bchmod\b/, // Permission changes
    /\bchown\b/, // Ownership changes
    /\bkill\b/, // Process termination
    /\bpkill\b/, // Process termination
    /\bdocker\s+run\b/, // Container execution
    /\bssh\b/, // Remote operations
    /\bscp\b/, // Remote file copy
    /\bcrontab\b/, // Scheduled tasks
    /\blaunchctl\b/, // macOS service management
    /\bpm2\b/, // Process manager
    /\bnohup\b/, // Background execution
  ];

  if (mediumRiskPatterns.some((p) => p.test(command))) return 'medium';

  // LOW risk: ls, cat, echo, grep, find, test, etc.
  return 'low';
}

/**
 * Returns true if the tool call matches one of the user-configured trusted command patterns.
 * Only applies to Bash/shell tool calls.
 */
export function isAutoAllowedByPattern(
  toolName: string,
  toolInput: Record<string, unknown>,
  patterns: string[]
): boolean {
  if (patterns.length === 0) return false;
  if (toolName !== 'Bash' && toolName !== 'shell') return false;

  const command = (toolInput as { command?: string }).command ?? '';
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test(command);
    } catch {
      return false;
    }
  });
}
