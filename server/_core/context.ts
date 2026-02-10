import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { sdk } from "./sdk";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;

  if (process.env.NODE_ENV === "development") {
    // Mock user for development
    user = {
      id: 1,
      openId: "dev-user",
      name: "Developer",
      email: "dev@example.com",
      loginMethod: "dev",
      role: "admin",
      lastSignedIn: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as User;
  } else {
    try {
      user = await sdk.authenticateRequest(opts.req);
    } catch (error) {
      // Authentication is optional for public procedures.
      user = null;
    }
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
