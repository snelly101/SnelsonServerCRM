import { createHash, createSign, randomUUID } from "node:crypto";
import { HttpClient, HttpError, describeError } from "@/lib/integrations/http";
import {
  GRAPH_BASE,
  GRAPH_SCOPE,
  loginUrl,
  type GraphAttachment,
  type GraphDeltaPage,
  type GraphFolder,
  type GraphMessage,
  type GraphSubscription,
  type M365Client,
  type OutboundDraft,
} from "./types";

export type M365Token = { accessToken: string; expiresAt: number };
export type M365Credentials = {
  tenantId: string;
  clientId: string;
  authMode: "secret" | "certificate";
  clientSecret?: string;
  /** PEM private key + certificate for the client-assertion flow. */ privateKeyPem?: string;
  certificatePem?: string;
  token?: M365Token | null;
};

const SELECT =
  "id,internetMessageId,conversationId,conversationIndex,subject,receivedDateTime,sentDateTime,from,sender,toRecipients,ccRecipients,bccRecipients,replyTo,body,bodyPreview,hasAttachments,isDraft,isRead,parentFolderId";
const IMMUTABLE = { Prefer: 'IdType="ImmutableId"' };
const SMALL_ATTACHMENT = 3 * 1024 * 1024;

/** base64url(SHA-1 of the DER certificate), the x5t header Entra expects on a client assertion. */
export function certificateThumbprint(certificatePem: string) {
  const der = Buffer.from(
    certificatePem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""),
    "base64",
  );
  return createHash("sha1").update(der).digest("base64url");
}
export function buildClientAssertion(
  creds: {
    tenantId: string;
    clientId: string;
    privateKeyPem: string;
    certificatePem: string;
  },
  now = Date.now(),
) {
  const enc = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const headerPart = enc({
    alg: "RS256",
    typ: "JWT",
    x5t: certificateThumbprint(creds.certificatePem),
  });
  const claims = enc({
    aud: loginUrl(creds.tenantId),
    iss: creds.clientId,
    sub: creds.clientId,
    jti: randomUUID(),
    nbf: Math.floor(now / 1000) - 60,
    exp: Math.floor(now / 1000) + 540,
  });
  const signer = createSign("RSA-SHA256");
  signer.update(`${headerPart}.${claims}`);
  return `${headerPart}.${claims}.${signer.sign(creds.privateKeyPem).toString("base64url")}`;
}

/**
 * Live Microsoft Graph connector for the support mailbox (app-only).
 * Reads and writes only under /users/{mailbox}: no directory, no other mailboxes.
 */
export class LiveM365Client implements M365Client {
  readonly mode = "live" as const;
  private http: HttpClient;
  private token: M365Token | null;
  private fetching: Promise<M365Token> | null = null;
  private fetchImpl: typeof fetch;

  constructor(
    private readonly creds: M365Credentials,
    private readonly onToken: (t: M365Token) => Promise<void>,
    fetchImpl?: typeof fetch,
  ) {
    this.token = creds.token ?? null;
    this.fetchImpl = fetchImpl ?? fetch;
    this.http = new HttpClient({
      name: "m365",
      baseUrl: GRAPH_BASE,
      headers: async () => ({
        Authorization: `Bearer ${(await this.getToken()).accessToken}`,
      }),
      minIntervalMs: 50,
      timeoutMs: 60_000,
      maxAttempts: 5,
      onUnauthorized: async () => {
        this.token = null;
        await this.getToken();
        return true;
      },
      fetchImpl,
    });
  }

  private async getToken(): Promise<M365Token> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token;
    if (!this.fetching) {
      this.fetching = (async () => {
        const form = new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.creds.clientId,
          scope: GRAPH_SCOPE,
        });
        if (this.creds.authMode === "certificate") {
          if (!this.creds.privateKeyPem || !this.creds.certificatePem)
            throw new Error("Certificate credentials are incomplete.");
          form.set(
            "client_assertion_type",
            "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          );
          form.set(
            "client_assertion",
            buildClientAssertion({
              tenantId: this.creds.tenantId,
              clientId: this.creds.clientId,
              privateKeyPem: this.creds.privateKeyPem,
              certificatePem: this.creds.certificatePem,
            }),
          );
        } else {
          if (!this.creds.clientSecret)
            throw new Error("Client secret is missing.");
          form.set("client_secret", this.creds.clientSecret);
        }
        const url = loginUrl(this.creds.tenantId);
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: form.toString(),
        });
        const text = await res.text();
        if (!res.ok) throw new HttpError(res.status, url, text.slice(0, 500));
        const j = JSON.parse(text) as {
          access_token: string;
          expires_in?: number;
        };
        const t = {
          accessToken: j.access_token,
          expiresAt:
            Date.now() + Math.max(60, (j.expires_in ?? 3600) - 120) * 1000,
        };
        this.token = t;
        await this.onToken(t);
        return t;
      })().finally(() => (this.fetching = null));
    }
    return this.fetching;
  }

  private user(address: string) {
    return `/users/${encodeURIComponent(address)}`;
  }

  async testMailbox(address: string) {
    try {
      const me = await this.http.get<{
        id: string;
        displayName?: string | null;
      }>(`${this.user(address)}`, { $select: "id,displayName,mail" });
      let canRead = false;
      try {
        await this.http.get(
          `${this.user(address)}/mailFolders/inbox/messages`,
          { $top: 1, $select: "id" },
          IMMUTABLE,
        );
        canRead = true;
      } catch (err) {
        return {
          ok: false as const,
          error: `Mailbox found but cannot be read (${describeError(err)}). Check Mail.ReadWrite and the application access policy.`,
          status: err instanceof HttpError ? err.status : undefined,
        };
      }
      // Mail.Send cannot be probed without sending; report unknown until the first send.
      return {
        ok: true as const,
        displayName: me.data.displayName ?? null,
        userId: me.data.id,
        canRead,
        canSend: null,
      };
    } catch (err) {
      return {
        ok: false as const,
        error: describeError(err),
        status: err instanceof HttpError ? err.status : undefined,
      };
    }
  }

  async listFolders(address: string) {
    const res = await this.http.get<{ value: GraphFolder[] }>(
      `${this.user(address)}/mailFolders`,
      {
        $top: 100,
        $select: "id,displayName,parentFolderId,totalItemCount,unreadItemCount",
      },
      IMMUTABLE,
    );
    return res.data.value ?? [];
  }

  async deltaMessages(
    address: string,
    folderId: string,
    link: string | null,
    since: Date | null,
  ): Promise<GraphDeltaPage> {
    let res: {
      data: {
        value?: GraphMessage[];
        "@odata.nextLink"?: string;
        "@odata.deltaLink"?: string;
      };
    };
    if (link) {
      // Absolute link returned by Graph; call it verbatim.
      res = await this.http.get(link, undefined, IMMUTABLE);
    } else {
      const query: Record<string, string> = { $select: SELECT, $top: "50" };
      if (since) query.$filter = `receivedDateTime ge ${since.toISOString()}`;
      res = await this.http.get(
        `${this.user(address)}/mailFolders/${encodeURIComponent(folderId)}/messages/delta`,
        query,
        IMMUTABLE,
      );
    }
    return {
      messages: res.data.value ?? [],
      nextLink: res.data["@odata.nextLink"] ?? null,
      deltaLink: res.data["@odata.deltaLink"] ?? null,
    };
  }

  async getMessage(address: string, id: string) {
    try {
      const res = await this.http.get<GraphMessage>(
        `${this.user(address)}/messages/${encodeURIComponent(id)}`,
        { $select: `${SELECT},internetMessageHeaders` },
        IMMUTABLE,
      );
      return res.data;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  async listAttachments(address: string, messageId: string) {
    const res = await this.http.get<{ value: GraphAttachment[] }>(
      `${this.user(address)}/messages/${encodeURIComponent(messageId)}/attachments`,
      { $select: "id,name,contentType,size,isInline,contentId" },
      IMMUTABLE,
    );
    return res.data.value ?? [];
  }

  async getAttachmentBytes(
    address: string,
    messageId: string,
    attachmentId: string,
  ) {
    try {
      const res = await this.http.get<GraphAttachment>(
        `${this.user(address)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
        undefined,
        IMMUTABLE,
      );
      if (res.data.contentBytes)
        return Buffer.from(res.data.contentBytes, "base64");
      // Item or reference attachments have no bytes.
      return null;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  async findByInternetMessageId(address: string, internetMessageId: string) {
    const res = await this.http.get<{ value: GraphMessage[] }>(
      `${this.user(address)}/messages`,
      {
        $filter: `internetMessageId eq '${internetMessageId.replace(/'/g, "''")}'`,
        $select: SELECT,
        $top: 1,
      },
      IMMUTABLE,
    );
    return res.data.value?.[0] ?? null;
  }

  async createSubscription(
    address: string,
    folderId: string,
    notificationUrl: string,
    lifecycleUrl: string,
    clientState: string,
    expiresAt: Date,
  ) {
    const res = await this.http.post<GraphSubscription>("/subscriptions", {
      changeType: "created",
      notificationUrl,
      lifecycleNotificationUrl: lifecycleUrl,
      resource: `${this.user(address)}/mailFolders('${folderId}')/messages`,
      expirationDateTime: expiresAt.toISOString(),
      clientState,
    });
    return res.data;
  }
  async renewSubscription(id: string, expiresAt: Date) {
    const res = await this.http.request<GraphSubscription>(
      "PATCH",
      `/subscriptions/${encodeURIComponent(id)}`,
      { body: { expirationDateTime: expiresAt.toISOString() } },
    );
    return res.data;
  }
  async deleteSubscription(id: string) {
    try {
      await this.http.request(
        "DELETE",
        `/subscriptions/${encodeURIComponent(id)}`,
      );
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) throw err;
    }
  }

  async createDraft(
    address: string,
    draft: OutboundDraft,
    replyToId: string | null,
    replyAll: boolean,
  ) {
    const rcpt = (list: { name?: string | null; email: string }[]) =>
      list.map((r) => ({
        emailAddress: { address: r.email, name: r.name ?? undefined },
      }));
    const body = {
      subject: draft.subject,
      body: { contentType: "html", content: draft.html },
      toRecipients: rcpt(draft.to),
      ccRecipients: rcpt(draft.cc),
      bccRecipients: rcpt(draft.bcc),
      internetMessageHeaders: Object.entries(draft.headers)
        .filter(([k]) => /^x-/i.test(k))
        .map(([name, value]) => ({ name, value })),
    };
    let id: string;
    if (replyToId) {
      // createReply keeps In-Reply-To / References and the conversation; we then replace body and recipients.
      const created = await this.http.post<GraphMessage>(
        `${this.user(address)}/messages/${encodeURIComponent(replyToId)}/${replyAll ? "createReplyAll" : "createReply"}`,
        {},
        IMMUTABLE,
      );
      id = created.data.id;
      await this.http.request(
        "PATCH",
        `${this.user(address)}/messages/${encodeURIComponent(id)}`,
        { body, headers: IMMUTABLE },
      );
    } else {
      const created = await this.http.post<GraphMessage>(
        `${this.user(address)}/messages`,
        body,
        IMMUTABLE,
      );
      id = created.data.id;
    }
    for (const a of draft.attachments) {
      if (a.bytes.length <= SMALL_ATTACHMENT) {
        await this.http.post(
          `${this.user(address)}/messages/${encodeURIComponent(id)}/attachments`,
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: a.name,
            contentType: a.contentType,
            contentBytes: a.bytes.toString("base64"),
            isInline: Boolean(a.inline),
            contentId: a.contentId ?? undefined,
          },
          IMMUTABLE,
        );
      } else {
        await this.uploadLargeAttachment(address, id, a);
      }
    }
    return { id };
  }

  /** Upload session for attachments over 3 MB, in 4 MB chunks (Graph requires multiples of 320 KiB). */
  private async uploadLargeAttachment(
    address: string,
    messageId: string,
    a: OutboundDraft["attachments"][number],
  ) {
    const session = await this.http.post<{ uploadUrl: string }>(
      `${this.user(address)}/messages/${encodeURIComponent(messageId)}/attachments/createUploadSession`,
      {
        AttachmentItem: {
          attachmentType: "file",
          name: a.name,
          size: a.bytes.length,
          contentType: a.contentType,
          isInline: Boolean(a.inline),
          contentId: a.contentId ?? undefined,
        },
      },
      IMMUTABLE,
    );
    const chunk = 320 * 1024 * 12; // 3.75 MB
    for (let start = 0; start < a.bytes.length; start += chunk) {
      const end = Math.min(start + chunk, a.bytes.length);
      const res = await this.fetchImpl(session.data.uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(end - start),
          "Content-Range": `bytes ${start}-${end - 1}/${a.bytes.length}`,
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(a.bytes.subarray(start, end)),
      });
      if (!res.ok && res.status !== 201 && res.status !== 200)
        throw new HttpError(
          res.status,
          session.data.uploadUrl,
          await res.text(),
        );
    }
  }

  async sendDraft(address: string, draftId: string) {
    await this.http.post(
      `${this.user(address)}/messages/${encodeURIComponent(draftId)}/send`,
      undefined,
      IMMUTABLE,
    );
  }
  async deleteDraft(address: string, draftId: string) {
    try {
      await this.http.request(
        "DELETE",
        `${this.user(address)}/messages/${encodeURIComponent(draftId)}`,
        { headers: IMMUTABLE },
      );
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) throw err;
    }
  }
  webLink(message: GraphMessage) {
    const link = (message as { webLink?: string }).webLink;
    return typeof link === "string" ? link : null;
  }
}
