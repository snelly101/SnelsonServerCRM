import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  helpdeskMailboxes,
  mailboxInboundQueue,
  mailboxOutbox,
  ticketAttachments,
  ticketMessages,
  tickets,
} from "@/db/schema";
import { createCompany } from "@/services/companies";
import { createContact } from "@/services/contacts";
import { companySchema, contactSchema } from "@/lib/validation";
import { demoM365, resetDemoM365 } from "@/connectors/m365";
import {
  buildClientAssertion,
  certificateThumbprint,
  LiveM365Client,
} from "@/connectors/m365/live";
import {
  enqueueInbound,
  ensureSubscription,
  getDefaultMailbox,
  handleGraphNotifications,
  mailboxHealth,
  processInboundQueue,
  processOutbox,
  replayInbound,
  runDeltaSync,
  sendOutboxRow,
  sendTicketReply,
  sendTestEmail,
  composeNewEmail,
  retryOutbox,
} from "@/services/mailbox";
import { changeStatus, getTicket, listTickets } from "@/services/helpdesk";
import { sanitizeEmailHtml, htmlToText } from "@/lib/email/sanitize";
import { splitQuotedText } from "@/lib/email/quotes";
import { classifyAutomated } from "@/lib/email/automated";
import { checkAttachmentPolicy } from "@/lib/email/storage";
import { generateKeyPairSync } from "node:crypto";
import { makeUser } from "./helpers";

let admin: { id: string; name: string };
let companyId: string;
let mailboxId: string;
const demo = () => demoM365("support@example.com");

async function drain() {
  let total = 0;
  for (let i = 0; i < 5; i++) {
    const r = await processInboundQueue(50);
    total += r.claimed;
    if (r.claimed === 0) break;
  }
  await processOutbox(50);
  return total;
}
async function ticketsFor(email: string) {
  return db
    .select()
    .from(tickets)
    .where(eq(tickets.requesterEmail, email))
    .orderBy(asc(tickets.createdAt), asc(tickets.number));
}

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  process.env.DATA_DIR = `/tmp/crm-test-data-${process.pid}`;
  admin = await makeUser("admin", "mailbox admin");
  companyId = await createCompany(
    companySchema.parse({
      name: "Mailbox Test Co",
      status: "customer",
      website: "mailboxtest.co.uk",
    }),
    admin.id,
  );
  await createContact(
    contactSchema.parse({
      companyId,
      firstName: "Kim",
      lastName: "Customer",
      email: "kim@mailboxtest.co.uk",
    }),
    admin.id,
  );
  const m = (await getDefaultMailbox())!;
  mailboxId = m.id;
  await db
    .update(helpdeskMailboxes)
    .set({ importFrom: new Date(Date.now() - 3600_000) })
    .where(eq(helpdeskMailboxes.id, mailboxId));
});
beforeEach(() => {
  demo().failNext = [];
});

describe("e-mail utilities", () => {
  it("sanitises HTML: drops scripts/styles/handlers, blocks remote images, keeps cid images, and never emits javascript: links", () => {
    const r = sanitizeEmailHtml(
      `<html><head><style>p{}</style></head><body><p onclick="x()">Hi <b>there</b><script>alert(1)</script><img src="https://t.example/pixel.gif"><img src="cid:logo1"><a href="javascript:alert(1)">bad</a> <a href="https://ok.example">ok</a><iframe src="https://x"></iframe></p></body></html>`,
      { resolveCid: (cid) => `cid:${cid}` },
    );
    expect(r.html).not.toMatch(/script|onclick|iframe|<style/);
    expect(r.html).toContain('data-blocked-src="https://t.example/pixel.gif"');
    expect(r.html).toContain('src="cid:logo1"');
    expect(r.html).not.toContain("javascript:");
    expect(r.html).toContain(
      'href="https://ok.example" target="_blank" rel="noopener noreferrer nofollow"',
    );
    expect(r.blockedImages).toBe(1);
    expect(htmlToText("<p>Hello<br>World</p><ul><li>a</li></ul>")).toBe(
      "Hello\nWorld\n- a",
    );
  });
  it("splits quoted history and signatures from replies", () => {
    expect(
      splitQuotedText(
        "Thanks, done.\n\nOn Mon, 1 Sep 2026 at 10:00, Support <support@example.com> wrote:\n> please try again",
      ),
    ).toEqual({
      body: "Thanks, done.",
      quoted:
        "On Mon, 1 Sep 2026 at 10:00, Support <support@example.com> wrote:\n> please try again",
    });
    expect(
      splitQuotedText(
        "Still broken\n\n-----Original Message-----\nFrom: x\nSent: y",
      ).body,
    ).toBe("Still broken");
    expect(splitQuotedText("Fixed now\n-- \nKim\nIT Coordinator").body).toBe(
      "Fixed now",
    );
    expect(splitQuotedText("Just text").quoted).toBeNull();
  });
  it("classifies bounces, out-of-office and bulk mail, and enforces the attachment policy", () => {
    const base = {
      id: "x",
      internetMessageHeaders: [] as { name: string; value: string }[],
    };
    expect(
      classifyAutomated({
        ...base,
        from: { emailAddress: { address: "mailer-daemon@example.com" } },
        subject: "Undeliverable: hi",
      }).kind,
    ).toBe("bounce");
    expect(
      classifyAutomated({
        ...base,
        subject: "Automatic reply: hi",
        from: { emailAddress: { address: "kim@x.com" } },
      }).kind,
    ).toBe("out_of_office");
    expect(
      classifyAutomated({
        ...base,
        subject: "hi",
        from: { emailAddress: { address: "kim@x.com" } },
        internetMessageHeaders: [
          { name: "Auto-Submitted", value: "auto-replied" },
        ],
      }).kind,
    ).toBe("auto_reply");
    expect(
      classifyAutomated({
        ...base,
        subject: "hi",
        from: { emailAddress: { address: "kim@x.com" } },
        internetMessageHeaders: [{ name: "Precedence", value: "bulk" }],
      }).kind,
    ).toBe("bulk");
    expect(
      classifyAutomated({
        ...base,
        subject: "hi",
        from: { emailAddress: { address: "kim@x.com" } },
      }).kind,
    ).toBeNull();
    expect(checkAttachmentPolicy("report.pdf", 1000)).toBeNull();
    expect(checkAttachmentPolicy("setup.exe", 1000)).toMatch(/not accepted/);
    expect(checkAttachmentPolicy("big.zip", 500 * 1024 * 1024)).toMatch(
      /larger/,
    );
  });
  it("builds a certificate client assertion with the x5t thumbprint, and the live client only talks to Graph under the mailbox", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const fakeCert = `-----BEGIN CERTIFICATE-----\n${Buffer.from("not-a-real-der").toString("base64")}\n-----END CERTIFICATE-----`;
    const jwt = buildClientAssertion({
      tenantId: "t",
      clientId: "c",
      privateKeyPem,
      certificatePem: fakeCert,
    });
    const [h, c] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toMatchObject({
      alg: "RS256",
      x5t: certificateThumbprint(fakeCert),
    });
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toMatchObject({
      iss: "c",
      sub: "c",
      aud: "https://login.microsoftonline.com/t/oauth2/v2.0/token",
    });
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (String(url).includes("login.microsoftonline.com"))
        return new Response(
          JSON.stringify({ access_token: "tok", expires_in: 3600 }),
          { headers: { "content-type": "application/json" } },
        );
      return new Response(
        JSON.stringify({ id: "u1", displayName: "Support", value: [] }),
        { headers: { "content-type": "application/json" } },
      );
    };
    const client = new LiveM365Client(
      { tenantId: "t", clientId: "c", authMode: "secret", clientSecret: "s" },
      async () => undefined,
      fetchImpl as unknown as typeof fetch,
    );
    expect((await client.testMailbox("support@x.com")).ok).toBe(true);
    expect(calls[0]).toContain(
      "POST https://login.microsoftonline.com/t/oauth2/v2.0/token",
    );
    expect(
      calls.slice(1).every((c) => c.includes("/users/support%40x.com")),
    ).toBe(true);
  });
});

describe("inbound e-mail → tickets (demo mailbox)", () => {
  it("1. an external e-mail creates exactly one ticket, links the contact and sends one acknowledgement", async () => {
    const id = demo().simulateInbound({
      from: { name: "Kim Customer", email: "kim@mailboxtest.co.uk" },
      subject: "Printer jammed again",
      html: "<p>The <b>Canon</b> is jammed.</p><img src='https://track.example/p.gif'>",
      attachments: [
        {
          name: "photo.png",
          contentType: "image/png",
          bytes: Buffer.from("png-bytes"),
        },
        {
          name: "virus.exe",
          contentType: "application/octet-stream",
          bytes: Buffer.from("mz"),
        },
      ],
    });
    await enqueueInbound(mailboxId, id, "notification");
    await enqueueInbound(mailboxId, id, "delta"); // duplicate signal collapses into the same row
    await drain();
    const rows = await ticketsFor("kim@mailboxtest.co.uk");
    expect(rows).toHaveLength(1);
    const t = (await getTicket(rows[0].id))!;
    expect(t).toMatchObject({
      source: "email",
      requesterName: "Kim Customer",
      companyId,
      requesterUnverified: false,
      status: "new",
      mailboxId,
    });
    expect(t.messages.filter((m) => m.direction === "inbound")).toHaveLength(1);
    const inbound = t.messages.find((m) => m.direction === "inbound")!;
    expect(inbound.bodyHtml).toContain("<b>Canon</b>");
    expect(inbound.bodyHtml).toContain("data-blocked-src");
    expect(inbound.bodyText).toBe("The Canon is jammed.");
    expect(
      inbound.attachments.map((a) => [a.fileName, a.scanStatus]).sort(),
    ).toEqual([
      ["photo.png", "skipped"],
      ["virus.exe", "blocked"],
    ]);
    // Exactly one acknowledgement, marked automated, with the loop-suppression header, and the requester saw it.
    const acks = t.messages.filter(
      (m) => m.isAutomated && m.direction === "outbound",
    );
    expect(acks).toHaveLength(1);
    expect(acks[0].subject).toContain(t.reference);
    expect(acks[0].deliveryStatus).toBe("accepted");
    expect(demo().sent).toHaveLength(1);
    expect(
      demo().sent[0].internetMessageHeaders?.some(
        (h) => h.name === "X-Auto-Response-Suppress",
      ),
    ).toBe(true);
    expect(t.ackSentAt).not.toBeNull();
  });

  it("2. replayed notifications and concurrent processing never duplicate a ticket or message", async () => {
    const id = demo().simulateInbound({
      from: { email: "kim@mailboxtest.co.uk" },
      subject: "Second issue: VPN",
      text: "VPN down",
    });
    await handleGraphNotificationsFor(id);
    await handleGraphNotificationsFor(id);
    await Promise.all([
      processInboundQueue(10),
      processInboundQueue(10),
      processInboundQueue(10),
    ]);
    await drain();
    const rows = await db
      .select()
      .from(tickets)
      .where(eq(tickets.subject, "Second issue: VPN"));
    expect(rows).toHaveLength(1);
    expect(
      await db
        .select()
        .from(ticketMessages)
        .where(
          and(
            eq(ticketMessages.ticketId, rows[0].id),
            eq(ticketMessages.direction, "inbound"),
          ),
        ),
    ).toHaveLength(1);
    // Re-queueing the same provider id later (delta overlap) is a no-op too.
    await db
      .delete(mailboxInboundQueue)
      .where(eq(mailboxInboundQueue.externalMessageId, id));
    await enqueueInbound(mailboxId, id, "delta");
    await drain();
    expect(
      await db
        .select()
        .from(ticketMessages)
        .where(
          and(
            eq(ticketMessages.ticketId, rows[0].id),
            eq(ticketMessages.direction, "inbound"),
          ),
        ),
    ).toHaveLength(1);
    const [q] = await db
      .select()
      .from(mailboxInboundQueue)
      .where(eq(mailboxInboundQueue.externalMessageId, id));
    expect((q.outcome as { action: string }).action).toBe("duplicate");
  });

  it("3 + 4. a CRM reply reaches the requester with threading headers and lands in Sent Items; the requester's reply joins the ticket even with a changed subject", async () => {
    const [t] = await ticketsFor("kim@mailboxtest.co.uk");
    const sentBefore = demo().sent.length;
    const r = await sendTicketReply(
      t.id,
      {
        markdown: "Please **restart** the printer.",
        to: [],
        cc: [],
        bcc: ["boss@mailboxtest.co.uk"],
        replyToMessageId: null,
        attachmentIds: [],
        idempotencyKey: "reply-1",
      },
      { id: admin.id, type: "user", name: admin.name },
    );
    expect(r.reused).toBe(false);
    const sent = demo().sent[sentBefore];
    expect(sent.toRecipients?.[0].emailAddress.address).toBe(
      "kim@mailboxtest.co.uk",
    );
    expect(sent.bccRecipients?.[0].emailAddress.address).toBe(
      "boss@mailboxtest.co.uk",
    );
    expect(sent.subject).toMatch(
      new RegExp(`^Re: \\[${t.number ? "IT-" : ""}`),
    );
    expect(
      sent.internetMessageHeaders?.find((h) => h.name === "In-Reply-To"),
    ).toBeTruthy();
    expect(sent.body?.content).toContain("<strong>restart</strong>");
    expect(sent.body?.content).toContain("Kind regards");
    const after = (await getTicket(t.id))!;
    const out = after.messages.find(
      (m) => m.direction === "outbound" && !m.isAutomated,
    )!;
    expect(out.deliveryStatus).toBe("accepted");
    expect(out.internetMessageId).toBe(sent.internetMessageId);
    expect(after.firstResponseAt).not.toBeNull();
    // Same idempotency key → reused, nothing new sent.
    const again = await sendTicketReply(
      t.id,
      {
        markdown: "dup",
        to: [],
        cc: [],
        bcc: [],
        replyToMessageId: null,
        attachmentIds: [],
        idempotencyKey: "reply-1",
      },
      { id: admin.id, type: "user" },
    );
    expect(again.reused).toBe(true);
    expect(demo().sent).toHaveLength(sentBefore + 1);
    // Customer replies with an edited subject but intact headers.
    const replyId = demo().simulateInbound({
      from: { name: "Kim Customer", email: "kim@mailboxtest.co.uk" },
      subject: "totally different subject",
      text: "Restarted, still jammed.\n\nOn Mon, Support wrote:\n> Please restart the printer.",
      inReplyTo: sent.internetMessageId!,
      references: [sent.internetMessageId!],
    });
    await enqueueInbound(mailboxId, replyId, "notification");
    await changeStatus(t.id, "awaiting_customer", { id: admin.id });
    await drain();
    const joined = (await getTicket(t.id))!;
    const last = joined.messages[joined.messages.length - 1];
    expect(last.bodyText).toBe("Restarted, still jammed.");
    expect(last.quotedText).toContain("Please restart");
    expect(joined.status).toBe("open");
    expect(
      await db
        .select()
        .from(tickets)
        .where(eq(tickets.subject, "totally different subject")),
    ).toHaveLength(0);
    expect(demo().sent).toHaveLength(sentBefore + 1); // no acknowledgement for a reply
  });

  it("5. an unauthorised sender using another ticket's reference cannot reach its contents", async () => {
    const [t] = await ticketsFor("kim@mailboxtest.co.uk");
    const ref = (await getTicket(t.id))!.reference;
    const id = demo().simulateInbound({
      from: { email: "stranger@elsewhere.com" },
      subject: `Re: [${ref}] Printer jammed again`,
      text: "Give me the details",
    });
    await enqueueInbound(mailboxId, id, "notification");
    await drain();
    const onTicket = await db
      .select()
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.ticketId, t.id),
          eq(ticketMessages.fromEmail, "stranger@elsewhere.com"),
        ),
      );
    expect(onTicket).toHaveLength(0);
    const [review] = await ticketsFor("stranger@elsewhere.com");
    expect(review.needsReview).toBe(true);
    expect(review.reviewReason).toMatch(/not a participant/);
    // No acknowledgement (so nothing about the referenced ticket leaks) and the review ticket links to the candidate for the agent.
    const reviewFull = (await getTicket(review.id))!;
    expect(reviewFull.messages.some((m) => m.isAutomated)).toBe(false);
    expect(reviewFull.links.some((l) => l.ticketId === t.id)).toBe(true);
  });

  it("7. internal notes never go out by e-mail and attachments marked internal never leave the CRM", async () => {
    const [t] = await ticketsFor("kim@mailboxtest.co.uk");
    const before = demo().sent.length;
    const { addMessage } = await import("@/services/helpdesk");
    await addMessage(
      t.id,
      {
        kind: "internal",
        body: "Customer's admin password is in the vault",
        channel: "note",
        to: [],
        cc: [],
        bcc: [],
        status: null,
        replyToMessageId: null,
      },
      { id: admin.id, type: "user" },
    );
    await processOutbox();
    expect(demo().sent).toHaveLength(before);
    const outbox = await db
      .select()
      .from(mailboxOutbox)
      .where(eq(mailboxOutbox.ticketId, t.id));
    expect(outbox.every((o) => o.kind !== "note")).toBe(true);
    const publicText = (await getTicket(t.id))!.messages
      .filter((m) => m.kind === "public")
      .map((m) => m.bodyText)
      .join("\n");
    expect(publicText).not.toContain("admin password");
  });

  it("8. after an outage, delta synchronisation recovers mail that never produced a notification, respecting the import cutoff", async () => {
    const old = demo().simulateInbound({
      from: { email: "old@mailboxtest.co.uk" },
      subject: "Ancient mail",
      text: "before the cutoff",
      receivedAt: new Date(Date.now() - 48 * 3600_000),
    });
    const missed = demo().simulateInbound({
      from: { email: "missed@mailboxtest.co.uk" },
      subject: "Missed while down",
      text: "no webhook for this one",
    });
    const m = (await getDefaultMailbox())!;
    const r = await runDeltaSync(m, "manual", admin.id);
    expect(r?.status).toBe("success");
    await drain();
    expect(await ticketsFor("missed@mailboxtest.co.uk")).toHaveLength(1);
    expect(await ticketsFor("old@mailboxtest.co.uk")).toHaveLength(0);
    expect((await getDefaultMailbox())!.deltaLinks.inbox).toMatch(/^cursor:/);
    void old;
    void missed;
    // An expired delta token is reported and the sync restarts instead of failing silently.
    await db
      .update(helpdeskMailboxes)
      .set({ deltaLinks: { inbox: "expired" } })
      .where(eq(helpdeskMailboxes.id, mailboxId));
    const r2 = await runDeltaSync(
      (await getDefaultMailbox())!,
      "manual",
      admin.id,
    );
    expect(r2?.status).toBe("partial");
    expect(r2?.counters.errors).toBe(1);
  });

  it("9. subscription renewal, revoked permissions and throttling are recoverable and visible", async () => {
    const m = (await getDefaultMailbox())!;
    await db
      .update(helpdeskMailboxes)
      .set({ credentialsEnc: "demo", status: "connected" })
      .where(eq(helpdeskMailboxes.id, mailboxId)); // pretend live for the subscription path
    const created = await ensureSubscription(
      (await getDefaultMailbox())!,
      true,
    );
    expect(created.action).toBe("created");
    const withSub = (await getDefaultMailbox())!;
    expect(withSub.subscriptionId).toBeTruthy();
    expect(withSub.subscriptionClientState).toBeTruthy();
    // A notification with the wrong clientState is rejected; the right one is queued.
    const forged = await handleGraphNotifications({
      value: [
        {
          subscriptionId: withSub.subscriptionId!,
          clientState: "nope",
          resourceData: { id: "AAMk-forged" },
        },
      ],
    });
    expect(forged[0].outcome).toMatch(/rejected/);
    expect(
      await db
        .select()
        .from(mailboxInboundQueue)
        .where(eq(mailboxInboundQueue.externalMessageId, "AAMk-forged")),
    ).toHaveLength(0);
    // Near expiry → renewed; Graph losing it → recreated.
    await db
      .update(helpdeskMailboxes)
      .set({ subscriptionExpiresAt: new Date(Date.now() + 3600_000) })
      .where(eq(helpdeskMailboxes.id, mailboxId));
    expect(
      (await ensureSubscription((await getDefaultMailbox())!)).action,
    ).toBe("renewed");
    const lifecycle = await handleGraphNotifications({
      value: [
        {
          subscriptionId: withSub.subscriptionId!,
          clientState: withSub.subscriptionClientState!,
          lifecycleEvent: "subscriptionRemoved",
        },
      ],
    });
    expect(lifecycle[0].outcome).toMatch(/lifecycle/);
    // Revoked permission on the next call flips the mailbox to "expired" with the error visible; a later success clears it.
    demo().failNext = ["auth"];
    const r = await runDeltaSync(
      (await getDefaultMailbox())!,
      "manual",
      admin.id,
    );
    expect(r?.status).toBe("failed");
    expect((await getDefaultMailbox())!.status).toBe("expired");
    const ok = await runDeltaSync(
      (await getDefaultMailbox())!,
      "manual",
      admin.id,
    );
    expect(ok?.status).toBe("success");
    expect((await getDefaultMailbox())!.status).toBe("connected");
    // Throttling during processing retries with backoff rather than losing the message.
    const id = demo().simulateInbound({
      from: { email: "kim@mailboxtest.co.uk" },
      subject: "Throttled",
      text: "x",
    });
    await enqueueInbound(mailboxId, id, "notification");
    demo().failNext = ["throttle"];
    await processInboundQueue();
    const [q] = await db
      .select()
      .from(mailboxInboundQueue)
      .where(eq(mailboxInboundQueue.externalMessageId, id));
    expect(q.status).toBe("pending");
    expect(q.lastError).toMatch(/429/);
    await db
      .update(mailboxInboundQueue)
      .set({ nextAttemptAt: new Date() })
      .where(eq(mailboxInboundQueue.id, q.id));
    await drain();
    expect(
      (
        await db
          .select()
          .from(mailboxInboundQueue)
          .where(eq(mailboxInboundQueue.id, q.id))
      )[0].status,
    ).toBe("done");
    await db
      .update(helpdeskMailboxes)
      .set({ credentialsEnc: null })
      .where(eq(helpdeskMailboxes.id, mailboxId));
    void m;
    const health = (await mailboxHealth())!;
    expect(health.queue.done24h).toBeGreaterThan(0);
  });

  it("10. an ambiguous send timeout is reconciled against the mailbox, never blindly resent; a hard failure retries then surfaces", async () => {
    const [t] = await ticketsFor("kim@mailboxtest.co.uk");
    const before = demo().sent.length;
    demo().failNext = ["timeout"];
    const r = await sendTicketReply(
      t.id,
      {
        markdown: "Timeout test",
        to: [],
        cc: [],
        bcc: [],
        replyToMessageId: null,
        attachmentIds: [],
        idempotencyKey: "reply-timeout",
      },
      { id: admin.id, type: "user" },
    );
    let [ob] = await db
      .select()
      .from(mailboxOutbox)
      .where(eq(mailboxOutbox.id, r.outboxId));
    expect(ob.status).toBe("unknown");
    expect(demo().sent).toHaveLength(before + 1); // Microsoft did accept it
    await db
      .update(mailboxOutbox)
      .set({ nextAttemptAt: new Date() })
      .where(eq(mailboxOutbox.id, ob.id));
    await processOutbox();
    [ob] = await db
      .select()
      .from(mailboxOutbox)
      .where(eq(mailboxOutbox.id, r.outboxId));
    expect(ob.status).toBe("accepted");
    expect(demo().sent).toHaveLength(before + 1); // reconciled, not resent
    // Hard failure: retried with backoff, then failed after the limit with a visible flag on the ticket.
    demo().failNext = ["server"];
    const r2 = await sendTicketReply(
      t.id,
      {
        markdown: "Fails",
        to: [],
        cc: [],
        bcc: [],
        replyToMessageId: null,
        attachmentIds: [],
        idempotencyKey: "reply-fail",
      },
      { id: admin.id, type: "user" },
    );
    let [ob2] = await db
      .select()
      .from(mailboxOutbox)
      .where(eq(mailboxOutbox.id, r2.outboxId));
    expect(ob2.status).toBe("queued");
    expect(ob2.lastError).toMatch(/503/);
    await db
      .update(mailboxOutbox)
      .set({ attempts: 6, nextAttemptAt: new Date() })
      .where(eq(mailboxOutbox.id, ob2.id));
    demo().failNext = ["server"];
    await processOutbox();
    [ob2] = await db
      .select()
      .from(mailboxOutbox)
      .where(eq(mailboxOutbox.id, r2.outboxId));
    expect(ob2.status).toBe("failed");
    expect((await getTicket(t.id))!.needsReview).toBe(true);
    expect(
      (await getTicket(t.id))!.messages.find((m) =>
        m.bodyText.startsWith("Fails"),
      )?.deliveryStatus,
    ).toBe("failed");
    // An admin retry gets it through.
    expect(await retryOutbox(ob2.id, admin.id)).toBe("accepted");
  });

  it("11. bounces and automatic replies never create mail loops or reopen tickets", async () => {
    const [t] = await ticketsFor("kim@mailboxtest.co.uk");
    await changeStatus(
      t.id,
      "resolved",
      { id: admin.id },
      { resolutionSummary: "Printer cleared." },
    );
    const sentBefore = demo().sent.length;
    const lastSent = demo().sent[demo().sent.length - 1];
    const ooo = demo().simulateInbound({
      from: { email: "kim@mailboxtest.co.uk" },
      subject: "Automatic reply: Re: Printer jammed again",
      text: "I am out of the office",
      inReplyTo: lastSent.internetMessageId!,
      headers: { "Auto-Submitted": "auto-replied" },
    });
    const bounce = demo().simulateInbound({
      from: { email: "postmaster@mailboxtest.co.uk" },
      subject: "Undeliverable: Re: Printer jammed again",
      text: `Delivery has failed to these recipients: kim@mailboxtest.co.uk\nOriginal Message-ID: ${lastSent.internetMessageId}`,
    });
    await enqueueInbound(mailboxId, ooo, "notification");
    await enqueueInbound(mailboxId, bounce, "notification");
    await drain();
    const after = (await getTicket(t.id))!;
    expect(after.status).toBe("resolved"); // automated mail does not reopen
    expect(demo().sent).toHaveLength(sentBefore); // nothing sent back
    expect(
      after.messages.some(
        (m) => m.isAutomated && m.automatedReason?.includes("Auto-Submitted"),
      ),
    ).toBe(true);
    expect(
      after.messages.some(
        (m) => m.automatedReason === "bounce" && m.kind === "internal",
      ),
    ).toBe(true);
    expect(after.needsReview).toBe(true);
    expect(after.reviewReason).toMatch(/Delivery failed/);
    const [bouncedOutbox] = await db
      .select()
      .from(mailboxOutbox)
      .where(eq(mailboxOutbox.internetMessageId, lastSent.internetMessageId!));
    expect(bouncedOutbox.lastError).toMatch(/bounced/);
    // Loop guard: a sender hammering the mailbox gets at most a few acknowledgements per hour.
    for (let i = 0; i < 5; i++)
      await enqueueInbound(
        mailboxId,
        demo().simulateInbound({
          from: { email: "loop@bot.example" },
          subject: `Ping ${i}`,
          text: "ping",
        }),
        "notification",
      );
    const s0 = demo().sent.length;
    await drain();
    expect(demo().sent.length - s0).toBe(3);
    // A human reply to the resolved ticket reopens it; a reply to a closed ticket beyond the window opens a follow-up.
    const human = demo().simulateInbound({
      from: { email: "kim@mailboxtest.co.uk" },
      subject: "Re: Printer jammed again",
      text: "It jammed again",
      inReplyTo: lastSent.internetMessageId!,
    });
    await enqueueInbound(mailboxId, human, "notification");
    await drain();
    expect((await getTicket(t.id))!.status).toBe("open");
    await changeStatus(
      t.id,
      "resolved",
      { id: admin.id },
      { resolutionSummary: "Cleared again." },
    );
    await changeStatus(t.id, "closed", { id: admin.id });
    await db
      .update(tickets)
      .set({ closedAt: new Date(Date.now() - 30 * 86400000) })
      .where(eq(tickets.id, t.id));
    const late = demo().simulateInbound({
      from: { email: "kim@mailboxtest.co.uk" },
      subject: "Re: Printer jammed again",
      text: "Months later, same printer",
      inReplyTo: lastSent.internetMessageId!,
    });
    await enqueueInbound(mailboxId, late, "notification");
    await drain();
    expect((await getTicket(t.id))!.status).toBe("closed");
    const followUps = await db
      .select()
      .from(tickets)
      .where(
        eq(
          tickets.subject,
          `Follow-up to ${after.reference}: Re: Printer jammed again`,
        ),
      );
    expect(followUps).toHaveLength(1);
    expect(
      (await getTicket(followUps[0].id))!.links.some(
        (l) => l.ticketId === t.id,
      ),
    ).toBe(true);
  });

  it("6. outbound attachments are sent, blocked uploads are refused, and a merged ticket still receives replies to its old reference", async () => {
    const { storeUpload } = await import("@/services/mailbox");
    const [t] = await ticketsFor("kim@mailboxtest.co.uk");
    const attId = await storeUpload(
      t.id,
      {
        name: "guide.pdf",
        type: "application/pdf",
        bytes: Buffer.from("%PDF-1.4 fake"),
      },
      admin.id,
    );
    await expect(
      storeUpload(
        t.id,
        {
          name: "tool.exe",
          type: "application/octet-stream",
          bytes: Buffer.from("MZ"),
        },
        admin.id,
      ),
    ).rejects.toThrow(/not accepted/);
    const before = demo().sent.length;
    await sendTicketReply(
      t.id,
      {
        markdown: "See the guide.",
        to: [],
        cc: [],
        bcc: [],
        replyToMessageId: null,
        attachmentIds: [attId],
        idempotencyKey: "reply-att",
      },
      { id: admin.id, type: "user" },
    );
    const sent = demo().sent[before];
    expect(sent.attachments.map((a) => a.name)).toEqual(["guide.pdf"]);
    expect(
      (
        await db
          .select()
          .from(ticketAttachments)
          .where(eq(ticketAttachments.id, attId))
      )[0].messageId,
    ).not.toBeNull();
    // Merge → reply to the old reference lands on the survivor.
    const { mergeTickets } = await import("@/services/helpdesk");
    const [other] = await ticketsFor("missed@mailboxtest.co.uk");
    const oldRef = (await getTicket(other.id))!.reference;
    await changeStatus(t.id, "open", { id: admin.id }, { reason: "test" });
    await mergeTickets([other.id], t.id, { id: admin.id });
    const late = demo().simulateInbound({
      from: { email: "missed@mailboxtest.co.uk" },
      subject: `Re: [${oldRef}] Missed while down`,
      text: "following up on the merged one",
    });
    await enqueueInbound(mailboxId, late, "notification");
    await drain();
    const survivor = (await getTicket(t.id))!;
    expect(
      survivor.messages.some(
        (m) => m.bodyText === "following up on the merged one",
      ),
    ).toBe(true);
  });

  it("compose and test e-mails go through the outbox; a test only reaches staff", async () => {
    const r = await composeNewEmail(
      {
        subject: "Planned maintenance",
        markdown: "We will reboot the firewall tonight.",
        to: ["kim@mailboxtest.co.uk"],
        cc: ["ops@mailboxtest.co.uk"],
        bcc: [],
        companyId,
        contactId: null,
        attachmentIds: [],
        idempotencyKey: "compose-1",
      },
      { id: admin.id, type: "user" },
    );
    const t = (await getTicket(r.ticketId))!;
    expect(t.status).toBe("awaiting_customer");
    expect(t.messages[0].subject).toBe(`[${t.reference}] Planned maintenance`);
    expect(
      t.participants.some((p) => p.email === "ops@mailboxtest.co.uk"),
    ).toBe(true);
    await expect(
      sendTestEmail(mailboxId, "kim@mailboxtest.co.uk", admin.id),
    ).rejects.toThrow(/CRM user/);
    const [u] = await db
      .select({ email: (await import("@/db/schema")).user.email })
      .from((await import("@/db/schema")).user)
      .where(eq((await import("@/db/schema")).user.id, admin.id));
    const row = await sendTestEmail(mailboxId, u.email, admin.id);
    expect(row?.status).toBe("accepted");
    expect(
      (await listTickets({ view: "all", q: "Planned maintenance" })).total,
    ).toBe(1);
    resetDemoM365();
  });
});

async function handleGraphNotificationsFor(externalId: string) {
  const m = (await getDefaultMailbox())!;
  if (!m.subscriptionId) {
    await enqueueInbound(m.id, externalId, "notification");
    return;
  }
  await handleGraphNotifications({
    value: [
      {
        subscriptionId: m.subscriptionId,
        clientState: m.subscriptionClientState ?? "",
        resourceData: { id: externalId },
      },
    ],
  });
}
void replayInbound;
void sendOutboxRow;
