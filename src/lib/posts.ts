import type { Prisma } from '@prisma/client';
import { cookies } from 'next/headers';
import { prisma } from './db';
import { excerptFrom, slugify } from './utils';

export type Visibility = 'public' | 'private' | 'unlisted';

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export interface PostListParams {
  locale?: string;
  tag?: string;
  category?: string;
  query?: string;
  page?: number;
  pageSize?: number;
  // when true, ignore visibility/published filters (for owner views & admin)
  includeAll?: boolean;
  authorId?: string;
}

export async function listPosts({
  locale,
  tag,
  category,
  query,
  page = 1,
  pageSize = 10,
  includeAll = false,
  authorId,
}: PostListParams = {}) {
  const where: Record<string, unknown> = {};
  if (!includeAll) {
    where.published = true;
    where.visibility = 'public';
  }
  if (locale) where.locale = locale;
  if (authorId) where.authorId = authorId;

  if (query) {
    where.OR = [
      { title: { contains: query, mode: 'insensitive' } },
      { content: { contains: query, mode: 'insensitive' } },
      { excerpt: { contains: query, mode: 'insensitive' } },
    ];
  }
  if (tag) {
    where.tags = { some: { tag: { slug: safeDecode(tag) } } };
  }
  if (category) {
    where.category = { slug: safeDecode(category) };
  }

  const [items, total] = await Promise.all([
    prisma.post.findMany({
      where,
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        author: { select: { id: true, name: true, displayName: true, image: true } },
        category: { select: { id: true, slug: true, name: true, color: true, icon: true } },
        tags: { include: { tag: true } },
        _count: { select: { comments: true } },
      },
    }),
    prisma.post.count({ where }),
  ]);

  return { items, total, page, pageSize, pageCount: Math.ceil(total / pageSize) };
}

export async function getPostBySlug(slug: string, viewerId?: string | null) {
  const normalized = safeDecode(slug);
  const post = await prisma.post.findFirst({
    where: { slug: normalized },
    include: {
      author: {
        select: { id: true, name: true, displayName: true, image: true, bio: true, website: true },
      },
      category: { select: { id: true, slug: true, name: true, color: true, icon: true } },
      tags: { include: { tag: true } },
    },
  });
  if (!post) return null;
  // Public + published is visible to all
  if (post.published && (post.visibility === 'public' || post.visibility === 'unlisted')) {
    return post;
  }
  // Otherwise, only the owner can see
  if (viewerId && viewerId === post.authorId) return post;
  return null;
}

export async function listAllTags() {
  const tags = await prisma.tag.findMany({
    include: {
      _count: {
        select: {
          posts: {
            where: {
              post: {
                published: true,
                visibility: { in: ['public', 'unlisted'] },
              },
            },
          },
        },
      },
    },
    orderBy: { name: 'asc' },
  });
  return tags.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    count: t._count.posts,
  }));
}

export interface PostInput {
  title: string;
  slug?: string;
  content: string;
  excerpt?: string;
  coverImage?: string | null;
  locale?: string;
  visibility?: Visibility;
  published?: boolean;
  allowEmbed?: boolean;
  categoryId?: string | null;
  tags?: string[];
  authorId: string;
}

export async function createPost(input: PostInput) {
  const rawSlug = (input.slug && input.slug.trim()) || input.title;
  const slug = await ensureUniqueSlug(slugify(rawSlug));
  const excerpt = input.excerpt || excerptFrom(input.content);
  const tagConnections = await connectOrCreateTags(input.tags ?? []);

  return prisma.post.create({
    data: {
      title: input.title,
      slug,
      content: input.content,
      excerpt,
      coverImage: input.coverImage ?? null,
      locale: input.locale ?? 'zh',
      visibility: input.visibility ?? 'public',
      allowEmbed: input.allowEmbed ?? true,
      published: input.published ?? false,
      publishedAt: input.published ? new Date() : null,
      authorId: input.authorId,
      categoryId: input.categoryId ?? null,
      tags: tagConnections.length ? { create: tagConnections } : undefined,
    },
  });
}

export async function updatePost(id: string, input: Partial<PostInput>) {
  return prisma.$transaction(async (tx) => {
    const data: Record<string, unknown> = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.slug !== undefined && input.slug.trim().length > 0) {
      const normalized = slugify(input.slug.trim());
      const existing = await tx.post.findUnique({ where: { slug: normalized } });
      // Only apply if it's unchanged (same record) or free for use.
      if (!existing || existing.id === id) {
        data.slug = normalized;
      }
    }
    if (input.content !== undefined) {
      data.content = input.content;
      data.excerpt = input.excerpt || excerptFrom(input.content);
    } else if (input.excerpt !== undefined) {
      data.excerpt = input.excerpt;
    }
    if (input.coverImage !== undefined) data.coverImage = input.coverImage;
    if (input.locale !== undefined) data.locale = input.locale;
    if (input.visibility !== undefined) data.visibility = input.visibility;
    if (input.allowEmbed !== undefined) data.allowEmbed = input.allowEmbed;
    if (input.categoryId !== undefined) data.categoryId = input.categoryId;
    if (input.published !== undefined) {
      data.published = input.published;
      if (input.published) {
        const existing = await tx.post.findUnique({ where: { id } });
        if (existing && !existing.publishedAt) data.publishedAt = new Date();
      }
    }

    if (input.tags) {
      await tx.postTag.deleteMany({ where: { postId: id } });
      const connections = await connectOrCreateTagsInTx(tx, input.tags);
      if (connections.length) {
        data.tags = { create: connections };
      }
    }

    return tx.post.update({ where: { id }, data });
  });
}

async function ensureUniqueSlug(base: string, maxRetries = 100): Promise<string> {
  let slug = base;
  let i = 1;
  while (await prisma.post.findUnique({ where: { slug } })) {
    if (i > maxRetries) {
      // Fall back to a timestamp-based slug if we hit the retry limit
      slug = `${base}-${Date.now().toString(36)}`;
      break;
    }
    i += 1;
    slug = `${base}-${i}`;
  }
  return slug;
}

async function connectOrCreateTags(names: string[]) {
  const cleaned = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  const result: { tagId: string }[] = [];
  for (const name of cleaned) {
    const slug = slugify(name);
    const tag = await prisma.tag.upsert({
      where: { slug },
      update: { name },
      create: { name, slug },
    });
    result.push({ tagId: tag.id });
  }
  return result;
}

/** Transaction-aware variant used inside updatePost's $transaction. */
async function connectOrCreateTagsInTx(
  tx: Prisma.TransactionClient,
  names: string[]
) {
  const cleaned = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  const result: { tagId: string }[] = [];
  for (const name of cleaned) {
    const slug = slugify(name);
    const tag = await tx.tag.upsert({
      where: { slug },
      update: { name },
      create: { name, slug },
    });
    result.push({ tagId: tag.id });
  }
  return result;
}

// ─── View tracking with deduplication ─────────────────────────────────
// Prevents refresh-spam and bot traffic from inflating view counts.
// Uses a short-lived cookie to de-duplicate views from the same browser
// within a configurable cooldown window (default 30 minutes).

const VIEW_COOLDOWN_SECONDS = 30 * 60; // 30 min
const VIEW_COOKIE_PREFIX = 'pv_';

export async function trackView(postId: string): Promise<boolean> {
  const cookieStore = await cookies();
  const cookieName = `${VIEW_COOKIE_PREFIX}${postId}`;

  if (cookieStore.get(cookieName)) return false; // already counted recently

  try {
    await prisma.post.update({
      where: { id: postId },
      data: { views: { increment: 1 } },
    });
    return true; // view was counted
  } catch (err) {
    console.error(`[trackView] Failed to increment views for post ${postId}:`, err);
    return false;
  }
}

/** Returns a Set-Cookie header value to mark a post as viewed. */
export function viewCooldownCookie(postId: string): { name: string; value: string; maxAge: number } {
  return {
    name: `${VIEW_COOKIE_PREFIX}${postId}`,
    value: '1',
    maxAge: VIEW_COOLDOWN_SECONDS,
  };
}
