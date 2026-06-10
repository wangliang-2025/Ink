import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeKatex from 'rehype-katex';
import rehypePrettyCode from 'rehype-pretty-code';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import type { Root, Element } from 'hast';

export interface TocItem {
  id: string;
  text: string;
  depth: number;
}

// ─── Sanitize schemas ────────────────────────────────────────────────
// Common presentational tags allowed in both schemas.
const baseExtraTags = [
  'figure',
  'figcaption',
  'details',
  'summary',
  'mark',
  'kbd',
  'sup',
  'sub',
  'span',
  'div',
];

const baseAttributes = {
  ...defaultSchema.attributes,
  img: [
    ...(defaultSchema.attributes?.img ?? []),
    'loading',
    'decoding',
    'referrerpolicy',
    'crossorigin',
    'className',
    'class',
    'data*',
  ],
  a: [...(defaultSchema.attributes?.a ?? []), 'target', 'rel'],
  div: ['className', 'class', 'data*'],
  span: ['className', 'class', 'data*', 'style'],
  code: [...(defaultSchema.attributes?.code ?? []), 'className', 'data*'],
  pre: [...(defaultSchema.attributes?.pre ?? []), 'className', 'data*', 'style'],
  figure: ['className', 'class', 'data*'],
};

// Stricter schema: NO iframe / video / audio (used when allowEmbed=false)
const safeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), ...baseExtraTags],
  attributes: baseAttributes,
  protocols: {
    ...defaultSchema.protocols,
    src: ['http', 'https', 'data'],
  },
};

// Permissive schema: allow iframe / video / audio for embedding external content.
const embedSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    ...baseExtraTags,
    'iframe',
    'video',
    'audio',
    'source',
  ],
  attributes: {
    ...baseAttributes,
    iframe: [
      'src',
      'width',
      'height',
      'allow',
      'allowfullscreen',
      'frameborder',
      'loading',
      'referrerpolicy',
      'sandbox',
      'title',
      'name',
    ],
    video: [
      'src',
      'controls',
      'autoplay',
      'loop',
      'muted',
      'poster',
      'width',
      'height',
    ],
    audio: ['src', 'controls', 'loop', 'muted'],
    source: ['src', 'type'],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: ['http', 'https', 'data'],
  },
};

/**
 * Post-process rendered HAST images so that every <img> gets:
 *   - loading="lazy"   (defer off-screen images)
 *   - decoding="async" (avoid blocking main thread)
 *   - referrerpolicy="no-referrer" for remote URLs (hotlink-friendly)
 *   - a data-img-src mirror attribute used by the client-side onerror
 *     fallback to display a placeholder when the source fails to load.
 *
 * Also enforces that every <iframe> has a sandbox attribute for XSS
 * protection. If no sandbox is present, a restrictive default is applied.
 *
 * Sanitization runs after this plugin, so any attributes added here that
 * aren't in the allow-list will be stripped — we've extended the img/iframe
 * allow-lists above accordingly.
 */
function rehypeOptimizeImages() {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName === 'img') {
        const props = (node.properties ??= {});
        if (!props.loading) props.loading = 'lazy';
        if (!props.decoding) props.decoding = 'async';

        const src = typeof props.src === 'string' ? props.src : '';
        if (src && /^https?:/i.test(src) && !props.referrerPolicy) {
          props.referrerPolicy = 'no-referrer';
        }
        // Mirror src so client onerror handler can reveal a placeholder.
        if (src) props.dataImgSrc = src;
        // Flag so CSS can style broken images.
        props.className = [
          ...(Array.isArray(props.className)
            ? (props.className as string[])
            : typeof props.className === 'string'
              ? [props.className]
              : []),
          'md-img',
        ];
      }

      // Enforce sandbox on iframes for XSS protection
      if (node.tagName === 'iframe') {
        const props = (node.properties ??= {});
        if (!props.sandbox) {
          // Restrictive default: allow nothing, but common embeds need
          // scripts + same-origin. Site owners can override via the
          // sandbox attribute in their raw HTML.
          props.sandbox = 'allow-scripts allow-same-origin allow-popups';
        }
      }
    });
  };
}

const buildProcessor = (allowEmbed: boolean) => {
  const schema = allowEmbed ? embedSchema : safeSchema;
  // Always apply rehypeRaw + rehypeSanitize so that any raw HTML from user
  // markdown is parsed into real HAST nodes and then sanitized. Skipping
  // sanitize combined with `rehypeStringify({ allowDangerousHtml: true })`
  // would expose an XSS hole.
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeOptimizeImages)
    .use(rehypeSanitize, schema)
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, {
      behavior: 'wrap',
      properties: { className: ['heading-anchor'] },
    })
    .use(rehypeKatex)
    .use(rehypePrettyCode, {
      theme: { dark: 'github-dark', light: 'github-light' },
      keepBackground: false,
    })
    .use(rehypeStringify, { allowDangerousHtml: true });
};

// ─── Processor cache ──────────────────────────────────────────────────
// Building the unified pipeline (especially rehypePrettyCode / Shiki) is
// expensive — several hundred milliseconds. Cache the two variants (embed
// vs safe) at module scope so they're only built once per process lifetime.
let _processorEmbed: ReturnType<typeof buildProcessor> | null = null;
let _processorSafe: ReturnType<typeof buildProcessor> | null = null;

function getProcessor(allowEmbed: boolean) {
  if (allowEmbed) {
    if (!_processorEmbed) _processorEmbed = buildProcessor(true);
    return _processorEmbed;
  }
  if (!_processorSafe) _processorSafe = buildProcessor(false);
  return _processorSafe;
}

export async function renderMarkdown(
  markdown: string,
  opts: { allowEmbed?: boolean } = {}
): Promise<string> {
  const file = await getProcessor(opts.allowEmbed ?? true).process(markdown);
  let html = String(file);
  // Wrap iframes for responsive display (only present when allowEmbed=true).
  html = html.replace(
    /<iframe([^>]*)><\/iframe>/g,
    '<div class="embed-wrapper"><iframe$1 loading="lazy"></iframe></div>'
  );
  return html;
}

export function extractToc(markdown: string): TocItem[] {
  const lines = markdown.split('\n');
  const toc: TocItem[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const match = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;

    const depth = match[1].length;
    const text = match[2].replace(/[#*`_~]/g, '').trim();
    const id = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-');

    if (id) toc.push({ id, text, depth });
  }

  return toc;
}
