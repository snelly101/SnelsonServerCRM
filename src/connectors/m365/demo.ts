import { randomUUID } from "node:crypto";
import type {
  GraphAttachment,
  GraphDeltaPage,
  GraphFolder,
  GraphMessage,
  GraphSubscription,
  M365Client,
  OutboundDraft,
} from "./types";

/**
 * DEMO / TEST adapter: an in-memory mailbox that behaves like Graph for the
 * pieces the CRM uses. Tests push inbound mail with `simulateInbound`, read
 * what was sent from `sent`, and can flip `failNext` to simulate throttling,
 * auth failures or ambiguous send timeouts. Never reports as connected.
 */
type Stored = GraphMessage & {
  folderId: string;
  attachments: (GraphAttachment & { bytes?: Buffer })[];
};

export class DemoM365Client implements M365Client {
  readonly mode = "demo" as const;
  readonly address: string;
  private messages = new Map<string, Stored>();
  private order: string[] = [];
  private subscriptions = new Map<string, GraphSubscription>();
  private deltaCursors = new Map<string, number>();
  /** Outbox drafts by id. */
  private drafts = new Map<string, Stored>();
  /** Messages that were sent (also kept in the sentitems folder). */
  readonly sent: Stored[] = [];
  /** Queue of simulated failures for the next calls: "throttle" (429), "auth" (401), "timeout" (send accepted but the call errors). */
  failNext: ("throttle" | "auth" | "timeout" | "server")[] = [];
  private seq = 0;

  constructor(address = "support@example.com") {
    this.address = address.toLowerCase();
  }

  private maybeFail(op: string) {
    const f = this.failNext.shift();
    if (!f) return;
    if (f === "throttle")
      throw Object.assign(new Error(`HTTP 429 ${op}`), { status: 429 });
    if (f === "auth")
      throw Object.assign(
        new Error(`HTTP 401 ${op}: InvalidAuthenticationToken`),
        { status: 401 },
      );
    if (f === "server")
      throw Object.assign(new Error(`HTTP 503 ${op}`), { status: 503 });
    throw Object.assign(new Error(`network timeout during ${op}`), {
      code: "ETIMEDOUT",
    });
  }

  /** Puts a message in the inbox as if it had just arrived. Returns its immutable id. */
  simulateInbound(input: {
    from: { name?: string; email: string };
    to?: string[];
    cc?: string[];
    subject: string;
    text?: string;
    html?: string;
    internetMessageId?: string;
    inReplyTo?: string | null;
    references?: string[];
    conversationId?: string | null;
    headers?: Record<string, string>;
    attachments?: {
      name: string;
      contentType: string;
      bytes: Buffer;
      inline?: boolean;
      contentId?: string;
    }[];
    receivedAt?: Date;
    folderId?: string;
  }) {
    const id = `AAMk-demo-${++this.seq}-${randomUUID().slice(0, 8)}`;
    const internetMessageId =
      input.internetMessageId ??
      `<${randomUUID()}@${input.from.email.split("@")[1] ?? "example.com"}>`;
    const headers = Object.entries(input.headers ?? {}).map(
      ([name, value]) => ({ name, value }),
    );
    if (input.inReplyTo)
      headers.push({ name: "In-Reply-To", value: input.inReplyTo });
    if (input.references?.length)
      headers.push({ name: "References", value: input.references.join(" ") });
    const msg: Stored = {
      id,
      folderId: input.folderId ?? "inbox",
      internetMessageId,
      conversationId:
        input.conversationId ?? `conv-${randomUUID().slice(0, 8)}`,
      subject: input.subject,
      receivedDateTime: (input.receivedAt ?? new Date()).toISOString(),
      sentDateTime: (input.receivedAt ?? new Date()).toISOString(),
      from: {
        emailAddress: { address: input.from.email, name: input.from.name },
      },
      sender: {
        emailAddress: { address: input.from.email, name: input.from.name },
      },
      toRecipients: (input.to ?? [this.address]).map((a) => ({
        emailAddress: { address: a },
      })),
      ccRecipients: (input.cc ?? []).map((a) => ({
        emailAddress: { address: a },
      })),
      body: input.html
        ? { contentType: "html", content: input.html }
        : { contentType: "text", content: input.text ?? "" },
      bodyPreview: (input.text ?? input.html ?? "").slice(0, 100),
      hasAttachments: Boolean(input.attachments?.length),
      isDraft: false,
      isRead: false,
      internetMessageHeaders: [
        { name: "Message-ID", value: internetMessageId },
        ...headers,
      ],
      attachments: (input.attachments ?? []).map((a, i) => ({
        id: `att-${id}-${i}`,
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: a.name,
        contentType: a.contentType,
        size: a.bytes.length,
        isInline: Boolean(a.inline),
        contentId: a.contentId ?? null,
        bytes: a.bytes,
      })),
    };
    this.messages.set(id, msg);
    this.order.push(id);
    return id;
  }

  async testMailbox(address: string) {
    this.maybeFail("testMailbox");
    if (address.toLowerCase() !== this.address)
      return {
        ok: false as const,
        error: `Mailbox ${address} not found in the demo tenant`,
        status: 404,
      };
    return {
      ok: true as const,
      displayName: "Demo Support",
      userId: "demo-user",
      canRead: true,
      canSend: true,
    };
  }
  async listFolders(): Promise<GraphFolder[]> {
    return [
      { id: "inbox", displayName: "Inbox", totalItemCount: this.order.length },
      {
        id: "sentitems",
        displayName: "Sent Items",
        totalItemCount: this.sent.length,
      },
      { id: "junkemail", displayName: "Junk Email" },
      { id: "archive", displayName: "Archive" },
    ];
  }
  async deltaMessages(
    _address: string,
    folderId: string,
    link: string | null,
    since: Date | null,
  ): Promise<GraphDeltaPage> {
    this.maybeFail("delta");
    if (link === "expired")
      throw Object.assign(new Error("HTTP 410 Gone: SyncStateNotFound"), {
        status: 410,
      });
    const cursorKey = `${folderId}`;
    let start = link ? Number(link.replace(/^cursor:/, "")) : 0;
    if (!link && since)
      start = this.order.findIndex(
        (id) => new Date(this.messages.get(id)!.receivedDateTime!) >= since,
      );
    if (start < 0) start = this.order.length;
    const ids = this.order
      .slice(start)
      .filter((id) => this.messages.get(id)!.folderId === folderId);
    const page = ids.slice(0, 50).map((id) => ({ ...this.messages.get(id)! }));
    const consumed = start + Math.min(50, this.order.slice(start).length);
    this.deltaCursors.set(cursorKey, consumed);
    const more = consumed < this.order.length;
    return {
      messages: page,
      nextLink: more ? `cursor:${consumed}` : null,
      deltaLink: more ? null : `cursor:${consumed}`,
    };
  }
  async getMessage(_address: string, id: string) {
    this.maybeFail("getMessage");
    const m =
      this.messages.get(id) ??
      this.drafts.get(id) ??
      this.sent.find((s) => s.id === id);
    return m ? { ...m } : null;
  }
  async listAttachments(_address: string, messageId: string) {
    const m =
      this.messages.get(messageId) ?? this.sent.find((s) => s.id === messageId);
    return (m?.attachments ?? []).map((a) => {
      const { bytes, ...rest } = a;
      void bytes;
      return rest;
    });
  }
  async getAttachmentBytes(
    _address: string,
    messageId: string,
    attachmentId: string,
  ) {
    const m =
      this.messages.get(messageId) ?? this.sent.find((s) => s.id === messageId);
    return m?.attachments.find((a) => a.id === attachmentId)?.bytes ?? null;
  }
  async findByInternetMessageId(_address: string, internetMessageId: string) {
    const m = [...this.messages.values(), ...this.sent].find(
      (x) => x.internetMessageId === internetMessageId,
    );
    return m ? { ...m } : null;
  }
  async createSubscription(
    address: string,
    folderId: string,
    notificationUrl: string,
    lifecycleUrl: string,
    clientState: string,
    expiresAt: Date,
  ) {
    this.maybeFail("createSubscription");
    const sub: GraphSubscription = {
      id: `sub-${randomUUID().slice(0, 8)}`,
      resource: `/users/${address}/mailFolders('${folderId}')/messages`,
      changeType: "created",
      expirationDateTime: expiresAt.toISOString(),
      clientState,
      notificationUrl,
      lifecycleNotificationUrl: lifecycleUrl,
    };
    this.subscriptions.set(sub.id, sub);
    return sub;
  }
  async renewSubscription(id: string, expiresAt: Date) {
    this.maybeFail("renewSubscription");
    const sub = this.subscriptions.get(id);
    if (!sub)
      throw Object.assign(new Error("HTTP 404 subscription not found"), {
        status: 404,
      });
    sub.expirationDateTime = expiresAt.toISOString();
    return sub;
  }
  async deleteSubscription(id: string) {
    this.subscriptions.delete(id);
  }
  listSubscriptions() {
    return [...this.subscriptions.values()];
  }
  async createDraft(
    _address: string,
    draft: OutboundDraft,
    replyToId: string | null,
    replyAll: boolean,
  ) {
    // A simulated timeout applies to the send call, not to draft creation.
    if (this.failNext[0] !== "timeout") this.maybeFail("createDraft");
    const id = `AAMk-draft-${++this.seq}`;
    void replyAll;
    const original = replyToId
      ? (this.messages.get(replyToId) ??
        this.sent.find((s) => s.id === replyToId))
      : null;
    const internetMessageId = `<${randomUUID()}@demo.local>`;
    const headers = Object.entries(draft.headers).map(([name, value]) => ({
      name,
      value,
    }));
    headers.push({ name: "Message-ID", value: internetMessageId });
    if (original?.internetMessageId) {
      headers.push({ name: "In-Reply-To", value: original.internetMessageId });
      const refs = original.internetMessageHeaders?.find(
        (h) => h.name === "References",
      )?.value;
      headers.push({
        name: "References",
        value: `${refs ? `${refs} ` : ""}${original.internetMessageId}`,
      });
    }
    const m: Stored = {
      id,
      folderId: "drafts",
      internetMessageId,
      conversationId:
        original?.conversationId ?? `conv-${randomUUID().slice(0, 8)}`,
      subject: draft.subject,
      from: { emailAddress: { address: this.address, name: "Demo Support" } },
      toRecipients: draft.to.map((r) => ({
        emailAddress: { address: r.email, name: r.name ?? undefined },
      })),
      ccRecipients: draft.cc.map((r) => ({
        emailAddress: { address: r.email, name: r.name ?? undefined },
      })),
      bccRecipients: draft.bcc.map((r) => ({
        emailAddress: { address: r.email, name: r.name ?? undefined },
      })),
      body: { contentType: "html", content: draft.html },
      bodyPreview: draft.text.slice(0, 100),
      isDraft: true,
      hasAttachments: draft.attachments.length > 0,
      internetMessageHeaders: headers,
      attachments: draft.attachments.map((a, i) => ({
        id: `att-${id}-${i}`,
        name: a.name,
        contentType: a.contentType,
        size: a.bytes.length,
        isInline: Boolean(a.inline),
        contentId: a.contentId ?? null,
        bytes: a.bytes,
      })),
    };
    this.drafts.set(id, m);
    return { id };
  }
  async sendDraft(_address: string, draftId: string) {
    const d = this.drafts.get(draftId);
    if (!d)
      throw Object.assign(new Error("HTTP 404 draft not found"), {
        status: 404,
      });
    // A simulated timeout still sends (Microsoft accepted it) but the caller never learns.
    const f = this.failNext[0];
    d.isDraft = false;
    d.folderId = "sentitems";
    d.sentDateTime = new Date().toISOString();
    this.drafts.delete(draftId);
    this.sent.push(d);
    if (f === "timeout") this.maybeFail("send");
    else this.maybeFail("send");
  }
  async deleteDraft(_address: string, draftId: string) {
    this.drafts.delete(draftId);
  }
  webLink() {
    return null;
  }
  /** Test helper: what is still sitting in Drafts. */
  draftIds() {
    return [...this.drafts.keys()];
  }
}
