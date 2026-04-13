import { z } from 'zod';
import { Client } from '@notionhq/client';
import type { Logger } from 'pino';
import type {
  ServicePlugin,
  PluginTool,
  PluginInitConfig,
  ToolContext,
  CallToolResult,
} from '../types.js';

const ROOT_PAGE_ID = process.env.NOTION_ROOT_PAGE_ID ?? '340582cb2b9c80e9b9b0e164257fc7db';

interface DocPage {
  id: string;
  title: string;
  section: string;
}

export class NotionPlugin implements ServicePlugin {
  readonly name = 'notion';
  readonly description = 'Search and read GRAFMAKER process documentation from Notion';
  readonly attributionLevel = 1 as const;

  private client!: Client;
  private logger!: Logger;

  async initialize(config: PluginInitConfig): Promise<void> {
    this.logger = config.logger;
    const token = config.credentials.NOTION_API_TOKEN;
    if (!token) {
      this.logger.warn('NOTION_API_TOKEN not set — Notion plugin will return errors');
    }
    this.client = new Client({ auth: token || undefined });
  }

  getTools(): PluginTool[] {
    return [this.askTool(), this.searchDocsTool()];
  }

  private askTool(): PluginTool {
    return {
      name: 'henri_ask',
      description:
        'Ask Henri about internal processes and company documentation. ' +
        'Returns relevant content from the official process documentation. ' +
        'Use this for questions like "How do I invoice a client?" or "What is the onboarding procedure?".',
      schema: z.object({
        question: z.string().describe('The question about internal processes'),
      }),
      requiredPermission: 'notion.read',
      evtEventType: 'backoffice.knowledge.query',
      execute: async (input, context) => this.executeAsk(input as { question: string }, context),
    };
  }

  private searchDocsTool(): PluginTool {
    return {
      name: 'henri_search_docs',
      description:
        'Browse available process documentation. ' +
        'Lists all documented processes accessible to you, organized by department.',
      schema: z.object({
        section: z
          .string()
          .optional()
          .describe(
            'Filter by section name (e.g., "Finance", "RH", "Engineering"). Leave empty for all.',
          ),
      }),
      requiredPermission: 'notion.read',
      evtEventType: null,
      execute: async (input, context) =>
        this.executeSearchDocs(input as { section?: string }, context),
    };
  }

  /**
   * Collect all doc pages under the root page (2 levels: sections → pages).
   */
  private async collectDocPages(): Promise<DocPage[]> {
    const pages: DocPage[] = [];
    const sections = await this.client.blocks.children.list({
      block_id: ROOT_PAGE_ID,
      page_size: 100,
    });

    for (const block of sections.results) {
      if (!('type' in block) || block.type !== 'child_page') continue;
      const sectionTitle = 'child_page' in block ? block.child_page.title : 'Untitled';

      // The section itself is a page
      pages.push({ id: block.id, title: sectionTitle, section: sectionTitle });

      // Get sub-pages within this section
      const subPages = await this.client.blocks.children.list({
        block_id: block.id,
        page_size: 50,
      });

      for (const sub of subPages.results) {
        if (!('type' in sub) || sub.type !== 'child_page') continue;
        const subTitle = 'child_page' in sub ? sub.child_page.title : 'Untitled';
        pages.push({ id: sub.id, title: subTitle, section: sectionTitle });
      }
    }

    return pages;
  }

  /**
   * Simple keyword matching: check if any word from the query appears in the title.
   */
  private matchesQuery(title: string, question: string): boolean {
    const titleLower = title.toLowerCase();
    const words = question
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);
    return words.some((word) => titleLower.includes(word));
  }

  private async executeAsk(
    input: { question: string },
    _context: ToolContext,
  ): Promise<CallToolResult> {
    try {
      const allPages = await this.collectDocPages();

      // Find pages matching the question by title
      const matching = allPages.filter((p) => this.matchesQuery(p.title, input.question));

      // If no title match, return all pages as context (the doc set is small)
      const pagesToRead = matching.length > 0 ? matching.slice(0, 5) : allPages.slice(0, 10);

      if (pagesToRead.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No process documentation found. The "Official process" page may not have sub-pages yet.',
            },
          ],
        };
      }

      const contents: string[] = [];

      for (const page of pagesToRead) {
        const blocks = await this.client.blocks.children.list({
          block_id: page.id,
          page_size: 100,
        });
        const text = this.blocksToText(blocks.results);
        if (text.trim()) {
          contents.push(`## ${page.title} (${page.section})\n\n${text}`);
        }
      }

      if (contents.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `Found ${pagesToRead.length} pages but they are all empty. The Methods Officer may need to complete the documentation.`,
            },
          ],
        };
      }

      const prefix =
        matching.length > 0
          ? `Found ${matching.length} relevant page(s)`
          : 'No exact match found — here is all available documentation';

      return {
        content: [
          {
            type: 'text',
            text: `${prefix} for "${input.question}":\n\n${contents.join('\n\n---\n\n')}`,
          },
        ],
      };
    } catch (err) {
      this.logger.error({ error: err, question: input.question }, 'Notion search failed');
      return {
        content: [
          {
            type: 'text',
            text: `Error searching documentation: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async executeSearchDocs(
    input: { section?: string },
    _context: ToolContext,
  ): Promise<CallToolResult> {
    try {
      const allPages = await this.collectDocPages();

      // Group by section
      const sectionMap = new Map<string, string[]>();
      for (const page of allPages) {
        if (page.title === page.section) continue; // Skip section root pages
        if (input.section && page.section.toLowerCase() !== input.section.toLowerCase()) continue;

        if (!sectionMap.has(page.section)) sectionMap.set(page.section, []);
        sectionMap.get(page.section)!.push(page.title);
      }

      if (sectionMap.size === 0) {
        return {
          content: [
            {
              type: 'text',
              text: input.section
                ? `No documentation found for section "${input.section}".`
                : 'No process documentation found yet.',
            },
          ],
        };
      }

      const text = [...sectionMap.entries()]
        .map(([section, pages]) => `### ${section}\n${pages.map((p) => `- ${p}`).join('\n')}`)
        .join('\n\n');

      return {
        content: [
          {
            type: 'text',
            text: `## Available Process Documentation\n\n${text}`,
          },
        ],
      };
    } catch (err) {
      this.logger.error({ error: err }, 'Notion list pages failed');
      return {
        content: [
          {
            type: 'text',
            text: `Error listing documentation: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  private blocksToText(blocks: Array<Record<string, unknown>>): string {
    const lines: string[] = [];
    for (const block of blocks) {
      const type = block.type as string;
      const content = block[type] as Record<string, unknown> | undefined;
      if (!content) continue;

      const richText = content.rich_text as Array<Record<string, unknown>> | undefined;
      if (richText) {
        const text = richText.map((t) => t.plain_text ?? '').join('');
        if (type === 'heading_1') lines.push(`# ${text}`);
        else if (type === 'heading_2') lines.push(`## ${text}`);
        else if (type === 'heading_3') lines.push(`### ${text}`);
        else if (type === 'bulleted_list_item') lines.push(`- ${text}`);
        else if (type === 'numbered_list_item') lines.push(`1. ${text}`);
        else if (type === 'to_do') {
          const checked = content.checked ? '☑' : '☐';
          lines.push(`${checked} ${text}`);
        } else if (type === 'toggle') lines.push(`▸ ${text}`);
        else if (text) lines.push(text);
      }

      if (type === 'divider') lines.push('---');
    }
    return lines.join('\n');
  }
}
