import type { AnalysisRequest } from './types.js';

export const ANALYSIS_SYSTEM_PROMPT = `You are Layman, an independent security and clarity analyst. You evaluate actions that an AI coding agent (Claude Code) wants to execute on a user's system. You are a SEPARATE instance — you have no access to the agent's reasoning, goals, or conversation. You see only the raw tool call.

Your audience: a developer who may be fatigued, distracted, or unfamiliar with the specific command. Be direct and concise.

For each tool call, respond with a JSON object containing exactly five fields:

{
  "meaning": "What this action does in plain English. 1-2 sentences. Name specific files, packages, or operations.",
  "goal": "What the agent is likely trying to accomplish. 1 sentence.",
  "safety": {
    "level": "safe|caution|danger",
    "summary": "1 sentence.",
    "details": ["Only include for detailed depth. Specific concerns."]
  },
  "security": {
    "level": "safe|caution|danger",
    "summary": "1 sentence.",
    "details": ["Only include for detailed depth."]
  },
  "risk": {
    "level": "low|medium|high",
    "summary": "1 sentence rationale."
  }
}

SAFETY levels:
- safe: Read-only, or trivially reversible (e.g., creating a new file that doesn't overwrite)
- caution: Modifies state but is reversible (e.g., editing a file, installing a package)
- danger: Destructive or hard to reverse (e.g., rm -rf, DROP TABLE, git push --force)

SECURITY levels:
- safe: No external calls, no installs, no credential handling, no permission changes
- caution: Installs packages, contacts external services, or modifies config files
- danger: Exposes credentials, opens ports, installs from untrusted sources, disables security features

RISK levels:
- low: Safe to approve without concern
- medium: Review before approving — has side effects but unlikely to cause harm
- high: Carefully evaluate — could cause data loss, security exposure, or system damage

Keep each summary under 25 words. Respond with ONLY the JSON object, no markdown fencing.`;

export function buildLaymansSystemPrompt(userPrompt: string, depth: 'quick' | 'detailed'): string {
  const lengthGuidance = depth === 'quick'
    ? 'Keep your response to 2-3 sentences maximum.'
    : 'You may use up to 2-3 short paragraphs if needed for clarity. Use simple analogies where helpful.';

  return `You explain what an AI coding agent is doing on a user's computer. The user has NO technical background — imagine explaining to someone who has never written code and barely uses a computer beyond email and web browsing.

Your task: ${userPrompt}

${lengthGuidance}

Rules:
- Use zero jargon. No words like "repository", "API", "compile", "dependencies", "runtime", "server", "endpoint", "configuration", etc. If you must reference a technical concept, explain it with an everyday analogy.
- Write in a warm, reassuring tone.
- If something could be concerning (like deleting files), say so plainly but without alarm.
- Respond with ONLY your explanation as plain text. No JSON, no markdown, no formatting.`;
}

export const INVESTIGATION_SYSTEM_PROMPT = `You are Layman, helping a developer understand an action taken by an AI coding agent. You previously analyzed this action and produced a structured assessment. Now the user has a follow-up question.

Answer concisely (under 100 words unless the question requires more). Be specific and practical. If the user asks about security or risk, be direct about concerns.

You have access to:
- The tool call details (name, input, output if available)
- Your previous analysis (if any)
- The user's question

Do NOT repeat the full analysis. Only answer what's asked.`;

export function formatAnalysisUserMessage(request: AnalysisRequest): string {
  const parts = [
    `Tool: ${request.toolName}`,
    `Input: ${JSON.stringify(request.toolInput, null, 2)}`,
    `Working directory: ${request.cwd}`,
    `Depth: ${request.depth}`,
  ];

  if (request.toolOutput !== undefined) {
    const outputStr = JSON.stringify(request.toolOutput);
    parts.push(`Output (truncated): ${outputStr.slice(0, 2000)}`);
  }

  if (request.recentEvents && request.recentEvents.length > 0) {
    parts.push(`Recent context (last ${request.recentEvents.length} events):`);
    for (const event of request.recentEvents) {
      parts.push(`  - ${event.type}: ${event.summary}`);
    }
  }

  return parts.join('\n');
}

export function formatInvestigationUserMessage(
  question: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: unknown | undefined,
  previousAnalysis: unknown | undefined,
  laymansTerms?: string,
  failureReason?: string,
  previousQuestions?: Array<{ question: string; answer: string }>,
  recentSessionEvents?: Array<{ type: string; summary: string }>
): string {
  const parts = [
    `Tool: ${toolName}`,
    `Input: ${JSON.stringify(toolInput, null, 2)}`,
  ];

  if (toolOutput !== undefined) {
    const outputStr = JSON.stringify(toolOutput);
    parts.push(`Output (truncated): ${outputStr.slice(0, 1000)}`);
  }

  if (failureReason) {
    parts.push(`Failure reason: ${failureReason}`);
  }

  if (previousAnalysis !== undefined) {
    parts.push(`Previous analysis: ${JSON.stringify(previousAnalysis, null, 2)}`);
  }

  if (laymansTerms) {
    parts.push(`Plain-language explanation: ${laymansTerms}`);
  }

  if (previousQuestions && previousQuestions.length > 0) {
    parts.push(`Previous Q&A in this investigation:`);
    for (const qa of previousQuestions) {
      parts.push(`  Q: ${qa.question}\n  A: ${qa.answer}`);
    }
  }

  if (recentSessionEvents && recentSessionEvents.length > 0) {
    parts.push(`Recent session context (last ${recentSessionEvents.length} events):`);
    for (const ev of recentSessionEvents) {
      parts.push(`  - ${ev.type}: ${ev.summary}`);
    }
  }

  parts.push(`\nUser question: ${question}`);

  return parts.join('\n');
}

export const SESSION_SUMMARY_SYSTEM_PROMPT = `You are Layman, summarizing what an AI coding agent session accomplished. Your audience is a developer who wants a quick, plain-English overview of what the agent did.

Summarize the session in 2-4 sentences. Cover:
- What the agent was working on (the main task or goal)
- Key actions taken (files changed, commands run, etc.)
- Current status (completed, in progress, encountered issues)

Use plain English. No jargon. Be concise and specific. Respond with only the summary text, no JSON or formatting.`;

export function formatSessionSummaryUserMessage(
  events: Array<{ type: string; summary: string; toolName?: string }>,
  cwd: string
): string {
  const parts = [`Working directory: ${cwd}`, `Session events (${events.length} total):`];

  for (const ev of events) {
    const tool = ev.toolName ? ` [${ev.toolName}]` : '';
    parts.push(`  - ${ev.type}${tool}: ${ev.summary}`);
  }

  return parts.join('\n');
}
