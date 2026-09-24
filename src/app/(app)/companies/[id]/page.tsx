import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil, Plus, Globe, Phone, Mail, ArrowRight } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getCompany, getCompanyTimeline } from "@/services/companies";
import { listCustomFieldDefs } from "@/services/settings";
import { getAppSettings } from "@/lib/settings";
import { archiveSiteAction } from "@/actions/companies";
import { archiveContactAction } from "@/actions/contacts";
import { Card, EmptyState } from "@/components/ui/page";
import { ButtonLink } from "@/components/ui/button";
import {
  Badge,
  STATUS_TONES,
  ROLE_LABELS_CONTACT,
} from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { HOSTING_KIND_LABEL } from "@/lib/hosting-format";
import { Alert } from "@/components/ui/alert";
import { SiteDialog } from "@/components/site-dialog";
import { SectionNav, type SectionItem } from "@/components/company/section-nav";
import { CompanyHeaderMenu } from "@/components/company/header-menu";
import { ActivityPanel } from "@/components/company/activity-panel";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { fullName, initials } from "@/lib/utils";
import { listCompanyOpportunities } from "@/services/opportunities";
import { listCompanyContracts } from "@/services/contracts";
import { listTasks } from "@/services/tasks";
import { listOnboardings } from "@/services/onboarding";
import { listOwners } from "@/services/companies";
import { TaskList } from "@/components/task-list";
import { TaskDialog } from "@/components/task-dialog";
import { RevenueSummaryBadges } from "@/components/lines-editor";
import { fmtMoney } from "@/lib/format";
import { listProposals } from "@/services/proposals";
import { ExternalLink } from "lucide-react";
import {
  companyFinancialSummary,
  xeroConnectionSummary,
} from "@/services/xero";
import { fmtRelative } from "@/lib/format";
import { companyDeviceOverview } from "@/services/ninjaone";
import { companyHostingOverview } from "@/services/twentyi";
import { HostingPanel } from "@/components/hosting-panel";
import { listCompanyNotes } from "@/services/notes";
import { NotesPanel } from "@/components/notes/notes-panel";
import { MarkdownLite } from "@/lib/markdown-lite";
import {
  DeviceTable,
  FRESHNESS_LABEL,
  FRESHNESS_TONE,
} from "@/components/device-table";
import { DiscrepancyTable } from "@/app/(app)/devices/discrepancies";
import {
  listCategories,
  listVaultItems,
  resolveCapabilities,
} from "@/services/vault";
import { vaultConfigured } from "@/lib/vault-crypto";
import { VaultPanel } from "@/components/vault/vault-panel";

export default async function CompanyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; archived?: string }>;
}) {
  const me = await requirePermission("company.read");
  const { id } = await params;
  const sp = await searchParams;
  const [
    company,
    timeline,
    defs,
    settings,
    opportunities,
    companyContracts,
    companyTasks,
    onboardingList,
    owners,
    proposalList,
    finance,
    xero,
    devices,
    hosting,
    notes,
  ] = await Promise.all([
    getCompany(id),
    getCompanyTimeline(id),
    listCustomFieldDefs("company"),
    getAppSettings(),
    listCompanyOpportunities(id),
    listCompanyContracts(id),
    listTasks({ companyId: id, status: "all", pageSize: 100 }),
    listOnboardings(id),
    listOwners(),
    listProposals({ companyId: id, pageSize: 50 }),
    can(me.role, "finance.read")
      ? companyFinancialSummary(id)
      : Promise.resolve(null),
    xeroConnectionSummary(),
    can(me.role, "device.read")
      ? companyDeviceOverview(id)
      : Promise.resolve(null),
    companyHostingOverview(id),
    listCompanyNotes(id, {
      includeArchived: sp.archived === "1" && sp.tab === "notes",
    }),
  ]);
  if (!company) notFound();
  const vaultCaps = await resolveCapabilities(me.id, me.role, id);
  const vault = vaultCaps.list
    ? await listVaultItems({ id: me.id, name: me.name, role: me.role }, id, {
        includeArchived: sp.archived === "1",
      })
    : null;
  const vaultCategories = vaultCaps.list ? await listCategories() : [];
  const activeContracts = companyContracts.filter((c) => c.status === "active");
  const mrr = activeContracts.reduce((a, c) => a + c.summary.mrr, 0);
  const openOpps = opportunities.filter((o) => o.status === "open");
  const canWrite = can(me.role, "company.write");
  const openTasks = companyTasks.rows.filter((t) => t.status === "open").length;
  const vaultActive = vault?.items.filter((i) => !i.archivedAt).length ?? 0;
  const hostingCount = hosting
    ? hosting.totals.packages + hosting.totals.domains
    : 0;
  const addressLines = [
    company.addressLine1,
    company.addressLine2,
    [company.city, company.region].filter(Boolean).join(", "),
    [company.postcode, company.country].filter(Boolean).join(", "),
  ].filter(Boolean);
  const plural = (n: number, one: string, many = `${one}s`) =>
    `${n} ${n === 1 ? one : many}`;
  const pinnedNotes = notes.filter((n) => n.pinned && !n.archivedAt);

  const base = `/companies/${id}`;
  const sections: SectionItem[] = [
    { key: "overview", label: "Overview", href: base },
    {
      key: "notes",
      label: "Notes",
      href: `${base}?tab=notes`,
      count: notes.filter((n) => !n.archivedAt).length,
    },
    {
      key: "contacts",
      label: "Contacts",
      href: `${base}?tab=contacts`,
      count: company.contacts.length,
    },
    {
      key: "sites",
      label: "Sites",
      href: `${base}?tab=sites`,
      count: company.sites.length,
    },
    {
      key: "opportunities",
      label: "Opportunities",
      href: `${base}?tab=opportunities`,
      count: openOpps.length,
    },
    {
      key: "proposals",
      label: "Proposals",
      href: `${base}?tab=proposals`,
      count: proposalList.total,
    },
    {
      key: "contracts",
      label: "Contracts",
      href: `${base}?tab=contracts`,
      count: activeContracts.length,
    },
    {
      key: "invoices",
      label: "Invoices",
      href: `${base}?tab=invoices`,
      count: finance?.count,
    },
    {
      key: "devices",
      label: "Devices",
      href: `${base}?tab=devices`,
      count: devices?.totals.active,
    },
    {
      key: "hosting",
      label: "Hosting",
      href: `${base}?tab=hosting`,
      count: hostingCount,
    },
    {
      key: "tasks",
      label: "Tasks",
      href: `${base}?tab=tasks`,
      count: openTasks,
    },
    ...(vaultCaps.list
      ? [
          {
            key: "vault",
            label: "Secure Vault",
            href: `${base}?tab=vault`,
            count: vaultActive,
          },
        ]
      : []),
    { key: "activity", label: "Activity", href: `${base}?tab=activity` },
  ];
  const tab = sections.some((x) => x.key === sp.tab)
    ? (sp.tab as string)
    : "overview";

  const Row = ({
    label,
    children,
  }: {
    label: string;
    children: React.ReactNode;
  }) => (
    <div className="grid grid-cols-[110px_1fr] gap-x-3 py-1 text-[13px]">
      <dt className="text-slate-500">{label}</dt>
      <dd className="min-w-0 break-words text-slate-800">
        {children ?? <span className="text-slate-400">—</span>}
      </dd>
    </div>
  );

  return (
    <>
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1 py-2 text-xs text-slate-500"
      >
        <Link href="/companies" className="hover:text-slate-800">
          Companies
        </Link>
        <span aria-hidden>/</span>
        <span className="truncate text-slate-700">{company.name}</span>
      </nav>

      <header className="mb-3 px-1 py-2">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <span
              className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-md bg-brand-100 text-sm font-semibold text-brand-800"
              aria-hidden
            >
              {initials(company.name)}
            </span>
            <div className="min-w-0">
              <h1 className="[overflow-wrap:anywhere] text-[22px] font-semibold leading-7 tracking-tight text-slate-900">
                {company.name}
              </h1>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-slate-600">
                {company.email ? (
                  <a
                    href={`mailto:${company.email}`}
                    className="inline-flex min-w-0 items-center gap-1 truncate hover:text-brand-700"
                  >
                    <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden />{" "}
                    <span className="truncate">{company.email}</span>
                  </a>
                ) : (
                  <span className="text-slate-400">No email</span>
                )}
                <Badge tone={STATUS_TONES[company.status]}>
                  {company.status}
                </Badge>
                {company.tags.map((t) => (
                  <Badge key={t.id} tone={t.color}>
                    {t.name}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
          {canWrite && (
            <div className="flex shrink-0 items-center gap-2">
              <ButtonLink
                href={`/companies/${id}/edit`}
                variant="secondary"
                size="sm"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
              </ButtonLink>
              <CompanyHeaderMenu
                companyId={id}
                archived={Boolean(company.archivedAt)}
                canArchive={can(me.role, "company.delete")}
              />
            </div>
          )}
        </div>
        <dl className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-500">
          <div className="flex gap-1.5">
            <dt>Owner</dt>
            <dd className="text-slate-700">
              {company.ownerName ?? "Unassigned"}
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt>Created</dt>
            <dd className="text-slate-700">
              {fmtDate(company.createdAt, settings)}
            </dd>
          </div>
          {company.website && (
            <div className="flex gap-1.5">
              <dt className="sr-only">Website</dt>
              <dd>
                <a
                  href={
                    company.website.startsWith("http")
                      ? company.website
                      : `https://${company.website}`
                  }
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-slate-700 hover:text-brand-700"
                >
                  <Globe className="h-3 w-3" aria-hidden />{" "}
                  {company.domain ?? company.website}
                </a>
              </dd>
            </div>
          )}
          {company.phone && (
            <div className="flex gap-1.5">
              <dt className="sr-only">Phone</dt>
              <dd>
                <a
                  href={`tel:${company.phone}`}
                  className="inline-flex items-center gap-1 text-slate-700 hover:text-brand-700"
                >
                  <Phone className="h-3 w-3" aria-hidden /> {company.phone}
                </a>
              </dd>
            </div>
          )}
        </dl>
      </header>
      {company.archivedAt && (
        <Alert tone="warn" className="mb-3">
          This company was archived on {fmtDate(company.archivedAt, settings)}.
        </Alert>
      )}

      <SectionNav items={sections} active={tab} ariaLabel="Company sections" />

      <div className="mt-4">
        {tab === "overview" && (
          <section aria-labelledby="overview-heading">
            <h2
              id="overview-heading"
              className="mb-2 text-sm font-semibold text-slate-800"
            >
              Overview
            </h2>
            <div className="grid divide-y divide-slate-200 rounded-md border border-slate-200 bg-white md:grid-cols-3 md:divide-x md:divide-y-0">
              <div className="px-4 py-3">
                <h3 className="mb-1 text-xs font-medium text-slate-500">
                  Company information
                </h3>
                <dl>
                  <Row label="Industry">{company.industry}</Row>
                  <Row label="Company number">{company.companyNumber}</Row>
                  <Row label="VAT number">{company.vatNumber}</Row>
                  {defs.map((d) => {
                    const v = company.customFields?.[d.key];
                    return (
                      <Row key={d.id} label={d.label}>
                        {v === null || v === undefined || v === ""
                          ? null
                          : typeof v === "boolean"
                            ? v
                              ? "Yes"
                              : "No"
                            : String(v)}
                      </Row>
                    );
                  })}
                </dl>
              </div>
              <div className="px-4 py-3">
                <h3 className="mb-1 text-xs font-medium text-slate-500">
                  Billing address
                </h3>
                {addressLines.length ? (
                  <address className="whitespace-pre-line text-[13px] not-italic leading-6 text-slate-800">
                    {addressLines.join("\n")}
                  </address>
                ) : (
                  <p className="py-1 text-[13px] text-slate-400">—</p>
                )}
              </div>
              <div className="px-4 py-3">
                <h3 className="mb-1 text-xs font-medium text-slate-500">
                  Linked services
                </h3>
                <dl>
                  <Row label="Hosting · 20i">
                    {hosting ? (
                      <span className="flex flex-col">
                        {[...hosting.packages, ...hosting.looseDomains]
                          .slice(0, 3)
                          .map((h) => (
                            <Link
                              key={h.id}
                              href={`${base}?tab=hosting`}
                              className="[overflow-wrap:anywhere] text-brand-700 hover:underline"
                              title={HOSTING_KIND_LABEL[h.kind]}
                            >
                              {h.name}
                            </Link>
                          ))}
                        {hostingCount > 3 && (
                          <Link
                            href={`${base}?tab=hosting`}
                            className="text-xs text-slate-500 hover:underline"
                          >
                            and {hostingCount - 3} more
                          </Link>
                        )}
                      </span>
                    ) : null}
                  </Row>
                  <Row label="Devices">
                    {devices ? (
                      <Link
                        href={`${base}?tab=devices`}
                        className="text-brand-700 hover:underline"
                      >
                        {plural(devices.totals.active, "device")}
                        <span className="text-slate-500"> · NinjaOne</span>
                      </Link>
                    ) : null}
                  </Row>
                  <Row label="Invoices">
                    {finance?.link ? (
                      <Link
                        href={`${base}?tab=invoices`}
                        className="text-brand-700 hover:underline"
                      >
                        {plural(finance.count, "invoice")}
                        <span className="text-slate-500"> · Xero</span>
                      </Link>
                    ) : null}
                  </Row>
                  {vaultCaps.list && (
                    <Row label="Secure Vault">
                      {vaultActive > 0 ? (
                        <Link
                          href={`${base}?tab=vault`}
                          className="text-brand-700 hover:underline"
                        >
                          {plural(vaultActive, "item")}
                        </Link>
                      ) : null}
                    </Row>
                  )}
                </dl>
              </div>
            </div>
            {pinnedNotes.length > 0 && (
              <div className="mt-3 space-y-3">
                {pinnedNotes.map((n) => (
                  <div
                    key={n.id}
                    className="rounded-md border border-slate-200 bg-white px-4 py-3"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <h3 className="text-xs font-medium text-slate-500">
                        {n.title}
                      </h3>
                      <Link
                        href={`${base}?tab=notes`}
                        className="text-[11px] text-slate-500 hover:underline"
                      >
                        pinned note
                      </Link>
                    </div>
                    <MarkdownLite text={n.body} />
                  </div>
                ))}
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-slate-500">
              <span>
                {plural(company.contacts.length, "contact")} ·{" "}
                {plural(company.sites.length, "site")} ·{" "}
                {plural(companyTasks.rows.length, "task")}
                {companyTasks.rows.length > 0 && ` (${openTasks} open)`}
              </span>
              <Link
                href={`${base}?tab=activity`}
                className="inline-flex items-center gap-1 text-brand-700 hover:underline"
              >
                View activity <ArrowRight className="h-3 w-3" aria-hidden />
              </Link>
            </div>
          </section>
        )}

        {tab === "notes" && (
          <NotesPanel
            companyId={id}
            notes={notes.map((n) => ({
              id: n.id,
              title: n.title,
              body: n.body,
              pinned: n.pinned,
              archivedAt: n.archivedAt ? n.archivedAt.toISOString() : null,
              updatedAt: fmtRelative(n.updatedAt),
              updatedByName: n.updatedByName,
            }))}
            canWrite={canWrite}
            showArchived={sp.archived === "1"}
          />
        )}

        {tab === "activity" && (
          <ActivityPanel
            companyId={id}
            items={timeline.map((t) => ({
              ...t,
              at: fmtDateTime(t.at, settings),
            }))}
            contacts={company.contacts.map((c) => ({
              id: c.id,
              name: fullName(c),
            }))}
            canWrite={canWrite}
          />
        )}

        {tab === "contacts" && (
          <>
            <Card
              title="Contacts"
              padded={false}
              actions={
                can(me.role, "contact.write") && (
                  <ButtonLink href={`/contacts/new?companyId=${id}`} size="sm">
                    <Plus className="h-4 w-4" /> Add contact
                  </ButtonLink>
                )
              }
            >
              {company.contacts.length === 0 ? (
                <div className="p-4">
                  <EmptyState
                    title="No contacts yet"
                    description="Add the decision maker, technical and billing contacts."
                  />
                </div>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Roles</th>
                      <th>Email</th>
                      <th>Phone</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {company.contacts.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <Link
                            href={`/contacts/${c.id}`}
                            className="font-medium text-brand-700 hover:underline"
                          >
                            {fullName(c)}
                          </Link>
                          {c.isPrimary && (
                            <Badge className="ml-1" tone="green">
                              primary
                            </Badge>
                          )}
                          {c.jobTitle && (
                            <div className="text-xs text-slate-500">
                              {c.jobTitle}
                            </div>
                          )}
                        </td>
                        <td>
                          <div className="flex flex-wrap gap-1">
                            {c.roles.map((r) => (
                              <Badge key={r}>{ROLE_LABELS_CONTACT[r]}</Badge>
                            ))}
                          </div>
                        </td>
                        <td>
                          {c.email ? (
                            <a
                              href={`mailto:${c.email}`}
                              className="hover:underline"
                            >
                              {c.email}
                            </a>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>{c.mobile ?? c.phone ?? "—"}</td>
                        <td className="text-right">
                          {can(me.role, "contact.delete") && (
                            <ConfirmButton
                              variant="ghost"
                              size="sm"
                              action={archiveContactAction.bind(null, c.id, id)}
                              title={`Archive ${fullName(c)}?`}
                              confirmLabel="Archive"
                            >
                              Archive
                            </ConfirmButton>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </>
        )}

        {tab === "sites" && (
          <>
            <Card
              title="Sites"
              padded={false}
              actions={canWrite && <SiteDialog companyId={id} />}
            >
              {company.sites.length === 0 ? (
                <div className="p-4">
                  <EmptyState
                    title="No sites yet"
                    description="Sites are physical locations. NinjaOne locations are mapped to sites in Phase 5."
                  />
                </div>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Site</th>
                      <th>Address</th>
                      <th>Phone</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {company.sites.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <span className="font-medium">{s.name}</span>
                          {s.isPrimary && (
                            <Badge className="ml-1" tone="green">
                              primary
                            </Badge>
                          )}
                        </td>
                        <td className="text-slate-600">
                          {[s.addressLine1, s.city, s.postcode]
                            .filter(Boolean)
                            .join(", ") || "—"}
                        </td>
                        <td>{s.phone ?? "—"}</td>
                        <td className="text-right">
                          {canWrite && (
                            <span className="inline-flex items-center gap-1">
                              <SiteDialog companyId={id} site={s} />
                              <ConfirmButton
                                variant="ghost"
                                size="sm"
                                action={archiveSiteAction.bind(null, s.id, id)}
                                title={`Archive site ${s.name}?`}
                                confirmLabel="Archive"
                              >
                                Archive
                              </ConfirmButton>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </>
        )}

        {tab === "opportunities" && (
          <>
            <Card
              title="Opportunities"
              padded={false}
              actions={
                can(me.role, "opportunity.write") && (
                  <ButtonLink href={`/pipeline/new?companyId=${id}`} size="sm">
                    <Plus className="h-4 w-4" /> New opportunity
                  </ButtonLink>
                )
              }
            >
              {opportunities.length === 0 ? (
                <div className="p-4">
                  <EmptyState title="No opportunities yet" />
                </div>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Opportunity</th>
                      <th>Stage</th>
                      <th className="text-right">First-year value</th>
                      <th className="text-right">MRR</th>
                      <th>Expected close</th>
                      <th>Owner</th>
                    </tr>
                  </thead>
                  <tbody>
                    {opportunities.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <Link
                            href={`/pipeline/${o.id}`}
                            className="font-medium text-brand-700 hover:underline"
                          >
                            {o.title}
                          </Link>
                        </td>
                        <td>
                          <Badge
                            tone={
                              o.status === "won"
                                ? "green"
                                : o.status === "lost"
                                  ? "red"
                                  : o.stageColor
                            }
                          >
                            {o.status === "open" ? o.stageName : o.status}
                          </Badge>
                        </td>
                        <td className="text-right tabular-nums">
                          {fmtMoney(
                            o.summary.firstYearValue,
                            settings.currency,
                          )}
                        </td>
                        <td className="text-right tabular-nums">
                          {fmtMoney(o.summary.mrr, settings.currency)}
                        </td>
                        <td>{fmtDate(o.expectedCloseDate, settings)}</td>
                        <td>{o.ownerName ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </>
        )}

        {tab === "contracts" && (
          <>
            <Card
              title={`Contracts · MRR ${fmtMoney(mrr, settings.currency)}`}
              padded={false}
              actions={
                can(me.role, "contract.write") && (
                  <ButtonLink href={`/contracts/new?companyId=${id}`} size="sm">
                    <Plus className="h-4 w-4" /> New contract
                  </ButtonLink>
                )
              }
            >
              {companyContracts.length === 0 ? (
                <div className="p-4">
                  <EmptyState
                    title="No contracts yet"
                    description="Contracts are drafted automatically when an opportunity is won, or created here."
                  />
                </div>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Contract</th>
                      <th>Status</th>
                      <th>Value</th>
                      <th>Renewal</th>
                      <th>Next review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {companyContracts.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <Link
                            href={`/contracts/${c.id}`}
                            className="font-medium text-brand-700 hover:underline"
                          >
                            {c.name}
                          </Link>
                        </td>
                        <td>
                          <Badge
                            tone={
                              c.status === "active"
                                ? "green"
                                : c.status === "draft"
                                  ? "slate"
                                  : "amber"
                            }
                          >
                            {c.status}
                          </Badge>
                        </td>
                        <td>
                          <RevenueSummaryBadges
                            summary={c.summary}
                            currency={settings.currency}
                            compact
                          />
                        </td>
                        <td>{fmtDate(c.renewalDate, settings)}</td>
                        <td>{fmtDate(c.nextReviewDate, settings)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </>
        )}

        {tab === "tasks" && (
          <>
            <Card
              title="Tasks"
              padded={false}
              actions={
                can(me.role, "task.write") && (
                  <TaskDialog owners={owners} defaults={{ companyId: id }} />
                )
              }
            >
              <TaskList
                tasks={companyTasks.rows}
                canWrite={can(me.role, "task.write")}
                settings={settings}
                compact
              />
            </Card>
            {onboardingList.length > 0 && (
              <Card title="Onboarding" padded={false} className="mt-4">
                <ul className="divide-y divide-slate-100">
                  {onboardingList.map((o) => (
                    <li
                      key={o.id}
                      className="flex items-center justify-between px-4 py-2 text-sm"
                    >
                      <Link
                        href={`/tasks/onboarding/${o.id}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {o.name}
                      </Link>
                      <span className="text-xs text-slate-500">
                        {o.done}/{o.total} ·{" "}
                        <Badge
                          tone={o.status === "completed" ? "green" : "blue"}
                        >
                          {o.status.replace("_", " ")}
                        </Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        )}

        {tab === "proposals" && (
          <>
            <Card title="Proposals" padded={false}>
              {proposalList.rows.length === 0 ? (
                <div className="p-4">
                  <EmptyState
                    title="No proposals"
                    description="Create one from an opportunity, or link an existing Better Proposals document on the Proposals page."
                  />
                </div>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Proposal</th>
                      <th>Status</th>
                      <th>Opportunity</th>
                      <th>Sent</th>
                      <th>Signed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proposalList.rows.map((p) => (
                      <tr key={p.id}>
                        <td>
                          {p.subjectLine ?? `Proposal ${p.externalId}`}
                          {p.viewUrl && (
                            <a
                              href={p.viewUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="ml-1 inline-flex align-middle text-slate-400 hover:text-brand-700"
                              aria-label="Open in Better Proposals"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          )}
                        </td>
                        <td>
                          <Badge
                            tone={
                              p.status === "signed" || p.status === "paid"
                                ? "green"
                                : p.status === "opened"
                                  ? "indigo"
                                  : p.status === "sent"
                                    ? "blue"
                                    : "slate"
                            }
                          >
                            {p.status}
                          </Badge>
                        </td>
                        <td>
                          {p.opportunityId ? (
                            <Link
                              href={`/pipeline/${p.opportunityId}`}
                              className="hover:underline"
                            >
                              {p.opportunityTitle}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>{fmtDate(p.sentAt, settings)}</td>
                        <td>{fmtDate(p.signedAt, settings)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </>
        )}

        {tab === "invoices" && (
          <>
            {!finance ? (
              <EmptyState
                title="Finance data is restricted"
                description="Only finance users and administrators can see invoices."
              />
            ) : (
              <div className="space-y-4">
                <Card
                  title="Financial summary"
                  actions={
                    xero.demo ? (
                      <Badge tone="amber">demo</Badge>
                    ) : finance.link ? (
                      <Badge tone="green">linked to Xero</Badge>
                    ) : (
                      <Badge tone="amber">not linked to Xero</Badge>
                    )
                  }
                >
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-slate-500">
                        Outstanding
                      </div>
                      <div className="text-lg font-semibold">
                        {fmtMoney(
                          finance.xeroContact?.outstanding ??
                            finance.outstanding,
                          settings.currency,
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {finance.xeroContact
                          ? `Xero balance · fetched ${fmtRelative(finance.xeroContact.fetchedAt)}`
                          : "from mirrored invoices"}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-wide text-slate-500">
                        Overdue
                      </div>
                      <div
                        className={`text-lg font-semibold ${Number(finance.xeroContact?.overdue ?? finance.overdue) > 0 ? "text-red-700" : ""}`}
                      >
                        {fmtMoney(
                          finance.xeroContact?.overdue ?? finance.overdue,
                          settings.currency,
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-wide text-slate-500">
                        Invoiced (12 months)
                      </div>
                      <div className="text-lg font-semibold">
                        {fmtMoney(finance.invoiced12m, settings.currency)}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-wide text-slate-500">
                        Paid (12 months)
                      </div>
                      <div className="text-lg font-semibold text-green-700">
                        {fmtMoney(finance.paid12m, settings.currency)}
                      </div>
                    </div>
                  </div>
                  {!finance.link && (
                    <p className="mt-3 text-xs text-amber-700">
                      Link this company to its Xero contact on Integrations →
                      Xero to see its invoices and create drafts.
                    </p>
                  )}
                </Card>
                {finance.drafts.length > 0 && (
                  <Card title="Draft invoices awaiting approval" padded={false}>
                    <ul className="divide-y divide-slate-100 text-sm">
                      {finance.drafts.map((d) => (
                        <li
                          key={d.id}
                          className="flex items-center justify-between px-4 py-2"
                        >
                          <Link
                            href={`/finance/drafts/${d.id}`}
                            className="text-brand-700 hover:underline"
                          >
                            {d.reference} · {d.description ?? "draft"}
                          </Link>
                          <span className="text-xs text-slate-500">
                            {fmtMoney(d.subTotal, d.currencyCode)} net ·{" "}
                            <Badge
                              tone={d.status === "failed" ? "red" : "slate"}
                            >
                              {d.status}
                            </Badge>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
                <Card title="Invoices (from Xero)" padded={false}>
                  {finance.invoices.length === 0 ? (
                    <div className="p-4">
                      <EmptyState
                        title="No invoices"
                        description={
                          finance.link
                            ? "None mirrored yet; run a Xero sync."
                            : "Link the company to a Xero contact first."
                        }
                      />
                    </div>
                  ) : (
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>Invoice</th>
                          <th>Status</th>
                          <th>Date</th>
                          <th>Due</th>
                          <th className="text-right">Total</th>
                          <th className="text-right">Amount due</th>
                        </tr>
                      </thead>
                      <tbody>
                        {finance.invoices.map((i) => {
                          const overdue =
                            i.status === "AUTHORISED" &&
                            i.dueDate &&
                            i.dueDate < new Date().toISOString().slice(0, 10);
                          return (
                            <tr key={i.id}>
                              <td className="font-medium">
                                {i.invoiceNumber ?? i.invoiceId.slice(0, 8)}
                                {i.reference ? (
                                  <span className="ml-1 text-xs font-normal text-slate-500">
                                    {i.reference}
                                  </span>
                                ) : null}
                              </td>
                              <td>
                                <Badge
                                  tone={
                                    overdue
                                      ? "red"
                                      : i.status === "PAID"
                                        ? "green"
                                        : i.status === "AUTHORISED"
                                          ? "indigo"
                                          : "slate"
                                  }
                                >
                                  {overdue ? "overdue" : i.status.toLowerCase()}
                                </Badge>
                              </td>
                              <td>{fmtDate(i.date, settings)}</td>
                              <td className={overdue ? "text-red-600" : ""}>
                                {fmtDate(i.dueDate, settings)}
                              </td>
                              <td className="text-right tabular-nums">
                                {fmtMoney(
                                  i.total,
                                  i.currencyCode ?? settings.currency,
                                )}
                              </td>
                              <td className="text-right tabular-nums font-medium">
                                {fmtMoney(
                                  i.amountDue,
                                  i.currencyCode ?? settings.currency,
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </Card>
              </div>
            )}
          </>
        )}

        {tab === "devices" && (
          <>
            {!devices ? (
              <EmptyState
                title="Not linked to a NinjaOne organisation"
                description="Link this company on Integrations → NinjaOne to see its managed devices and compare them with the contract."
                action={
                  can(me.role, "integration.manage") ? (
                    <ButtonLink
                      href="/integrations/ninjaone"
                      variant="secondary"
                    >
                      Open NinjaOne mapping
                    </ButtonLink>
                  ) : undefined
                }
              />
            ) : (
              <div className="space-y-4">
                <Card
                  title={`Devices · ${devices.org?.name ?? devices.link.externalName ?? "NinjaOne organisation"}`}
                  actions={
                    <span className="flex items-center gap-2">
                      {devices.mode === "demo" && (
                        <Badge tone="amber">demo</Badge>
                      )}
                      <Badge tone={FRESHNESS_TONE[devices.totals.freshness]}>
                        {FRESHNESS_LABEL[devices.totals.freshness]}
                      </Badge>
                      {devices.consoleUrl && (
                        <a
                          href={devices.consoleUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline"
                        >
                          Open in NinjaOne <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </span>
                  }
                >
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                    {[
                      ["Total", devices.totals.total],
                      [
                        `Active (${devices.totals.activeDays}d)`,
                        devices.totals.active,
                      ],
                      ["Billable class", devices.totals.billable],
                      ["Servers", devices.totals.servers],
                      ["Needs attention", devices.totals.needsAttention],
                    ].map(([label, value]) => (
                      <div key={String(label)}>
                        <div className="text-xs uppercase tracking-wide text-slate-500">
                          {label}
                        </div>
                        <div className="text-lg font-semibold">{value}</div>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] text-slate-500">
                    {devices.totals.lastFetched
                      ? `Fetched ${fmtRelative(new Date(devices.totals.lastFetched))}`
                      : "Not fetched yet"}{" "}
                    · read-only mirror of NinjaOne
                  </p>
                </Card>
                {devices.discrepancies.length > 0 && (
                  <Card title="Contract vs observed" padded={false}>
                    <DiscrepancyTable
                      rows={devices.discrepancies}
                      canReview={can(me.role, "discrepancy.review")}
                      currency={settings.currency}
                      compact
                    />
                  </Card>
                )}
                <Card padded={false}>
                  <DeviceTable rows={devices.devices} showCompany={false} />
                </Card>
              </div>
            )}
          </>
        )}
        {tab === "hosting" && (
          <>
            <HostingPanel
              overview={hosting}
              canEdit={can(me.role, "contract.write")}
              canManageIntegrations={can(me.role, "integration.manage")}
              settings={settings}
              companyId={id}
            />
          </>
        )}
        {tab === "vault" && vaultCaps.list && vault && (
          <VaultPanel
            companyId={id}
            items={vault.items.map((i) => ({ ...i, tags: i.tags ?? [] }))}
            caps={vaultCaps}
            categories={vaultCategories.map((c) => ({
              id: c.id,
              name: c.name,
            }))}
            sites={company.sites.map((s) => ({ id: s.id, name: s.name }))}
            stepUpMinutes={settings.vaultStepUpMinutes}
            configured={vaultConfigured()}
            showArchived={sp.archived === "1"}
          />
        )}
      </div>
    </>
  );
}
