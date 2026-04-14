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
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CONTENT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

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

  // Cache for page tree
  private cachedPages: DocPage[] = [];
  private cacheTimestamp = 0;

  // Cache for page content
  private contentCache = new Map<string, { text: string; timestamp: number }>();

  async initialize(config: PluginInitConfig): Promise<void> {
    this.logger = config.logger;
    const token = config.credentials.NOTION_API_TOKEN;
    if (!token) {
      this.logger.warn('NOTION_API_TOKEN not set — Notion plugin will return errors');
    }
    this.client = new Client({ auth: token || undefined });

    // Pre-warm cache at startup
    try {
      await this.getDocPages();
      this.logger.info({ pages: this.cachedPages.length }, 'Notion page cache warmed');
    } catch {
      this.logger.warn('Failed to pre-warm Notion cache');
    }
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
   * Get doc pages with caching (TTL 5 min).
   */
  private async getDocPages(): Promise<DocPage[]> {
    if (this.cachedPages.length > 0 && Date.now() - this.cacheTimestamp < CACHE_TTL_MS) {
      return this.cachedPages;
    }

    const pages: DocPage[] = [];
    const sections = await this.client.blocks.children.list({
      block_id: ROOT_PAGE_ID,
      page_size: 100,
    });

    const sectionBlocks = sections.results.filter((b) => 'type' in b && b.type === 'child_page');

    // Fetch all section children in parallel
    const sectionResults = await Promise.all(
      sectionBlocks.map(async (block) => {
        const sectionTitle = 'child_page' in block ? block.child_page.title : 'Untitled';
        const subPages = await this.client.blocks.children.list({
          block_id: block.id,
          page_size: 50,
        });
        return { block, sectionTitle, subPages };
      }),
    );

    for (const { block, sectionTitle, subPages } of sectionResults) {
      pages.push({ id: block.id, title: sectionTitle, section: sectionTitle });
      for (const sub of subPages.results) {
        if (!('type' in sub) || sub.type !== 'child_page') continue;
        const subTitle = 'child_page' in sub ? sub.child_page.title : 'Untitled';
        pages.push({ id: sub.id, title: subTitle, section: sectionTitle });
      }
    }

    this.cachedPages = pages;
    this.cacheTimestamp = Date.now();
    return pages;
  }

  /**
   * Get page content with caching (TTL 10 min).
   */
  private async getPageContent(pageId: string): Promise<string> {
    const cached = this.contentCache.get(pageId);
    if (cached && Date.now() - cached.timestamp < CONTENT_CACHE_TTL_MS) {
      return cached.text;
    }

    const blocks = await this.client.blocks.children.list({
      block_id: pageId,
      page_size: 100,
    });
    const text = this.blocksToText(blocks.results);
    this.contentCache.set(pageId, { text, timestamp: Date.now() });
    return text;
  }

  /**
   * Filter pages by RBAC scopes for the 'notion' service.
   * Scopes match against section names (e.g., "Comptabilité - Finance", "Engineering").
   */
  private filterByScopes(pages: DocPage[], context: ToolContext): DocPage[] {
    const notionScopes = context.scopes['notion'] ?? context.scopes['*'];
    if (!notionScopes || notionScopes.includes('*')) return pages;

    const allowed = new Set(notionScopes.map((s) => s.toLowerCase()));
    return pages.filter((p) => {
      const sectionLower = p.section.toLowerCase();
      return allowed.has(sectionLower) || [...allowed].some((s) => sectionLower.includes(s));
    });
  }

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
    context: ToolContext,
  ): Promise<CallToolResult> {
    try {
      const allPages = this.filterByScopes(await this.getDocPages(), context);
      const matching = allPages.filter((p) => this.matchesQuery(p.title, input.question));
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

      // Read page contents in parallel
      const contentResults = await Promise.all(
        pagesToRead.map(async (page) => ({
          page,
          text: await this.getPageContent(page.id),
        })),
      );

      const contents = contentResults
        .filter((r) => r.text.trim())
        .map((r) => `## ${r.page.title} (${r.page.section})\n\n${r.text}`);

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
    context: ToolContext,
  ): Promise<CallToolResult> {
    try {
      const allPages = this.filterByScopes(await this.getDocPages(), context);
      const sectionMap = new Map<string, string[]>();

      for (const page of allPages) {
        if (page.title === page.section) continue;
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
        content: [{ type: 'text', text: `## Available Process Documentation\n\n${text}` }],
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
