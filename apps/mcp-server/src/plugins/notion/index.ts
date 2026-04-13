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

  private async executeAsk(
    input: { question: string },
    _context: ToolContext,
  ): Promise<CallToolResult> {
    try {
      const results = await this.client.search({
        query: input.question,
        filter: { property: 'object', value: 'page' },
        page_size: 5,
      });

      const pages = results.results.filter((r) => r.object === 'page' && 'properties' in r);

      if (pages.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No documentation found for "${input.question}". The process might not be documented yet. You can ask the Methods Officer to create it.`,
            },
          ],
        };
      }

      const contents: string[] = [];

      for (const page of pages.slice(0, 3)) {
        const title = this.extractPageTitle(page);
        const blocks = await this.client.blocks.children.list({
          block_id: page.id,
          page_size: 50,
        });
        const text = this.blocksToText(blocks.results);
        if (text.trim()) {
          contents.push(`## ${title}\n\n${text}`);
        }
      }

      if (contents.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `Found pages matching "${input.question}" but they are empty. The Methods Officer may need to complete the documentation.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Here is the relevant documentation for "${input.question}":\n\n${contents.join('\n\n---\n\n')}`,
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
      const children = await this.client.blocks.children.list({
        block_id: ROOT_PAGE_ID,
        page_size: 100,
      });

      const sections: Array<{ title: string; children: string[] }> = [];

      for (const block of children.results) {
        if (!('type' in block) || block.type !== 'child_page') continue;
        const sectionTitle = 'child_page' in block ? block.child_page.title : 'Untitled';

        if (input.section && sectionTitle.toLowerCase() !== input.section.toLowerCase()) {
          continue;
        }

        const subPages = await this.client.blocks.children.list({
          block_id: block.id,
          page_size: 50,
        });

        const pageNames = subPages.results
          .filter((b) => 'type' in b && b.type === 'child_page')
          .map((b) => ('child_page' in b ? b.child_page.title : 'Untitled'));

        sections.push({ title: sectionTitle, children: pageNames });
      }

      if (sections.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: input.section
                ? `No documentation found for section "${input.section}".`
                : 'No process documentation found. The documentation structure may not be set up yet.',
            },
          ],
        };
      }

      const text = sections
        .map(
          (s) =>
            `### ${s.title}\n${s.children.length > 0 ? s.children.map((c) => `- ${c}`).join('\n') : '_(empty section)_'}`,
        )
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

  private extractPageTitle(page: Record<string, unknown>): string {
    const props = page.properties as Record<string, unknown> | undefined;
    if (!props) return 'Untitled';
    const titleProp = props.title ?? props.Name ?? props.name;
    if (!titleProp || typeof titleProp !== 'object') return 'Untitled';
    const titleArr = (titleProp as Record<string, unknown>).title;
    if (!Array.isArray(titleArr) || titleArr.length === 0) return 'Untitled';
    return titleArr.map((t: Record<string, unknown>) => t.plain_text ?? '').join('');
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
