import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError, zodFields } from '../../lib/errors.js';
import {
  createSession,
  currentUser,
  deleteCurrentSession,
  hashPassword,
  requireAuth,
  verifyPassword
} from '../../lib/auth.js';
import { writeEvent } from '../../lib/events.js';

const credentialsSchema = z.object({
  email: z.string().trim().email('请输入有效邮箱').max(320),
  password: z.string().min(8, '密码至少 8 位').max(128)
});

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, '新密码至少 8 位').max(128)
});

const deleteAccountSchema = z.object({
  password: z.string().min(1, '请输入密码')
});

function normalizeEmail(email: string): string {
  return email.normalize('NFC').trim().toLowerCase();
}

function publicUser(user: { id: string; email: string; createdAt: Date }) {
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/register',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 hour'
        }
      }
    },
    async (request, reply) => {
      const parsed = credentialsSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(422, 'VALIDATION_ERROR', '注册信息无效', zodFields(parsed.error));
      }
      const email = normalizeEmail(parsed.data.email);
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) throw new AppError(409, 'EMAIL_EXISTS', '该邮箱已注册');

      const user = await prisma.user.create({
        data: { email, passwordHash: await hashPassword(parsed.data.password) }
      });
      await createSession(user.id, reply);
      return reply.status(201).send({ user: publicUser(user) });
    }
  );

  app.post(
    '/login',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '15 minutes',
          keyGenerator: (request) => {
            const body = request.body as { email?: string } | undefined;
            return `${request.ip}:${String(body?.email ?? '').toLowerCase()}`;
          }
        }
      }
    },
    async (request, reply) => {
      const parsed = credentialsSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(401, 'INVALID_CREDENTIALS', '邮箱或密码错误');
      }
      const email = normalizeEmail(parsed.data.email);
      const user = await prisma.user.findUnique({ where: { email } });
      const valid = user ? await verifyPassword(user.passwordHash, parsed.data.password) : false;
      if (!user || !valid || user.status !== 'ACTIVE' || user.deletedAt) {
        throw new AppError(401, 'INVALID_CREDENTIALS', '邮箱或密码错误');
      }
      await createSession(user.id, reply);
      return { user: publicUser(user) };
    }
  );

  app.post('/logout', { preHandler: requireAuth }, async (request, reply) => {
    await deleteCurrentSession(request, reply);
    return reply.status(204).send();
  });

  app.get('/me', { preHandler: requireAuth }, async (request) => {
    return { user: currentUser(request) };
  });

  app.patch('/password', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = passwordChangeSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, 'VALIDATION_ERROR', '密码信息无效', zodFields(parsed.error));
    }
    const authUser = currentUser(request);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: authUser.id } });
    const valid = await verifyPassword(user.passwordHash, parsed.data.currentPassword);
    if (!valid) throw new AppError(422, 'INVALID_PASSWORD', '当前密码不正确');

    await prisma.user.update({
      where: { id: authUser.id },
      data: { passwordHash: await hashPassword(parsed.data.newPassword) }
    });
    await createSession(authUser.id, reply, true);
    return { ok: true };
  });

  app.delete('/account', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = deleteAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(422, 'VALIDATION_ERROR', '请输入密码', zodFields(parsed.error));
    }
    const authUser = currentUser(request);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: authUser.id } });
    if (!(await verifyPassword(user.passwordHash, parsed.data.password))) {
      throw new AppError(422, 'INVALID_PASSWORD', '密码不正确');
    }
    const userId = authUser.id;
    // 注销与数据清理共用同一时间戳：账号、书目、痕迹、完成感受在同一时刻进入软删除，
    // 保留期与彻底清理任务据此按同一条时间线处理。
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const [books, dogEars, annotations, rereadMarks, reflections] = await Promise.all([
        tx.book.findMany({ where: { userId, deletedAt: null }, select: { id: true, title: true } }),
        tx.dogEar.findMany({ where: { userId, deletedAt: null }, select: { id: true, bookId: true } }),
        tx.annotation.findMany({ where: { userId, deletedAt: null }, select: { id: true, bookId: true } }),
        tx.rereadMark.findMany({ where: { userId, deletedAt: null }, select: { id: true, bookId: true } }),
        tx.completionReflection.findMany({ where: { userId, deletedAt: null }, select: { id: true, bookId: true } })
      ]);
      const softDelete = { deletedAt: now, version: { increment: 1 } };
      await Promise.all([
        tx.dogEar.updateMany({ where: { userId, deletedAt: null }, data: softDelete }),
        tx.annotation.updateMany({ where: { userId, deletedAt: null }, data: softDelete }),
        tx.rereadMark.updateMany({ where: { userId, deletedAt: null }, data: softDelete }),
        tx.completionReflection.updateMany({ where: { userId, deletedAt: null }, data: softDelete }),
        tx.book.updateMany({ where: { userId, deletedAt: null }, data: softDelete }),
        tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } })
      ]);
      // 为每个被清理的对象补写删除事件，保证恢复审计完整。
      for (const book of books) {
        await writeEvent(tx, {
          userId,
          bookId: book.id,
          entityType: 'BOOK',
          entityId: book.id,
          action: 'DELETED',
          payload: { bookTitle: book.title, reason: 'account_deleted' }
        });
      }
      const childEvents = [
        ...dogEars.map((item) => ({ entityType: 'DOG_EAR' as const, ...item })),
        ...annotations.map((item) => ({ entityType: 'ANNOTATION' as const, ...item })),
        ...rereadMarks.map((item) => ({ entityType: 'REREAD_MARK' as const, ...item })),
        ...reflections.map((item) => ({ entityType: 'COMPLETION_REFLECTION' as const, ...item }))
      ];
      for (const child of childEvents) {
        await writeEvent(tx, {
          userId,
          bookId: child.bookId,
          entityType: child.entityType,
          entityId: child.id,
          action: 'DELETED',
          payload: { cascade: true, reason: 'account_deleted' }
        });
      }
      await tx.user.update({
        where: { id: userId },
        data: { status: 'DELETED', deletedAt: now }
      });
    });
    reply.clearCookie('pbt_session', { path: '/' });
    return reply.status(204).send();
  });
};
