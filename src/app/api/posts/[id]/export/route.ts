import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { exportAsMarkdown, exportAsHtml } from '@/lib/export';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const url = new URL(req.url);
  const format = (url.searchParams.get('format') || 'md').toLowerCase();
  const { id } = await ctx.params;

  const post = await prisma.post.findUnique({
    where: { id },
    include: {
      author: { select: { name: true, displayName: true } },
      category: { select: { name: true, slug: true } },
      tags: { include: { tag: true } },
    },
  });
  if (!post) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Visibility check: private/unlisted/draft only accessible to owner.
  const visible = post.published && (post.visibility === 'public' || post.visibility === 'unlisted');
  if (!visible) {
    const session = await auth();
    if (!session?.user?.id || (session.user.id !== post.authorId && session.user.role !== 'admin')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  const filenameSafe = (post.slug || post.id).replace(/[^\w\-.]/g, '_');

  if (format === 'html') {
    const html = await exportAsHtml(post, {
      siteName: process.env.NEXT_PUBLIC_SITE_NAME || 'Ink',
      siteUrl: process.env.NEXT_PUBLIC_SITE_URL || '',
    });
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': `attachment; filename="${filenameSafe}.html"`,
      },
    });
  }

  // default: markdown
  const md = exportAsMarkdown(post);
  return new Response(md, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${filenameSafe}.md"`,
    },
  });
}
