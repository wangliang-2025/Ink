import { setRequestLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { Link } from '@/i18n/routing';
import { auth } from '@/lib/auth';
import { getPostBySlug, trackView, viewCooldownCookie } from '@/lib/posts';
import { renderMarkdown, extractToc } from '@/lib/markdown';
import { MarkdownContent } from '@/components/markdown-content';
import { TableOfContents } from '@/components/table-of-contents';
import { CommentsSection } from '@/components/comments-section';
import { PostActions } from '@/components/post-actions';
import { DeletePostButton } from '@/components/delete-post-button';
import { formatDate, readingTime } from '@/lib/utils';
import { Calendar, Clock, ArrowLeft, Eye, Folder, Lock, EyeOff, Pencil } from 'lucide-react';

interface Props {
  params: Promise<{ locale: string; slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPostBySlug(slug, null);
  if (!post) return {};

  const robots =
    post.visibility === 'public' ? undefined : { index: false, follow: false };

  return {
    title: post.title,
    description: post.excerpt || undefined,
    robots,
    openGraph: {
      title: post.title,
      description: post.excerpt || undefined,
      type: 'article',
      publishedTime: (post.publishedAt || post.createdAt).toISOString(),
      authors: post.author?.displayName || post.author?.name ? [post.author.displayName || post.author.name!] : undefined,
      images: post.coverImage ? [post.coverImage] : undefined,
    },
  };
}

export default async function PostPage({ params }: Props) {
  const { locale, slug } = await params;
  setRequestLocale(locale);

  const session = await auth();
  const post = await getPostBySlug(slug, session?.user?.id ?? null);
  if (!post) notFound();

  const t = await getTranslations('post');
  const html = await renderMarkdown(post.content, { allowEmbed: post.allowEmbed });
  const toc = extractToc(post.content);
  const minutes = readingTime(post.content);

  // Deduplicated view tracking (cookie-based, 30-min cooldown)
  const didTrack = await trackView(post.id);
  if (didTrack) {
    const cookieStore = await cookies();
    const { name: cookieName, value: cookieVal, maxAge } = viewCooldownCookie(post.id);
    cookieStore.set(cookieName, cookieVal, { maxAge, path: '/', httpOnly: true, sameSite: 'lax', secure: true });
  }
  const displayViews = didTrack ? post.views + 1 : post.views;

  const isOwner = session?.user?.id === post.authorId;
  const canDelete = isOwner || session?.user?.role === 'admin';

  return (
    <div className="reader-page mx-auto w-full max-w-[1800px] px-4 py-8 md:px-8 xl:px-12">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/posts"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-[hsl(var(--accent))]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {t('back_to_list')}
        </Link>
        <div className="flex items-center gap-2">
          {isOwner && (
            <Link href={`/notes/${post.id}/edit`} className="btn-ghost h-9">
              <Pencil className="h-3.5 w-3.5" />
              {t('edit')}
            </Link>
          )}
          {canDelete && (
            <DeletePostButton id={post.id} label={t('delete')} redirectTo="/notes" />
          )}
          <PostActions postId={post.id} />
        </div>
      </div>

      {(post.visibility === 'private' || post.visibility === 'unlisted') && (
        <div className="reader-toc mb-6 flex items-center gap-2 border-l-4 border-l-[hsl(var(--accent))] p-3 text-xs text-muted-foreground">
          {post.visibility === 'private' ? (
            <Lock className="h-3.5 w-3.5 text-[hsl(var(--accent))]" />
          ) : (
            <EyeOff className="h-3.5 w-3.5 text-[hsl(var(--accent))]" />
          )}
          {post.visibility === 'private' ? t('private_notice') : t('unlisted_notice')}
        </div>
      )}

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_220px]">
        <article className="reader-paper">
          <div className="mx-auto w-full max-w-4xl">
          <header className="mb-10">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              {post.category && (
                <Link
                  href={`/categories/${post.category.slug}`}
                  className="chip"
                  style={{
                    color: post.category.color || undefined,
                    borderColor: post.category.color
                      ? `${post.category.color}66`
                      : undefined,
                  }}
                >
                  <Folder className="h-3 w-3" />
                  {post.category.name}
                </Link>
              )}
              {post.tags.map(({ tag }) => (
                <Link key={tag.slug} href={`/tags/${tag.slug}`} className="chip">
                  #{tag.name}
                </Link>
              ))}
            </div>

            <h1 className="text-balance font-serif text-3xl font-bold tracking-tight md:text-5xl">
              {post.title}
            </h1>
            {post.excerpt && (
              <p className="mt-4 text-pretty text-lg text-muted-foreground">
                {post.excerpt}
              </p>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Calendar className="h-4 w-4" />
                {formatDate(
                  post.publishedAt || post.createdAt,
                  locale === 'zh' ? 'zh-CN' : 'en-US'
                )}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Clock className="h-4 w-4" />
                {t('reading_time', { minutes })}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Eye className="h-4 w-4" />
                {t('views', { count: displayViews })}
              </span>
              {(post.author?.displayName || post.author?.name) && (
                <span>
                  {t('by')}{' '}
                  <strong className="text-foreground">
                    {post.author.displayName || post.author.name}
                  </strong>
                </span>
              )}
            </div>
          </header>

          {post.coverImage && (
            <img
              src={post.coverImage}
              alt={post.title}
              className="mb-10 aspect-[16/9] w-full rounded-2xl object-cover shadow-md ring-1 ring-black/[0.04] dark:ring-white/[0.06]"
            />
          )}

          <MarkdownContent html={html} />

          <CommentsSection postId={post.id} />
          </div>
        </article>

        <TableOfContents items={toc} />
      </div>
    </div>
  );
}
