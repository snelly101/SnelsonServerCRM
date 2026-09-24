/**
 * Microsoft Graph shapes (subset) for the support mailbox. App-only auth
 * (client credentials) with application permissions Mail.ReadWrite and
 * Mail.Send, scoped to the support mailbox with an Exchange application
 * access policy or RBAC for Applications (see docs/helpdesk-m365.md).
 * Immutable ids are requested on every read (`Prefer: IdType="ImmutableId"`)
 * so a message keeps its id when it moves between folders.
 */
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
export const loginUrl = (tenantId: string) =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;

export type GraphRecipient = {
  emailAddress: { name?: string | null; address: string };
};
export type GraphHeader = { name: string; value: string };

export type GraphMessage = {
  id: string;
  internetMessageId?: string | null;
  conversationId?: string | null;
  conversationIndex?: string | null;
  subject?: string | null;
  receivedDateTime?: string | null;
  sentDateTime?: string | null;
  from?: GraphRecipient | null;
  sender?: GraphRecipient | null;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  replyTo?: GraphRecipient[];
  body?: { contentType: "text" | "html"; content: string } | null;
  bodyPreview?: string | null;
  hasAttachments?: boolean;
  isDraft?: boolean;
  isRead?: boolean;
  parentFolderId?: string | null;
  internetMessageHeaders?: GraphHeader[];
  "@removed"?: { reason: string };
  [k: string]: unknown;
};

export type GraphAttachment = {
  id: string;
  "@odata.type"?: string;
  name: string;
  contentType?: string | null;
  size?: number;
  isInline?: boolean;
  contentId?: string | null;
  /** Present for fileAttachment when fetched with content. */
  contentBytes?: string | null;
  [k: string]: unknown;
};

export type GraphFolder = {
  id: string;
  displayName: string;
  parentFolderId?: string | null;
  totalItemCount?: number;
  unreadItemCount?: number;
};
export type GraphSubscription = {
  id: string;
  resource: string;
  changeType: string;
  expirationDateTime: string;
  clientState?: string | null;
  notificationUrl: string;
  lifecycleNotificationUrl?: string | null;
};
export type GraphDeltaPage = {
  messages: GraphMessage[];
  nextLink: string | null;
  deltaLink: string | null;
};

export type OutboundDraft = {
  subject: string;
  html: string;
  text: string;
  to: { name?: string | null; email: string }[];
  cc: { name?: string | null; email: string }[];
  bcc: { name?: string | null; email: string }[];
  /** Custom headers; Graph only accepts names starting with x- / X-. */
  headers: Record<string, string>;
  attachments: {
    name: string;
    contentType: string;
    bytes: Buffer;
    contentId?: string | null;
    inline?: boolean;
  }[];
};

export interface M365Client {
  readonly mode: "live" | "demo";
  /** Confirms the app can read the mailbox: identity plus a one-message inbox read. */
  testMailbox(
    address: string,
  ): Promise<
    | {
        ok: true;
        displayName: string | null;
        userId: string;
        canRead: boolean;
        canSend: boolean | null;
      }
    | { ok: false; error: string; status?: number }
  >;
  listFolders(address: string): Promise<GraphFolder[]>;
  /** One page of a delta query; pass `link` (next or delta) to continue, null to start from `since`. */
  deltaMessages(
    address: string,
    folderId: string,
    link: string | null,
    since: Date | null,
  ): Promise<GraphDeltaPage>;
  getMessage(address: string, id: string): Promise<GraphMessage | null>;
  listAttachments(
    address: string,
    messageId: string,
  ): Promise<GraphAttachment[]>;
  getAttachmentBytes(
    address: string,
    messageId: string,
    attachmentId: string,
  ): Promise<Buffer | null>;
  findByInternetMessageId(
    address: string,
    internetMessageId: string,
  ): Promise<GraphMessage | null>;
  createSubscription(
    address: string,
    folderId: string,
    notificationUrl: string,
    lifecycleUrl: string,
    clientState: string,
    expiresAt: Date,
  ): Promise<GraphSubscription>;
  renewSubscription(id: string, expiresAt: Date): Promise<GraphSubscription>;
  deleteSubscription(id: string): Promise<void>;
  /** Creates a draft (a reply to `replyToId` when given, preserving threading headers) and returns its immutable id. */
  createDraft(
    address: string,
    draft: OutboundDraft,
    replyToId: string | null,
    replyAll: boolean,
  ): Promise<{ id: string }>;
  /** Sends a draft; Graph answers 202 and moves it to Sent Items with the same immutable id. */
  sendDraft(address: string, draftId: string): Promise<void>;
  deleteDraft(address: string, draftId: string): Promise<void>;
  /** Deep link to the message in Outlook on the web. */
  webLink(message: GraphMessage): string | null;
}

export function recipient(
  r: GraphRecipient | null | undefined,
): { name: string | null; email: string } | null {
  const addr = r?.emailAddress?.address?.trim().toLowerCase();
  if (!addr) return null;
  return { name: r?.emailAddress?.name?.trim() || null, email: addr };
}
export function recipients(list: GraphRecipient[] | undefined | null) {
  return (list ?? [])
    .map(recipient)
    .filter((r): r is { name: string | null; email: string } => Boolean(r));
}
export function header(msg: GraphMessage, name: string): string | null {
  const h = msg.internetMessageHeaders?.find(
    (x) => x.name.toLowerCase() === name.toLowerCase(),
  );
  return h?.value ?? null;
}
/** Splits a References header into message ids (angle-bracketed, whitespace separated). */
export function splitReferences(v: string | null | undefined): string[] {
  if (!v) return [];
  return [...v.matchAll(/<[^<>\s]+>/g)].map((m) => m[0]);
}
export function normalizeMessageId(
  v: string | null | undefined,
): string | null {
  if (!v) return null;
  const m = v.trim().match(/<[^<>\s]+>/);
  return m ? m[0] : `<${v.trim().replace(/^<|>$/g, "")}>`;
}
