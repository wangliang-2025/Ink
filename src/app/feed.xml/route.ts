import { Feed } from 'feed';
import { listPosts } from '@/lib/posts';
import { renderMarkdown } from '@/lib/markdown';

export const dynamic = 'force-dynamic';

export async function GET() {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
  const siteName = process.env.NEXT_PUBLIC_SITE_NAME || 'Ink';
  const description = process.env.NEXT_PUBLIC_SITE_DESCRIPTION || 'A modern personal blog';
  const author = process.env.NEXT_PUBLIC_SITE_AUTHOR || 'Author';

  const feed = new Feed({
    title: siteName,
    description,
    id: siteUrl,
    link: siteUrl,
    language: 'zh',
    image: `${siteUrl}/favicon.svg`,
    favicon: `${siteUrl}/favicon.svg`,
    copyright: `© ${new Date().getFullYear()} ${author}`,
    feedLinks: {
      rss: `${siteUrl}/feed.xml`,
    },
    author: { name: author },
  });

  const { items } = await listPosts({ pageSize: 30 });
  for (const post of items) {
    // Render markdown to HTML for proper RSS content
    let htmlContent = '';
    try {
      htmlContent = await renderMarkdown(post.content, { allowEmbed: post.allowEmbed ?? true });
    } catch {
      // Fall back to raw content if rendering fails
      htmlContent = `<pre>${escapeXml(post.content)}</pre>`;
    }

    feed.addItem({
      title: post.title,
      id: `${siteUrl}/${post.locale}/posts/${post.slug}`,
      link: `${siteUrl}/${post.locale}/posts/${post.slug}`,
      description: post.excerpt || undefined,
      content: htmlContent,
      author: post.author?.name ? [{ name: post.author.name }] : undefined,
      date: post.publishedAt || post.createdAt,
      category: post.tags.map(({ tag }) => ({ name: tag.name })),
    });
  }

  return new Response(feed.rss2(), {
    headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
  });
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
