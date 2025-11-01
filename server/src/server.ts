import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from "zod";
import fs from 'node:fs/promises'
import path from 'node:path'


const server = new McpServer({ name: 'catalog-mcp', version: '0.0.1' })

// Zod schemas for tool IO
const SearchInput = z.object({
  q: z.string().describe('Full-text query across title/name/description').optional(),
  category: z.string().optional(),
  // With default(), these do not need .optional(); missing values will be filled
  limit: z.number().int().positive().max(100).default(20),
  sortBy: z.enum(['relevance','price','title']).default('relevance'),
  order: z.enum(['asc','desc']).default('asc')
})

const SearchOutput = z.object({
  items: z.array(z.record(z.any())),
})

const CATALOG_WIDGET_URI = 'ui://widget/catalog-list.html'
const CATALOG_WIDGET_HTML = `
<div id="catalog-root" style="font-family:system-ui;padding:12px;">
  <h3 style="margin:0 0 8px 0;">Catalog results</h3>
  <div id="catalog-items"></div>
  <script type="module">
    // Minimal client: read tool output injected by ChatGPT and render cards
    const root = document.getElementById('catalog-items');
    const payload = (window.openai && window.openai.toolOutput) || {};
    const items = (payload && payload.items) || [];

    if (!Array.isArray(items) || items.length === 0) {
      root.innerHTML = '<em>No items found.</em>';
    } else {
      for (const item of items) {
        const card = document.createElement('div');
        card.style.border = '1px solid #e5e7eb';
        card.style.borderRadius = '8px';
        card.style.padding = '8px 12px';
        card.style.margin = '8px 0';

        const title = document.createElement('div');
        title.style.fontWeight = '600';
        title.textContent = item.title || item.name || '(untitled)';

        const subtitle = document.createElement('div');
        subtitle.style.fontSize = '12px';
        subtitle.style.opacity = '0.8';
        subtitle.textContent = item.category ? String(item.category) : '';

        const desc = document.createElement('div');
        desc.style.marginTop = '4px';
        desc.textContent = item.description || '';

        card.appendChild(title);
        if (subtitle.textContent) card.appendChild(subtitle);
        if (desc.textContent) card.appendChild(desc);
        root.appendChild(card);
      }
    }
  </script>
</div>`.trim()

// Register the widget HTML as a UI resource
server.registerResource(
  'catalog-widget',
  CATALOG_WIDGET_URI,
  {
    title: 'Catalog List Widget',
    description: 'Iframe UI that renders the results from search_catalog',
  },
  async () => ({
    contents: [
      {
        uri: CATALOG_WIDGET_URI,
        mimeType: 'text/html',
        text: CATALOG_WIDGET_HTML,
        _meta: {
          'openai/widgetPrefersBorder': true,
          'openai/widgetDescription': 'Displays catalog search results as simple cards.'
        }
      }
    ]
  })
)

// ─────────────────────────────────────────────────────────────
// Catalog loader + search tool
// ─────────────────────────────────────────────────────────────
type CatalogItem = {
  id?: string | number
  title?: string
  name?: string
  description?: string
  category?: string
  price?: number
  [key: string]: unknown
}

async function loadCatalog(): Promise<CatalogItem[]> {
  const dir = path.resolve(process.cwd(), 'catalog')
  let items: CatalogItem[] = []
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.json')) {
        const full = path.join(dir, e.name)
        try {
          const text = await fs.readFile(full, 'utf8')
          const data = JSON.parse(text)
          if (Array.isArray(data)) items.push(...data)
          else if (data && Array.isArray((data as any).items)) items.push(...(data as any).items)
        } catch {
          // ignore bad files
        }
      }
    }
  } catch {
    // folder might not exist yet; return empty
  }
  return items
}

function normalize(s: unknown): string {
  return (typeof s === 'string' ? s : '').toLowerCase()
}

function scoreItem(item: CatalogItem, q: string): number {
  if (!q) return 0
  const hay = [item.title, item.name, item.description].map(normalize).join(' ')
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
  let score = 0
  for (const t of terms) if (hay.includes(t)) score += 1
  return score
}

// Search tool that outputs to the widget template
server.registerTool(
  'search_catalog',
  {
    title: 'Search catalog',
    description: 'Search JSON files in the catalog/ folder for items.',
    _meta: {
      'openai/outputTemplate': CATALOG_WIDGET_URI,
      'openai/toolInvocation/invoking': 'Searching the catalog…',
      'openai/toolInvocation/invoked': 'Showing catalog results',
      'openai/widgetAccessible': true
    },
    inputSchema: SearchInput.shape,
    outputSchema: SearchOutput.shape,
  },
  async (rawInput) => {
    const { q = '', category, limit, sortBy, order } = SearchInput.parse(rawInput)

    const all = await loadCatalog()

    let filtered = all.filter((item) => {
      const catOk = category ? normalize(item.category) === normalize(category) : true
      const textOk = q ? scoreItem(item, q) > 0 : true
      return catOk && textOk
    })

    const dir = order === 'desc' ? -1 : 1
    filtered.sort((a, b) => {
      if (sortBy === 'price') {
        const av = typeof a.price === 'number' ? a.price : Number.POSITIVE_INFINITY
        const bv = typeof b.price === 'number' ? b.price : Number.POSITIVE_INFINITY
        return (av - bv) * dir
      }
      if (sortBy === 'title') {
        return normalize(a.title || a.name).localeCompare(normalize(b.title || b.name)) * dir
      }
      // relevance (default)
      return (scoreItem(a, q) - scoreItem(b, q)) * dir
    })

    const sliced = filtered.slice(0, limit)
    const output = { items: sliced }
    return {
      content: [{ type: 'text', text: `Found ${sliced.length} item(s).` }],
      structuredContent: output,
    }
  }
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.log('[catalog-mcp] connected on stdio')
  process.on('SIGINT', () => transport.close())
  process.on('SIGTERM', () => transport.close())
}
main().catch((err) => { console.error(err); process.exit(1) })
