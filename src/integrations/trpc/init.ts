import { TRPCError, initTRPC } from "@trpc/server";
import superjson from "superjson";

import { BizError } from "#/server/services/settings";

const t = initTRPC.create({
  transformer: superjson,
});

/**
 * Map domain `BizError`s thrown by the service layer onto tRPC errors so
 * clients receive a stable message. 404xx codes surface as NOT_FOUND.
 */
const errorMiddleware = t.middleware(async ({ next }) => {
  try {
    return await next();
  } catch (cause) {
    if (cause instanceof BizError) {
      const isNotFound = Math.floor(cause.code / 100) === 404;
      throw new TRPCError({
        code: isNotFound ? "NOT_FOUND" : "BAD_REQUEST",
        message: cause.message,
        cause,
      });
    }
    throw cause;
  }
});

export const createTRPCRouter = t.router;
export const publicProcedure = t.procedure.use(errorMiddleware);
