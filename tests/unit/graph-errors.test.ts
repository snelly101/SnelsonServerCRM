import { describe, expect, it } from "vitest";
import { HttpError, describeError } from "@/lib/integrations/http";

describe("describeError", () => {
  it("shows Microsoft Graph's nested error code and message instead of [object Object]", () => {
    const err = new HttpError(
      403,
      "https://graph.microsoft.com/v1.0/users/support@example.com/mailFolders/inbox/messages",
      JSON.stringify({ error: { code: "ErrorAccessDenied", message: "Access is denied. Check credentials and try again." } }),
    );
    const text = describeError(err);
    expect(text).toContain("Permission denied (403)");
    expect(text).toContain("ErrorAccessDenied: Access is denied");
    expect(text).not.toContain("[object Object]");
  });
  it("shows the identity platform's flat error and description", () => {
    const err = new HttpError(
      401,
      "https://login.microsoftonline.com/t/oauth2/v2.0/token",
      JSON.stringify({ error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." }),
    );
    expect(describeError(err)).toContain("invalid_client: AADSTS7000215");
  });
});
