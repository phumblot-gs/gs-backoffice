#!/usr/bin/env node
/**
 * agent-sandbox-mcp — a stdio MCP server that gives a Paperclip `claude_local`
 * agent the sandbox tools (sandbox_run / sandbox_code_task / sandbox_release).
 *
 * It is launched by the agent's `claude` process via `--mcp-config`, inherits the
 * run-context env, and proxies each call to the deployed sandbox plugin's
 * executeTool route (see proxy.ts). Tool schemas mirror the plugin manifest.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  readProxyConfig,
  executeSandboxTool,
  reportProgress,
  openPr,
  getDiff,
  createChildIssue,
  getIssue,
  parseGitHubRepo,
  REPORT_STATUSES,
  type SandboxToolName,
} from './proxy.js';
import { emitNotify, resolveNotifyScope } from './evt.js';

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError };
}

async function call(toolName: SandboxToolName, parameters: Record<string, unknown>) {
  // Resolve config per-call so a late-arriving run env is still picked up, and so a
  // config error surfaces as a tool error (not a server crash).
  let cfg;
  try {
    cfg = readProxyConfig();
  } catch (err) {
    return textResult((err as Error).message, true);
  }
  try {
    const r = await executeSandboxTool(cfg, toolName, parameters);
    const data = r.data == null ? '' : `\n\n${JSON.stringify(r.data, null, 2)}`;
    return textResult(`${r.content}${data}`);
  } catch (err) {
    return textResult((err as Error).message, true);
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'gs-sandbox', version: '0.1.0' });

  server.tool(
    'sandbox_run',
    'Run an arbitrary command in an isolated, reusable Fly Sprite microVM with a repo checked out at a given git ref, and return the captured exit code + output. For verification: tests, code scanners, pentest tools, lint, build. Reuses the sandbox keyed by `sandboxKey`; does not push.',
    {
      sandboxKey: z
        .string()
        .describe(
          'Stable id scoping Sprite reuse, tied to repo + role (e.g. "audit-GRA-12"). Same key reuses the same microVM.',
        ),
      repoUrl: z.string().describe('Git URL to clone (per project).'),
      ref: z.string().describe('Branch name or commit SHA to check out before running.'),
      command: z
        .string()
        .describe('Command to run in the repo dir (via `sh -c`), e.g. "pnpm test". Does not push.'),
      credMode: z
        .enum(['read_only', 'push'])
        .optional()
        .describe('Which GitHub credential to expose to git in the sandbox (default read_only).'),
      timeoutMs: z.number().optional().describe('Hard wall-clock limit for the command (ms).'),
    },
    (args) => call('sandbox_run', args),
  );

  server.tool(
    'sandbox_code_task',
    'Run Claude in an isolated, reusable Fly Sprite to perform a coding task on a branch, then commit and push the result to GitHub from inside the sandbox. Reuses the sandbox keyed by `sandboxKey` (re-invoke to iterate). Returns branch, head SHA, and Claude’s summary.',
    {
      sandboxKey: z
        .string()
        .describe('Stable id scoping Sprite reuse (tie to repo + issue, e.g. "eng-GRA-12").'),
      repoUrl: z.string().describe('Git URL to clone (per project).'),
      baseBranch: z
        .string()
        .optional()
        .describe('Branch to start from when the target branch is new (default "main").'),
      targetBranch: z.string().describe('Branch to commit + push the work to.'),
      task: z
        .string()
        .describe('Instruction for Claude (it edits files; the tool commits + pushes).'),
      model: z.string().optional().describe('Optional Claude model for the in-sandbox run.'),
      timeoutMs: z.number().optional().describe('Hard wall-clock limit (ms; host caps at 15min).'),
    },
    (args) => call('sandbox_code_task', args),
  );

  server.tool(
    'sandbox_release',
    'Delete the Fly Sprite for a `sandboxKey`. Call when the work is done; the durable result is the pushed branch/PR, so this loses nothing.',
    {
      sandboxKey: z.string().describe('The sandbox to release (same key used to run it).'),
    },
    (args) => call('sandbox_release', args),
  );

  server.tool(
    'report_progress',
    'Update YOUR current issue: set its status and/or post a comment. Use this to report results and move the issue to a final state (done / blocked / in_review) — it replaces shell+curl calls to the Paperclip API. Targets the current issue by default.',
    {
      status: z
        .enum(REPORT_STATUSES)
        .optional()
        .describe('New issue status (e.g. "done", "blocked", "in_review"). Omit to only comment.'),
      comment: z.string().optional().describe('Markdown comment to post on the issue.'),
      issueId: z
        .string()
        .optional()
        .describe('Issue to update; defaults to the current issue (PAPERCLIP_TASK_ID).'),
    },
    async (args) => {
      let cfg;
      try {
        cfg = readProxyConfig();
      } catch (err) {
        return textResult((err as Error).message, true);
      }
      try {
        const r = await reportProgress(cfg, args);
        return textResult(
          `Issue ${r.identifier ?? cfg.taskIssueId ?? ''} updated (status: ${r.status}).`.trim(),
        );
      } catch (err) {
        return textResult((err as Error).message, true);
      }
    },
  );

  server.tool(
    'get_diff',
    'Review code changes: return the unified diff between two git refs of a repo (e.g. base "main" vs a branch a sandbox_code_task pushed). Read-only. Use this to inspect what was changed before opening or approving a PR.',
    {
      repoUrl: z.string().describe('Git URL of the repo (e.g. https://github.com/org/repo.git).'),
      base: z.string().describe('Base ref to compare from (e.g. "main").'),
      head: z.string().describe('Head ref to compare to (e.g. the branch that was pushed).'),
      maxBytes: z
        .number()
        .optional()
        .describe('Truncate the diff to this many bytes (default 50000).'),
    },
    async (args) => {
      try {
        return textResult(await getDiff(args));
      } catch (err) {
        return textResult((err as Error).message, true);
      }
    },
  );

  server.tool(
    'open_pr',
    'Open a GitHub pull request for a branch that a sandbox_code_task pushed. The durable result of the engineer loop. Merging stays a human decision — this only opens the PR. Returns the PR number and URL.',
    {
      repoUrl: z.string().describe('Git URL of the repo (e.g. https://github.com/org/repo.git).'),
      head: z.string().describe('The branch to open the PR from (the pushed branch).'),
      base: z.string().optional().describe('The branch to merge into (default "main").'),
      title: z.string().describe('PR title.'),
      body: z.string().optional().describe('PR description (markdown).'),
    },
    async (args) => {
      try {
        const r = await openPr(args);
        // Best-effort: notify the right Google Chat channel that a PR needs review
        // (Gate 3). Never let a notify failure fail the tool — the PR is the result.
        let notified = false;
        try {
          const { owner, repo } = parseGitHubRepo(args.repoUrl);
          const scope = resolveNotifyScope(`${owner}/${repo}`);
          notified = await emitNotify({
            text: `🔍 PR #${r.number} needs review: ${args.title}\n${r.url}`,
            scope,
            resourceType: 'pull_request',
            resourceId: `${owner}/${repo}#${r.number}`,
          });
        } catch {
          /* notify is best-effort */
        }
        return textResult(
          `Opened PR #${r.number}: ${r.url}${notified ? ' (review notification sent)' : ''}`,
        );
      } catch (err) {
        return textResult((err as Error).message, true);
      }
    },
  );

  server.tool(
    'create_child_issue',
    'Decompose your work: create a child issue (one step) under YOUR current issue and assign it to an agent (e.g. the Engineer). Give it concrete, verifiable acceptanceCriteria. Use this to drive the engineer loop step by step — spawn a step, get woken when it completes, review it, then spawn the next. By default the child blocks your issue until done.',
    {
      title: z.string().describe('Short title of the step.'),
      description: z.string().optional().describe('What the assignee must do for this step.'),
      assigneeAgentId: z.string().describe('Agent id to assign the step to (e.g. the Engineer).'),
      acceptanceCriteria: z
        .array(z.string())
        .optional()
        .describe('Concrete, verifiable criteria for THIS step (≤20).'),
      blockParentUntilDone: z
        .boolean()
        .optional()
        .describe('Keep your issue blocked until this step is done (default true).'),
    },
    async (args) => {
      let cfg;
      try {
        cfg = readProxyConfig();
      } catch (err) {
        return textResult((err as Error).message, true);
      }
      try {
        const r = await createChildIssue(cfg, args);
        return textResult(
          `Created child issue ${r.identifier ?? r.id} (status: ${r.status ?? '?'}).`,
        );
      } catch (err) {
        return textResult((err as Error).message, true);
      }
    },
  );

  server.tool(
    'get_issue',
    "Read an issue's current status and its latest report comments — use it to review a child step's result (the Engineer's report) before deciding the next step.",
    {
      issueId: z.string().describe('The issue to read (e.g. a child step you created).'),
    },
    async (args) => {
      let cfg;
      try {
        cfg = readProxyConfig();
      } catch (err) {
        return textResult((err as Error).message, true);
      }
      try {
        const v = await getIssue(cfg, args.issueId);
        const comments = v.comments.map((c) => `- ${c.body}`).join('\n\n');
        return textResult(
          `${v.identifier ?? v.id} "${v.title ?? ''}" — status: ${v.status ?? '?'}, assignee: ${v.assigneeAgentId ?? 'none'}\n\nLatest comments:\n${comments || '(none)'}`,
        );
      } catch (err) {
        return textResult((err as Error).message, true);
      }
    },
  );

  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run when invoked directly (the bin entrypoint).
main().catch((err) => {
  console.error('agent-sandbox-mcp failed to start:', err);
  process.exit(1);
});
