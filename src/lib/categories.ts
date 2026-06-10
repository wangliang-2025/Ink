import { prisma } from './db';
import { slugify } from './utils';

export interface CategoryInput {
  name: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  ownerId?: string | null;
}

export async function listCategories(opts: { ownerId?: string | null; includeOwnerless?: boolean } = {}) {
  const where: Record<string, unknown> = {};
  if (opts.ownerId !== undefined) {
    where.OR = [
      { ownerId: opts.ownerId },
      ...(opts.includeOwnerless ? [{ ownerId: null }] : []),
    ];
  }
  const cats = await prisma.category.findMany({
    where,
    include: {
      _count: {
        select: {
          posts: {
            where: {
              published: true,
              visibility: { in: ['public', 'unlisted'] },
            },
          },
        },
      },
    },
    orderBy: { name: 'asc' },
  });
  return cats.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    color: c.color,
    icon: c.icon,
    ownerId: c.ownerId,
    count: c._count.posts,
  }));
}

export async function getCategoryBySlug(slug: string) {
  let normalized = slug;
  try {
    normalized = decodeURIComponent(slug);
  } catch {}
  return prisma.category.findFirst({ where: { slug: normalized } });
}

export async function createCategory(input: CategoryInput) {
  const baseSlug = slugify(input.name);
  let slug = baseSlug;
  let i = 1;
  const MAX_ATTEMPTS = 1000;
  while (
    i <= MAX_ATTEMPTS &&
    await prisma.category.findFirst({
      where: { slug, ownerId: input.ownerId ?? null },
    })
  ) {
    i += 1;
    slug = `${baseSlug}-${i}`;
  }
  return prisma.category.create({
    data: {
      name: input.name.trim(),
      slug,
      description: input.description ?? null,
      color: input.color ?? null,
      icon: input.icon ?? null,
      ownerId: input.ownerId ?? null,
    },
  });
}

export async function updateCategory(id: string, input: Partial<CategoryInput>) {
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.description !== undefined) data.description = input.description;
  if (input.color !== undefined) data.color = input.color;
  if (input.icon !== undefined) data.icon = input.icon;
  return prisma.category.update({ where: { id }, data });
}

export async function deleteCategory(id: string) {
  return prisma.category.delete({ where: { id } });
}
