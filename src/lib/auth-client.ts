"use client";

import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [
    twoFactorClient({
      // The login form inspects `twoFactorRedirect` itself so it can carry the `next` target to the verify page.
      onTwoFactorRedirect: async () => {},
    }),
  ],
});
export const { signIn, signOut, useSession } = authClient;
