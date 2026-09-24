import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

/**
 * Helpdesk demo data: two teams, a category tree and a handful of tickets in
 * different states so queues, the dashboard and the browser tests have
 * content. Idempotent: skips when any ticket exists.
 */
export async function seedHelpdesk(
  db: NodePgDatabase<typeof schema>,
  userIds: Record<string, string>,
) {
  const existing = await db
    .select({ id: schema.tickets.id })
    .from(schema.tickets)
    .limit(1);
  if (existing.length) return;
  const tech = userIds["tech@example.com"];
  const am = userIds["am@example.com"];
  const admin = userIds["admin@example.com"];

  const [serviceDesk] = await db
    .insert(schema.helpdeskTeams)
    .values({
      name: "Service desk",
      description: "First line: triage, passwords, printers, M365",
    })
    .returning({ id: schema.helpdeskTeams.id });
  const [projects] = await db
    .insert(schema.helpdeskTeams)
    .values({
      name: "Projects & infrastructure",
      description: "Servers, networks, migrations",
    })
    .returning({ id: schema.helpdeskTeams.id });
  await db.insert(schema.helpdeskTeamMembers).values([
    { teamId: serviceDesk.id, userId: tech, isLead: true },
    { teamId: serviceDesk.id, userId: am, isLead: false },
    { teamId: projects.id, userId: tech, isLead: false },
    { teamId: projects.id, userId: admin, isLead: true },
  ]);

  const cats: Record<string, string> = {};
  for (const [name, children] of [
    ["Microsoft 365", ["Email", "Teams", "Licensing"]],
    ["Hardware", ["Laptop", "Printer", "Phone"]],
    ["Network", ["VPN", "Wi-Fi", "Firewall"]],
    ["Security", ["Phishing", "Access request"]],
    ["Accounts", ["Password reset", "New starter", "Leaver"]],
  ] as const) {
    const [c] = await db
      .insert(schema.helpdeskCategories)
      .values({ name, sortOrder: Object.keys(cats).length })
      .returning({ id: schema.helpdeskCategories.id });
    cats[name] = c.id;
    let i = 0;
    for (const child of children) {
      const [s] = await db
        .insert(schema.helpdeskCategories)
        .values({ name: child, parentId: c.id, sortOrder: i++ })
        .returning({ id: schema.helpdeskCategories.id });
      cats[`${name}/${child}`] = s.id;
    }
  }

  const company = async (name: string) =>
    (
      await db
        .select({ id: schema.companies.id })
        .from(schema.companies)
        .where(eq(schema.companies.name, name))
        .limit(1)
    )[0];
  const contact = async (companyId: string, first: string) =>
    (
      await db
        .select({
          id: schema.contacts.id,
          email: schema.contacts.email,
          firstName: schema.contacts.firstName,
          lastName: schema.contacts.lastName,
        })
        .from(schema.contacts)
        .where(eq(schema.contacts.companyId, companyId))
    )?.find((c) => c.firstName === first);
  const hours = (n: number) => new Date(Date.now() - n * 3600000);

  type Spec = {
    company: string;
    contactFirst?: string;
    subject: string;
    status: (typeof schema.tickets)["$inferInsert"]["status"];
    priority: (typeof schema.tickets)["$inferInsert"]["priority"];
    type?: (typeof schema.tickets)["$inferInsert"]["type"];
    category: string;
    sub?: string;
    assignee?: string | null;
    team?: string | null;
    ageHours: number;
    tags?: string[];
    body: string;
    replies?: {
      by: "agent" | "customer" | "note";
      body: string;
      hoursAgo: number;
    }[];
    resolution?: string;
    firstResponseDueHours?: number;
    resolutionDueHours?: number;
  };
  const specs: Spec[] = [
    {
      company: "Harrowgate Dental Practice",
      contactFirst: "Priya",
      subject: "Reception PC cannot open the practice management software",
      status: "in_progress",
      priority: "high",
      category: "Hardware",
      sub: "Laptop",
      assignee: tech,
      team: serviceDesk.id,
      ageHours: 5,
      tags: ["dentally"],
      body: "Since this morning the reception PC shows *Cannot connect to database* when we open Dentally. The other two PCs are fine.",
      replies: [
        {
          by: "agent",
          body: "Thanks Priya, I can see the reception PC dropped off the network at 08:40. Looking at the switch port now.",
          hoursAgo: 4,
        },
        {
          by: "note",
          body: "Port 12 on the reception switch flapping; likely cable. Asked Terry to take a spare on the next visit.",
          hoursAgo: 3,
        },
      ],
      firstResponseDueHours: -4,
      resolutionDueHours: 3,
    },
    {
      company: "Northern Freight Solutions Ltd",
      contactFirst: "Dev",
      subject: "VPN drops every 20 minutes for remote drivers",
      status: "awaiting_customer",
      priority: "normal",
      type: "problem",
      category: "Network",
      sub: "VPN",
      assignee: tech,
      team: serviceDesk.id,
      ageHours: 30,
      tags: ["vpn"],
      body: "Three drivers report the VPN disconnecting roughly every 20 minutes when on 4G. Office Wi-Fi is fine.",
      replies: [
        {
          by: "agent",
          body: "Could you send me the client log from one of the affected laptops? Settings → Diagnostics → Export.",
          hoursAgo: 26,
        },
      ],
      resolutionDueHours: 40,
    },
    {
      company: "Ridgeway Architects LLP",
      contactFirst: "Chloe",
      subject: "New starter: Jamie Cole, starts Monday",
      status: "open",
      priority: "normal",
      type: "service_request",
      category: "Accounts",
      sub: "New starter",
      assignee: null,
      team: serviceDesk.id,
      ageHours: 8,
      tags: ["onboarding"],
      body: "Please set up Jamie Cole (architect) with M365 Business Standard, Revit access and a laptop from stock. Starts Monday 9am.",
      firstResponseDueHours: 2,
      resolutionDueHours: 60,
    },
    {
      company: "Greenfield Primary Academy",
      contactFirst: "James",
      subject: "Suspicious email claiming to be from the head teacher",
      status: "resolved",
      priority: "critical",
      category: "Security",
      sub: "Phishing",
      assignee: admin,
      team: serviceDesk.id,
      ageHours: 50,
      tags: ["phishing"],
      body: "Several staff received an email from 'Sarah Okafor' asking them to buy gift cards. It came from a gmail address.",
      replies: [
        {
          by: "agent",
          body: "This is a phishing attempt, not a compromised account. I have blocked the sender across the tenant and reported it to Microsoft. Please tell staff to delete it and not reply.",
          hoursAgo: 48,
        },
        {
          by: "customer",
          body: "Thank you, all staff informed.",
          hoursAgo: 47,
        },
      ],
      resolution:
        "Phishing from an external Gmail address. Sender blocked tenant-wide, message purged from all mailboxes, staff reminded of the gift-card scam pattern. No credentials entered.",
    },
    {
      company: "Bramley & Sons Accountants",
      contactFirst: "Helen",
      subject: "Printer offline in the meeting room",
      status: "new",
      priority: "low",
      category: "Hardware",
      sub: "Printer",
      assignee: null,
      team: null,
      ageHours: 1,
      body: "The Canon in the meeting room says offline again. It worked yesterday.",
      firstResponseDueHours: 7,
    },
    {
      company: "Northern Freight Solutions Ltd",
      contactFirst: "Lucy",
      subject: "Add 2 Business Premium licences for the new dispatch team",
      status: "awaiting_third_party",
      priority: "normal",
      type: "service_request",
      category: "Microsoft 365",
      sub: "Licensing",
      assignee: am,
      team: serviceDesk.id,
      ageHours: 20,
      body: "Two new dispatchers start next week; please add licences and set up mailboxes.",
      replies: [
        {
          by: "agent",
          body: "Ordered through Pax8; provisioning usually completes within a couple of hours. I will confirm once they show in the tenant.",
          hoursAgo: 18,
        },
      ],
    },
    {
      company: "Harrowgate Dental Practice",
      contactFirst: "Tom",
      subject:
        "X-ray workstation needs Windows 11 upgrade before the software update",
      status: "open",
      priority: "normal",
      type: "change",
      category: "Hardware",
      sub: "Laptop",
      assignee: tech,
      team: projects.id,
      ageHours: 70,
      tags: ["upgrade"],
      body: "The imaging vendor needs Windows 11 for their next release. Can we schedule the upgrade outside surgery hours?",
      replies: [
        {
          by: "note",
          body: "Hardware is compatible (8th gen i5, TPM 2.0). Propose Thursday 18:00.",
          hoursAgo: 60,
        },
      ],
    },
    {
      company: "Greenfield Primary Academy",
      contactFirst: "Sarah",
      subject: "Wi-Fi weak in the Year 3 classroom",
      status: "closed",
      priority: "low",
      category: "Network",
      sub: "Wi-Fi",
      assignee: tech,
      team: serviceDesk.id,
      ageHours: 200,
      body: "Laptops in Year 3 keep dropping off the Wi-Fi at the far end of the room.",
      replies: [
        {
          by: "agent",
          body: "Added an access point in the corridor outside Year 3 and rebalanced the channels.",
          hoursAgo: 150,
        },
      ],
      resolution:
        "Additional AP installed; signal now above -60 dBm across the room.",
    },
  ];

  for (const s of specs) {
    const co = await company(s.company);
    if (!co) continue;
    const ct = s.contactFirst
      ? await contact(co.id, s.contactFirst)
      : undefined;
    const requesterName = ct ? `${ct.firstName} ${ct.lastName}` : null;
    const requesterEmail = ct?.email?.toLowerCase() ?? null;
    const created = hours(s.ageHours);
    const agentReplies = (s.replies ?? []).filter((r) => r.by === "agent");
    const firstResponse = agentReplies.length
      ? hours(Math.max(...agentReplies.map((r) => r.hoursAgo)))
      : null;
    const lastCustomer = [
      created,
      ...(s.replies ?? [])
        .filter((r) => r.by === "customer")
        .map((r) => hours(r.hoursAgo)),
    ].sort((a, b) => b.getTime() - a.getTime())[0];
    const resolvedAt =
      s.status === "resolved" || s.status === "closed"
        ? hours(
            Math.min(...(s.replies ?? []).map((r) => r.hoursAgo), s.ageHours) -
              1,
          )
        : null;
    const [t] = await db
      .insert(schema.tickets)
      .values({
        subject: s.subject,
        description: s.body,
        status: s.status,
        priority: s.priority,
        type: s.type ?? "incident",
        source: "email",
        categoryId: cats[s.category],
        subcategoryId: s.sub ? cats[`${s.category}/${s.sub}`] : null,
        tags: s.tags ?? [],
        requesterName,
        requesterEmail,
        requesterNormalizedEmail: requesterEmail,
        requesterContactId: ct?.id ?? null,
        companyId: co.id,
        assigneeUserId: s.assignee ?? null,
        teamId: s.team ?? null,
        firstResponseAt: firstResponse,
        firstResponseDueAt:
          s.firstResponseDueHours !== undefined
            ? new Date(Date.now() + s.firstResponseDueHours * 3600000)
            : null,
        resolutionDueAt:
          s.resolutionDueHours !== undefined
            ? new Date(Date.now() + s.resolutionDueHours * 3600000)
            : null,
        firstResponseBreached:
          s.firstResponseDueHours !== undefined &&
          s.firstResponseDueHours < 0 &&
          !firstResponse,
        resolvedAt,
        closedAt: s.status === "closed" ? resolvedAt : null,
        resolutionSummary: s.resolution ?? null,
        resolutionCategory: s.resolution ? "fixed" : null,
        lastCustomerMessageAt: lastCustomer,
        lastAgentMessageAt: agentReplies.length
          ? hours(Math.min(...agentReplies.map((r) => r.hoursAgo)))
          : null,
        lastActivityAt: hours(
          Math.min(s.ageHours, ...(s.replies ?? []).map((r) => r.hoursAgo)),
        ),
        createdAt: created,
        createdByUserId: null,
        timeSpentMinutes:
          s.status === "resolved" || s.status === "closed" ? 45 : 0,
      })
      .returning({ id: schema.tickets.id, number: schema.tickets.number });
    if (requesterEmail)
      await db
        .insert(schema.ticketParticipants)
        .values({
          ticketId: t.id,
          role: "requester",
          name: requesterName,
          email: requesterEmail,
          normalizedEmail: requesterEmail,
          contactId: ct?.id ?? null,
        });
    await db
      .insert(schema.ticketMessages)
      .values({
        ticketId: t.id,
        kind: "public",
        channel: "email",
        direction: "inbound",
        at: created,
        fromName: requesterName,
        fromEmail: requesterEmail,
        toRecipients: [{ email: "support@snelsonserver.com" }],
        subject: s.subject,
        bodyText: s.body,
        bodyMarkdown: s.body,
        createdAt: created,
      });
    for (const r of s.replies ?? []) {
      const at = hours(r.hoursAgo);
      const byAgent = r.by !== "customer";
      const author = r.by === "customer" ? null : (s.assignee ?? admin);
      await db
        .insert(schema.ticketMessages)
        .values({
          ticketId: t.id,
          kind: r.by === "note" ? "internal" : "public",
          channel: r.by === "note" ? "note" : "email",
          direction:
            r.by === "note" ? "internal" : byAgent ? "outbound" : "inbound",
          at,
          authorUserId: author,
          fromName: byAgent ? null : requesterName,
          fromEmail: byAgent ? "support@snelsonserver.com" : requesterEmail,
          toRecipients:
            byAgent && r.by !== "note" ? [{ email: requesterEmail ?? "" }] : [],
          subject: `Re: [IT-${String(t.number).padStart(6, "0")}] ${s.subject}`,
          bodyText: r.body,
          bodyMarkdown: r.body,
          deliveryStatus:
            byAgent && r.by !== "note" ? "accepted" : "not_applicable",
          createdAt: at,
        });
    }
    await db
      .insert(schema.ticketEvents)
      .values({
        ticketId: t.id,
        at: created,
        actorType: "email",
        kind: "created",
        summary: `Ticket IT-${String(t.number).padStart(6, "0")} created (email)`,
        details: { source: "email" },
      });
    if (s.assignee)
      await db
        .insert(schema.ticketEvents)
        .values({
          ticketId: t.id,
          at: new Date(created.getTime() + 600000),
          actorType: "user",
          actorUserId: admin,
          kind: "assignee",
          summary: "Assigned",
          details: { to: s.assignee },
        });
    if (resolvedAt) {
      await db
        .insert(schema.ticketEvents)
        .values({
          ticketId: t.id,
          at: resolvedAt,
          actorType: "user",
          actorUserId: s.assignee ?? admin,
          kind: "resolve",
          summary: "Open → Resolved",
          details: { from: "open", to: "resolved" },
        });
      await db
        .insert(schema.ticketTimeEntries)
        .values({
          ticketId: t.id,
          userId: s.assignee ?? admin,
          minutes: 45,
          note: "Investigation and fix",
          createdAt: resolvedAt,
        });
    }
    await db
      .insert(schema.activities)
      .values({
        type: "ticket",
        companyId: co.id,
        contactId: ct?.id ?? null,
        entityType: "ticket",
        entityId: t.id,
        title: `Ticket IT-${String(t.number).padStart(6, "0")} opened: ${s.subject}`,
        at: created,
        source: "helpdesk-email",
      });
  }
}
