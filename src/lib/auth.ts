import NextAuth, { type DefaultSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { PrismaAdapter } from '@auth/prisma-adapter';
import bcrypt from 'bcryptjs';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from './db';
import { checkRateLimit, RateLimits } from './rate-limit';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: string;
    } & DefaultSession['user'];
  }
  interface User {
    role?: string;
  }
}

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: 'jwt' },
  pages: {
    signIn: '/login',
  },
  providers: [
    Credentials({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;

        // Rate limiting for login attempts based on email + IP
        const h = await headers();
        const forwarded = h.get('x-forwarded-for');
        const ip = forwarded?.split(',')[0]?.trim() ?? 'unknown';
        const rateKey = `login:${parsed.data.email}:${ip}`;
        // Use a pseudo-rate-limit check with the identifier
        if (!checkRateLimit(rateKey, RateLimits.auth).allowed) {
          // Return null to avoid leaking rate-limit info to attackers
          return null;
        }

        const user = await prisma.user.findUnique({
          where: { email: parsed.data.email },
        });
        if (!user || !user.password) return null;

        const ok = await bcrypt.compare(parsed.data.password, user.password);
        if (!ok) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as { role?: string }).role ?? 'user';
      }
      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = (token.id as string) ?? '';
        session.user.role = (token.role as string) ?? 'user';
      }
      return session;
    },
  },
});

export async function requireAdmin() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return null;
  }
  return session;
}
